# CLAUDE.md

Read `AGENTS.md` first. It describes the architecture, conventions, and
testing rules for this repository and is the authoritative guide for any
agent working here.

Quick reminders:

- `bun test` must stay green and must not need a running Ollama.
- Keep the code minimal. This is a proxy, not a framework.
- Routes are thin; logic lives in `src/core/`.
- Runtime is [Bun](https://bun.sh), not Node — use `bun run <script>` / `bun test`.
