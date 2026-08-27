# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- Despite the README's "Node — not available in the environment this skeleton was authored in" note, Node/npm are available in normal dev/agent environments: run `npm install` at repo root (npm workspaces), then `npm run dev:backend` / `npm run dev:frontend`.
- Frontend test runner is Vitest (`npm run test --workspace frontend`), colocated `*.test.ts` files next to the module under test. No test tooling existed before this was added — Vitest was picked as the natural fit for the existing Vite + React setup; there is still no backend test setup.
- `npm run build --workspace backend` currently fails with pre-existing TS2554 errors in `backend/src/routes/logs.ts` and `backend/src/routes/promote.ts` (arity mismatches on stub client calls), present since the initial skeleton commit. Not caused by frontend-only changes — `tsx watch` (the dev script) doesn't type-check, so `npm run dev:backend` still runs fine despite this.
- No Chromium/Puppeteer binary is available in at least some agent worktrees (no `~/.cache/puppeteer`, no system Chrome) — `chrome-devtools-axi open`/`newpage` fails with "No page is currently selected" even after `start` reports ready. Treat as an environment limitation, not a bug in the page under test.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
