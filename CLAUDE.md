# testing-dashboard — working notes

Read `PLAN.md` first (what and why), then `CONTRACT.md` (what the platform needs).
**On the Linux desktop, start with `PLAN.md` § TODO** — the open work and the questions to ask Ben.
`CHATBOT-WORK-ORDER.md` is for a session in the chatbot repo, not this one.

Ben's standing rules apply (in `hr-server/CLAUDE.md` on the desktop, `src/tools/CLAUDE.md` on
the laptop): plan first and wait for go; never commit without asking; no Claude attribution.

## Layout

`src/tdash/`: `app.py` (routes, identity, lifespan) · `runner.py` (the run worker) ·
`judge.py` (prompt, parsing, OpenAI-compatible client) · `grading.py` (checks + outcome) ·
`stats.py` (overview, signals, audit) · `workbook.py` (import, export, roster CSV) ·
`store.py` (SQLite) · `chatbot.py` · `secrets.py` (FortiPAM) · `regions.py` · `static/`
(Preact + htm, vendored from JAT, no build; `app.js` is the whole UI). `make check` is
the gate.

## Things that will bite

- **Endpoints that start or cancel a run must be `async def`.** `Runner.start()` schedules an
  asyncio task; a sync endpoint runs in a worker thread with no event loop, and every run
  crashed that way once. Only the HTTP-level tests catch it.
- **The persona dropdown is a named range (`PersonaList`).** Excel saves a direct
  cross-sheet dropdown in an extension openpyxl drops on load; it vanished once.
- **Comments from current Excel are threaded comments.** openpyxl only sees a legacy copy
  wrapped in boilerplate; `workbook.comment_text()` unwraps it. Keep it when touching import.
- **Personas must be `test-` logins** — enforced at import, on cases and in the playground,
  and chatbot-side by W2 once `TEST_SERVICES` names the dashboard's token.
- **The judge reads untrusted text.** The answer under test is fenced and declared data;
  replies are validated strictly and retried once; a bad reply is `error`, never a pass.
- **The audit's LLM never computes a number.** `stats.audit()` drops any rewording that
  carries a number not in the code-computed finding.
- **An infrastructure failure is `error`, not `fail`.** Retried once; 401/403 aren't.
- **Saving an unchanged case is not an edit** — no version, nothing for an import to "undo".
  The same holds for personas.
- **The judge's settings fall back to the shared `llm_env` names** (`LLM__BASE_URL`, `LLM__MODEL`,
  `LLM__REQUEST_TIMEOUT`, `LLM__API_KEY`); a `JUDGE_*` value wins. `config.effective_env`.
- **The static cache key is computed at startup** (`?v=` from file mtimes). Edit
  `static/` with a server running and the browser keeps the old file: restart it.
- **Fonts are self-hosted** (`static/vendor/fonts`, OFL: Plus Jakarta Sans, Geist Mono). The
  front door's CSP allows fonts from `'self'` only; a Google Fonts link would silently fall back.

## Testing

`test/conftest.py` has in-process fakes that speak the real wire formats (the chatbot's
`/v1/query` and `/health`, an OpenAI-compatible judge). Tests read a **frozen copy** of the
seed, `test/fixtures/seed.xlsx`, and pin its counts. Never point them at
`test-set/hr-assist-test-set.xlsx`: Ben and HR edit that one, and only a loose "it still
imports" test reads it.
The suite itself never touches the real chatbot or judge; one end-to-end pass did (2026-10-12, `PLAN.md` § TODO).
