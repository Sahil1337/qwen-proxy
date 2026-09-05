# CLAUDE.md

Read `AGENTS.md` first. It describes the architecture and conventions for
this repository and is the authoritative guide for any agent working here.

Quick reminders:

- `bun run typecheck` must stay clean.
- Keep the code minimal. This is a proxy, not a framework.
- Routes are thin; logic lives in `src/core/`.
- Runtime is [Bun](https://bun.sh), not Node — use `bun run <script>`.
