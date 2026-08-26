import { Router } from "express";
import { StubGitlabClient } from "../clients/gitlabClient.js";

const gitlab = new StubGitlabClient();

export const testsRouter = Router();

// GET /api/tests — list test case definitions (from repo, once linked)
testsRouter.get("/", (_req, res) => {
  res.status(501).json({
    error: "Not implemented — chatbot repo not linked yet.",
    stage: "1. Read-only test results view over existing GitLab artifacts",
  });
});

// GET /api/tests/:id/results?pipelineId=... — per-test result incl. flake rate
testsRouter.get("/:id/results", (_req, res) => {
  res.status(501).json({ error: "Not implemented — depends on gitlabClient." });
});

// POST /api/tests/run — trigger a run via GitLab API (build order stage 2)
testsRouter.post("/run", async (req, res) => {
  try {
    const testIds: string[] = req.body?.testIds ?? [];
    const status = await gitlab.triggerTestRun(testIds);
    res.json(status);
  } catch (err) {
    res.status(501).json({ error: (err as Error).message });
  }
});
