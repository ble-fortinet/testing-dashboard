export type Severity = "blocker" | "major" | "minor";

export interface TestCase {
  id: string;
  category: string;
  severity: Severity;
  input: string;
  persona: {
    work_location: string;
    legal_entity: string;
    notes?: string;
  };
  expected: {
    key_facts: string[];
    must_escalate?: boolean;
    must_cite?: boolean;
  };
  deterministic_assertions?: string[];
}

export interface DeterministicResult {
  assertion: string;
  passed: boolean;
}

export interface ReferenceComparisonResult {
  key_facts_present: Record<string, boolean>;
  numeric_values_exact: boolean;
}

export interface LlmJudgeResult {
  tone: number;
  completeness: number;
  appropriateness: number;
  advisory_note?: string;
}

export interface TestRunResult {
  testId: string;
  runAttempt: 1 | 2 | 3;
  actualOutput: string;
  resolvedRegion: string;
  retrievedChunks: { id: string; score: number }[];
  citations: string[];
  deterministic: DeterministicResult[];
  referenceComparison: ReferenceComparisonResult;
  llmJudge: LlmJudgeResult;
  durationMs: number;
  gitlabJobUrl: string;
}

export interface TestCaseFlakeSummary {
  testId: string;
  passCount: number;
  totalRuns: number;
  isFlaky: boolean;
}

export interface PipelineStatus {
  pipelineId: string;
  status: "pending" | "running" | "success" | "failed" | "canceled";
  webUrl: string;
}

export interface ConversationLogEntry {
  conversationId: string;
  timestamp: string;
  query: string;
  resolvedRegion: string;
  retrievedChunks: { id: string; score: number }[];
  answer: string;
  citations: string[];
  escalated: boolean;
  latencyMs: number;
  thumbsDown?: boolean;
}
