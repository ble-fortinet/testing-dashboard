# HR Chatbot Testing & Logging Dashboard

A read-only / trigger-only surface over the HR chatbot's existing test suite, CI, and
production log store. This app owns no data of its own.

Status: **skeleton — no real data source is wired up yet.** The chatbot repo this
dashboard depends on is not accessible yet, so every client in `backend/src/clients/`
is a stub returning fixture data marked `SAMPLE`. See `docs/open-questions.md` for the
assumptions baked into this skeleton and what needs confirming once repo access lands.

## Architecture constraints (non-negotiable, from the build prompt)

- Stateless. No database owned by this app.
- Test definitions live in the chatbot repo (`tests/cases/*.yaml` here is a stand-in
  until that repo is linked). Test *results* live in GitLab CI artifacts.
- Runs are triggered via the GitLab API and executed on GitLab runners — this app has
  no eval executor of its own.
- CI is the release gate. This dashboard surfaces GitLab pipeline status; it never
  computes its own pass/fail verdict.
- Auth is Entra SSO with on-behalf-of token passthrough to the log store — no service
  account reads. Gate app access by Entra group membership.
- Never persist a copy of production log data.

## Layout

```
frontend/   React + TypeScript SPA — Testing and Logging surfaces
backend/    Node/TypeScript BFF — Entra OBO auth, GitLab API client, log store client
tests/      Test case definitions (YAML) + JSON schema
docs/       Open questions / assumptions this skeleton makes
```

## Build order (per the prompt — ship each stage before starting the next)

1. Read-only test results view over existing GitLab artifacts
2. Trigger a run via the GitLab API
3. Log viewer
4. Continue-conversation
5. Promote-to-test with the scrub and MR flow

Nothing past stage 0 (skeleton) is fully implemented yet. The Logging page has a
click-to-draft UI for stage 5 (promote-to-test), still operating on sample fixture rows
and wired to the stub GitLab client; its scrub step (`POST /api/promote/scrub`) remains
a 501 stub and is skipped in that flow.

## Running locally

Not yet runnable end-to-end — `backend/src/clients/*` are stubs. Once dependencies are
installed (`npm install` at repo root, requires Node — not available in the environment
this skeleton was authored in, so it hasn't been installed/built here):

```
npm run dev --workspace backend
npm run dev --workspace frontend
```
