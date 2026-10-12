# Testing Dashboard — platform contract

What `hr-server`'s compose and nginx need. Why: `PLAN.md`, `CLAUDE.md`.

## Runtime

| | |
|---|---|
| Listens | `0.0.0.0:9230` |
| Published | nothing. Reached from its own network `hrtesting` only — members web, this, and the chatbot API — never `hrtools` or `hradmintools`: it holds a chatbot service token |
| Container | `testing-dash.hrai.docker` — nginx uses this name |
| Image | `hrai-testing-dash:latest` (`make image`; `TAG=` for a pinned one) |
| Deployed | nowhere yet. Compose and nginx for it are written in hr-server (`hrportal`, `hrassist`), uncommitted |
| Runs as | uid `10004` |
| Health | `GET /healthz` (outside `BASE_PATH`), no session, touches no file |
| Data | **its own volume** at `/data`, writable by uid 10004: `tdash.db` (SQLite, WAL) — the test set, its versions, runs and results. It reads no other tool's data and no portal `tool_data/` |
| Test roster | `TEST_ROSTER_PATH`, a mount of **only** `data/hrassist/roster/test/` (never the real roster beside it), writable by uid 10004, readable by the API (uid 999). Rewritten atomically, `0644`, on every persona change, import and restore, and at startup |

## Calls out

| To | | |
|---|---|---|
| The chatbot | `POST {CHATBOT_URL}/v1/query`, `GET {CHATBOT_URL}/health`, with `CHATBOT_URL=http://api.hrassist.docker:8000` — the API directly, as tachevu does, not through nginx | Bearer token with `role: service`. Every `sender` is a `test-` persona from the test set (enforced here; W2 enforces it chatbot-side) |
| The judge | `POST {JUDGE_URL}/chat/completions` | any OpenAI-compatible endpoint; `chat_template_kwargs.enable_thinking=false` unless `JUDGE_NO_THINK=0` |
| FortiPAM | at boot only, and only if a value is `SECRET:<KEY>` | the same protocol as hrai-report; any failure stops the boot |

## Routes (all under `BASE_PATH`, default `/tools/testing-dash`; every one re-checks `X-Auth-Role: admin`)

| Route | |
|---|---|
| `GET /` | the page; `GET /static/*` its assets (no data) |
| `GET /api/state` | who, what's configured, the active run, and the country → knowledge-base map the persona wizard previews with |
| `GET /api/cases` · `POST /api/cases` · `PUT/DELETE /api/cases/{id}` | the test set; every change writes a version |
| `GET /api/personas` · `POST /api/personas` · `PUT/DELETE /api/personas/{login}` | `test-` logins only; a login can't be renamed; delete refuses while a case asks as it or a persona reports to it. Every change writes a version |
| `GET /api/versions` · `POST /api/versions/{id}/rollback` | |
| `POST /api/import/preview` (multipart `file`, ≤ 10 MB) → `POST /api/import/apply {token}` | replace the whole set; the preview is the diff, single-use, 30 min, the uploader's own |
| `GET /api/export/test-set` | `.xlsx`, in-app edits and review markers included |
| `GET /api/export/test-roster.csv[?resolve_dates=true]` | the Personas sheet as the roster CSV the chatbot reads (W1) |
| `GET/POST /api/runs` · `GET /api/runs/{id}` · `GET /api/runs/{id}/results` · `POST /api/runs/{id}/cancel` | one run at a time; 409 while one is going. Results are never exported |
| `POST /api/cases/{id}/rerun` · `GET /api/runs/{id}/reruns` | re-run one case (a one-case run: no audit, never a regression baseline); a full run's page reads each case's newest partial run since, its outcome over every attempt |
| `POST /api/playground {persona, text, history}` | one chatbot turn as a test persona; `history` reaches the chatbot only when `CHATBOT_HISTORY` is on (W3) |

## Identity

The gate sends `X-Tool-Gate: admin`, so only role admin reaches it; every route re-checks
`X-Auth-Role`. Headers are percent-decoded. The session cookie is stripped by nginx.
`DEV_IDENTITY=user:role` is for the desktop only and refuses non-loopback peers.

## nginx — what its location needs

- `set $tool_gate admin;` then `include tool-gate.conf;`
- `client_max_body_size` of at least `10m` (imports)
- `proxy_read_timeout` of at least `160s`: the playground waits on a full chatbot turn

## Environment

| Var | Default | |
|---|---|---|
| `BASE_PATH` | `/tools/testing-dash` | empty = serve at `/` (desktop) |
| `DATA_DIR` | `/data` | the volume holding `tdash.db` |
| `CHATBOT_URL` | — | required to run; `http://api.hrassist.docker:8000` |
| `CHATBOT_TOKEN` | — | `role: service`; `SECRET:<KEY>` allowed |
| `CHATBOT_CA` | system trust | CA bundle path, for a self-signed front door |
| `CHATBOT_TIMEOUT` | `150` | seconds; above the chatbot's own 120 s LLM timeout |
| `CHATBOT_HISTORY` | `false` | set once work order W3 is deployed |
| `JUDGE_URL` · `JUDGE_MODEL` | — | required to run; unset = `LLM__BASE_URL` · `LLM__MODEL` |
| `JUDGE_API_KEY` | — | `SECRET:<KEY>` allowed; unset = `LLM__API_KEY` |
| `JUDGE_CA` · `JUDGE_TIMEOUT` · `JUDGE_NO_THINK` | system · `60` (unset = `LLM__REQUEST_TIMEOUT`) · `true` | the `LLM__*` names are the shared `llm_env` file's |
| `TEST_ROSTER_PATH` | — | where the test roster is written (W1); unset = not written, download it instead |
| `DEFAULT_THRESHOLD` | `0.75` | a case's blank threshold |
| `DEFAULT_CONCURRENCY` · `MAX_CONCURRENCY` | `4` · `16` | |
| `FORTIPAM_URL` · `FORTIPAM_TOKEN` · `FORTIPAM_SECRET_ID` · `FORTIPAM_CA` | itpam · — · — · system | only if a value is `SECRET:` |
| `DEV_IDENTITY` | unset | desktop only, loopback only |
| `GIT_COMMIT` | build arg | reported by `/healthz` |
