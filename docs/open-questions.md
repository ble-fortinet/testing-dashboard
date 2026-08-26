# Open questions and the defaults this skeleton assumes

Per the build prompt, these are the five answers that would most change this design.
Each default is what the skeleton is built against until corrected.

1. **Where does the chatbot repo live, and what's in its `.gitlab-ci.yml`?**
   Default: assume GitLab (not GitHub) for the chatbot's CI, standard REST v4 API,
   self-hosted instance with a configurable base URL (`GITLAB_BASE_URL` env var, not
   hardcoded to gitlab.com).

2. **What is the production log store (Elasticsearch, Azure Log Analytics, Splunk,
   a warehouse table, something else)?**
   Default: unknown, so `backend/src/clients/logStoreClient.ts` is a typed interface
   with one stub implementation. Swapping in the real store is a single-file change
   once the schema and query API are known.

3. **Are test definitions and prompts/retrieval config already versioned files in the
   chatbot repo, or generated/embedded in code?**
   Default: assume they're files this dashboard can read via the GitLab API (Repository
   Files endpoint) without needing write access except for the promote-to-test MR flow.

4. **What identifies an Entra group as "authorized" for this tool, and is there an
   existing app registration to reuse?**
   Default: a single `DASHBOARD_ENTRA_GROUP_ID` env var gates access; OBO token
   acquisition is stubbed in `backend/src/auth/entra.ts` pending an app registration.

5. **Where does this dashboard deploy, and does that host reach both the GitLab
   instance and the log store's network?**
   Default: containerized (a `Dockerfile` to add once the stack is confirmed), no
   specific host assumed yet — kept out of this skeleton to avoid guessing wrong.
