import type { PipelineStatus, TestRunResult } from "../types.js";

/**
 * All calls here are stubs. Real implementation needs:
 * - GITLAB_BASE_URL, GITLAB_PROJECT_ID
 * - a token scoped to trigger pipelines and read the Repository Files / Job
 *   Artifacts endpoints on the chatbot project
 * Not wired up until the chatbot repo is accessible.
 */
export interface GitlabClient {
  triggerTestRun(testIds: string[]): Promise<PipelineStatus>;
  getPipelineStatus(pipelineId: string): Promise<PipelineStatus>;
  getRunResults(pipelineId: string): Promise<TestRunResult[]>;
  openPromoteMergeRequest(args: {
    branchName: string;
    testCaseYaml: string;
    title: string;
    description: string;
  }): Promise<{ webUrl: string }>;
}

export class StubGitlabClient implements GitlabClient {
  async triggerTestRun(testIds: string[]): Promise<PipelineStatus> {
    throw new Error(
      `StubGitlabClient: cannot trigger a run for [${testIds.join(", ")}] — ` +
        "chatbot repo / GitLab project not configured yet."
    );
  }

  async getPipelineStatus(pipelineId: string): Promise<PipelineStatus> {
    throw new Error(
      `StubGitlabClient: cannot look up pipeline ${pipelineId} — not configured yet.`
    );
  }

  async getRunResults(pipelineId: string): Promise<TestRunResult[]> {
    throw new Error(
      `StubGitlabClient: cannot fetch artifacts for pipeline ${pipelineId} — not configured yet.`
    );
  }

  async openPromoteMergeRequest(): Promise<{ webUrl: string }> {
    throw new Error("StubGitlabClient: promote-to-test MR flow not configured yet.");
  }
}
