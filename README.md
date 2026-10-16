# Testing Dashboard

Runs the HR Assist test set against the chatbot and grades every answer. Admins only, at
`/tools/testing-dash/`. Why it's built this way: [`PLAN.md`](PLAN.md). What the platform
needs to run it: [`CONTRACT.md`](CONTRACT.md). Chatbot changes it depends on:
[`CHATBOT-WORK-ORDER.md`](CHATBOT-WORK-ORDER.md).

- **Test set** — import the workbook (the tests pin a frozen copy,
  `test/fixtures/seed.xlsx`), add and edit cases and personas in the app (step-by-step
  wizards), export it back with your edits. Every change is a version you can restore.
- **Runs** — every ready case is asked as its `test-` persona through `POST /v1/query`, then
  graded: deterministic checks (citations, region) plus an LLM judge marking each expected
  point covered, missing or contradicted. One run at a time, cancelable, results saved as they
  land.
- **Overview and audit** — pass rate, latency, score, by category, regressions against the
  previous run, and up to five computed findings.
- **Playground** — chat with the bot as any persona, with everything the chatbot knows about them in view.

## Desktop

    uv sync
    DEV_IDENTITY=ble:admin DATA_DIR=. BASE_PATH= \
      CHATBOT_URL=… CHATBOT_TOKEN=… JUDGE_URL=… JUDGE_MODEL=… \
      uv run uvicorn --factory tdash.app:create_app --reload --port 9230

Then `http://localhost:9230/`. `make check` is the gate: ruff, format, pytest.
