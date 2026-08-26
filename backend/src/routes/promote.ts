import { Router } from "express";
import { StubGitlabClient } from "../clients/gitlabClient.js";

const gitlab = new StubGitlabClient();

export const promoteRouter = Router();

/**
 * Build order stage 5 — the highest-hazard endpoint in this app.
 * A production conversation names an identified employee. This route must:
 *   1. run a scrub step (strip identity, generalize specifics)
 *   2. return the scrubbed diff for human review/edit — never auto-submit
 *   3. only then open a GitLab merge request against tests/cases/*.yaml
 * No dashboard-side storage of the conversation at any point.
 */
promoteRouter.post("/scrub", (_req, res) => {
  res.status(501).json({ error: "Not implemented — scrub step design pending." });
});

promoteRouter.post("/submit", async (req, res) => {
  try {
    const { testCaseYaml, title, description } = req.body ?? {};
    const mr = await gitlab.openPromoteMergeRequest({
      branchName: `promote-test-case/${Date.now()}`,
      testCaseYaml,
      title,
      description,
    });
    res.json(mr);
  } catch (err) {
    res.status(501).json({ error: (err as Error).message });
  }
});
