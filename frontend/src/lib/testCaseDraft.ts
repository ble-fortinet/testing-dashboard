/**
 * Turns a Log Stream row into an editable draft matching
 * tests/schema/test-case.schema.json (see tests/cases/example-001.yaml).
 * Pure, framework-free logic so it's cheap to unit test — the promote panel
 * component just wires this up to form state and the /api/promote/submit call.
 */
export type Severity = "blocker" | "major" | "minor";

export interface DraftPersona {
  work_location: string;
  legal_entity: string;
  notes: string;
}

export interface DraftExpected {
  key_facts: string[];
  must_escalate: boolean;
  must_cite: boolean;
}

export interface DraftTestCase {
  id: string;
  category: string;
  severity: Severity;
  input: string;
  persona: DraftPersona;
  expected: DraftExpected;
  deterministic_assertions: string[];
}

/** Real IDs are assigned when a case is actually merged — this is a placeholder. */
export const PLACEHOLDER_TEST_CASE_ID = "TC-0000";

export interface LogRowLike {
  query: string;
}

/**
 * Only `input` is populated from the row — category/severity/persona/expected
 * have no reliable signal in a sample log row, so they're left blank for the
 * human reviewer to fill in rather than guessed at.
 */
export function draftTestCaseFromLogRow(row: LogRowLike): DraftTestCase {
  return {
    id: PLACEHOLDER_TEST_CASE_ID,
    category: "",
    severity: "minor",
    input: row.query,
    persona: { work_location: "", legal_entity: "", notes: "" },
    expected: { key_facts: [""], must_escalate: false, must_cite: false },
    deterministic_assertions: [],
  };
}

const TEST_CASE_ID_PATTERN = /^TC-[0-9]{4}$/;

/** Mirrors the schema's `required` fields plus the id pattern. */
export function validateDraftTestCase(testCase: DraftTestCase): string[] {
  const errors: string[] = [];
  if (!TEST_CASE_ID_PATTERN.test(testCase.id)) {
    errors.push("id must match TC-#### — assign the real ID before submitting.");
  }
  if (!testCase.category.trim()) errors.push("category is required.");
  if (!testCase.input.trim()) errors.push("input is required.");
  if (!testCase.persona.work_location.trim()) {
    errors.push("persona.work_location is required.");
  }
  if (!testCase.persona.legal_entity.trim()) {
    errors.push("persona.legal_entity is required.");
  }
  if (testCase.expected.key_facts.every((fact) => !fact.trim())) {
    errors.push("expected.key_facts needs at least one fact.");
  }
  return errors;
}

function needsYamlQuoting(value: string): boolean {
  if (value === "") return true;
  if (/^\s|\s$/.test(value)) return true;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(value)) return true;
  if (/: |:$/.test(value)) return true;
  if (/ #/.test(value)) return true;
  if (/\n/.test(value)) return true;
  if (/^(true|false|null|~|yes|no)$/i.test(value)) return true;
  if (/^-?\d/.test(value)) return true;
  return false;
}

function quoteYamlScalar(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function bareYamlScalar(value: string): string {
  return needsYamlQuoting(value) ? quoteYamlScalar(value) : value;
}

/**
 * Hand-rolled rather than a library: the shape is small and fixed (matches
 * the schema exactly), and this stays a zero-dependency skeleton until a
 * real YAML need shows up.
 */
export function testCaseToYaml(testCase: DraftTestCase): string {
  const lines: string[] = [];
  lines.push(`id: ${bareYamlScalar(testCase.id)}`);
  lines.push(`category: ${bareYamlScalar(testCase.category)}`);
  lines.push(`severity: ${bareYamlScalar(testCase.severity)}`);
  lines.push(`input: ${quoteYamlScalar(testCase.input)}`);
  lines.push("persona:");
  lines.push(`  work_location: ${quoteYamlScalar(testCase.persona.work_location)}`);
  lines.push(`  legal_entity: ${quoteYamlScalar(testCase.persona.legal_entity)}`);
  if (testCase.persona.notes.trim()) {
    lines.push(`  notes: ${quoteYamlScalar(testCase.persona.notes)}`);
  }
  lines.push("expected:");
  const keyFacts = testCase.expected.key_facts.filter((fact) => fact.trim());
  if (keyFacts.length === 0) {
    lines.push("  key_facts: []");
  } else {
    lines.push("  key_facts:");
    for (const fact of keyFacts) {
      lines.push(`    - ${quoteYamlScalar(fact)}`);
    }
  }
  lines.push(`  must_escalate: ${testCase.expected.must_escalate}`);
  lines.push(`  must_cite: ${testCase.expected.must_cite}`);
  if (testCase.deterministic_assertions.length > 0) {
    lines.push("deterministic_assertions:");
    for (const assertion of testCase.deterministic_assertions) {
      lines.push(`  - ${assertion}`);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Body for POST /api/promote/submit. The description spells out that this
 * came from fixture data — see docs/open-questions.md — so a reviewer on
 * the GitLab side never mistakes it for a real production conversation.
 */
export function buildPromoteSubmitRequest(testCase: DraftTestCase) {
  return {
    testCaseYaml: testCaseToYaml(testCase),
    title: `Draft test case ${testCase.id}: ${testCase.category || "uncategorized"}`,
    description:
      "Drafted from a sample Log Stream row in the testing dashboard (fixture data, " +
      "not a real production conversation). Needs human review before merging.",
  };
}
