import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import type { Config } from '../config.js';
import type { OllamaClient } from './ollama.js';
import type { Logger } from '../util/logger.js';
import { baseOptions } from './mapping.js';

/**
 * Ollama gets only what it needs from the proxy's environment: the shell that
 * started the proxy may hold unrelated secrets, and a child process inherits
 * everything by default.
 */
const INHERITED_ENV =
  /^(PATH|HOME|USER|LOGNAME|LANG|LC_[A-Z]+|TZ|TMPDIR|LD_LIBRARY_PATH|DISPLAY|XDG_[A-Z_]+|HTTPS?_PROXY|NO_PROXY|https?_proxy|no_proxy|OLLAMA_[A-Z_]+|GGML_[A-Z_]+|VK_[A-Z_]+|CUDA_[A-Z_]+|HSA_[A-Z_]+|HIP_[A-Z_]+|ROCR_[A-Z_]+|GPU_[A-Z_]+)$/;

/**
 * Starts `ollama serve` as a child process with the inference tuning from the
 * proxy's own config, waits until it answers, restarts it if it dies, and
 * stops it on shutdown. If an Ollama is already listening on the configured
 * URL, the supervisor attaches to it instead (with a warning, because the
 * tuning cannot be applied to a server it did not start).
 */
export class OllamaSupervisor {
  private child: ChildProcess | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private stopping = false;
  private restarts = 0;
  private attachedExternal = false;

  constructor(
    private readonly config: Config,
    private readonly client: OllamaClient,
    private readonly log: Logger,
  ) {}

  get managedPid(): number | undefined {
    return this.child?.pid;
  }

  get external(): boolean {
    return this.attachedExternal;
  }

  async start(): Promise<void> {
    if (await this.reachable()) {
      this.attachedExternal = true;
      this.log.warn(
        { url: this.config.OLLAMA_BASE_URL },
        'an Ollama server is already running; attaching to it. NUM_CTX/KV cache/flash-attention/parallel settings are NOT applied to it',
      );
      return;
    }
    this.spawnChild();
    await this.waitUntilReachable();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.log.info({ pid: child.pid }, 'stopping ollama');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await once(child, 'exit').catch(() => undefined);
    clearTimeout(timer);
  }

  private childEnv(): NodeJS.ProcessEnv {
    const { hostname, port } = new URL(this.config.OLLAMA_BASE_URL);
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => INHERITED_ENV.test(name)));
    const env: NodeJS.ProcessEnv = {
      ...inherited,
      OLLAMA_HOST: `${hostname}:${port || '11434'}`,
      OLLAMA_CONTEXT_LENGTH: String(this.config.NUM_CTX),
      OLLAMA_NUM_PARALLEL: String(this.config.MAX_PARALLEL),
      OLLAMA_KV_CACHE_TYPE: this.config.KV_CACHE_TYPE,
      OLLAMA_FLASH_ATTENTION: this.config.FLASH_ATTENTION ? '1' : '0',
      OLLAMA_KEEP_ALIVE: this.config.KEEP_ALIVE,
    };
    if (this.config.OLLAMA_MODELS) env.OLLAMA_MODELS = this.config.OLLAMA_MODELS;
    return env;
  }

  private spawnChild(): void {
    if (this.stopping) return;
    const child = spawn(this.config.OLLAMA_BIN, ['serve'], {
      env: this.childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.log.info({ pid: child.pid, bin: this.config.OLLAMA_BIN }, 'started ollama serve');

    const forward = (stream: NodeJS.ReadableStream | null) => {
      stream?.on('data', (buf: Buffer) => {
        for (const line of buf.toString().split('\n')) {
          if (line.trim()) this.log.trace({ ollama: line }, 'ollama');
        }
      });
    };
    forward(child.stdout);
    forward(child.stderr);

    child.on('error', (err) => this.log.error({ err }, 'failed to start ollama'));
    child.on('exit', (code, signal) => {
      this.log[this.stopping ? 'info' : 'error']({ code, signal }, 'ollama exited');
      if (this.stopping) return;
      const delay = Math.min(30_000, 1000 * 2 ** this.restarts++);
      this.log.warn({ delayMs: delay }, 'restarting ollama');
      this.restartTimer = setTimeout(() => this.spawnChild(), delay);
      this.restartTimer.unref();
    });
  }

  private async reachable(): Promise<boolean> {
    try {
      await this.client.version(AbortSignal.timeout(1000));
      return true;
    } catch {
      return false;
    }
  }

  private async waitUntilReachable(): Promise<void> {
    const deadline = Date.now() + this.config.OLLAMA_START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
        throw new Error(`ollama serve exited with code ${this.child.exitCode} during startup`);
      }
      if (await this.reachable()) {
        this.restarts = 0;
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`ollama serve did not become reachable within ${this.config.OLLAMA_START_TIMEOUT_MS} ms`);
  }
}

/** Loads the model into memory with the same options every request uses, so the first real request is fast. */
export async function preloadModel(client: OllamaClient, config: Config, log: Logger): Promise<void> {
  const options = baseOptions(config);
  const started = Date.now();
  await client.preload(config.MODEL, options, config.KEEP_ALIVE);
  log.info({ model: config.MODEL, ms: Date.now() - started, options }, 'model preloaded');
}
