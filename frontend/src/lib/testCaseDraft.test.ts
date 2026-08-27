import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_TEST_CASE_ID,
  buildPromoteSubmitRequest,
  draftTestCaseFromLogRow,
  testCaseToYaml,
  validateDraftTestCase,
} from "./testCaseDraft.js";

describe("draftTestCaseFromLogRow", () => {
  it("carries the row's query into input and leaves everything else blank for review", () => {
    const draft = draftTestCaseFromLogRow({
      query: "How many paid sick days do I get in my first year?",
    });

    expect(draft.id).toBe(PLACEHOLDER_TEST_CASE_ID);
    expect(draft.input).toBe("How many paid sick days do I get in my first year?");
    expect(draft.category).toBe("");
    expect(draft.persona).toEqual({ work_location: "", legal_entity: "", notes: "" });
    expect(draft.expected.key_facts).toEqual([""]);
    expect(draft.expected.must_escalate).toBe(false);
    expect(draft.expected.must_cite).toBe(false);
  });
});

describe("validateDraftTestCase", () => {
  function validDraft() {
    return draftTestCaseFromLogRow({ query: "sample query" });
  }

  it("flags every unfilled required field on a fresh draft", () => {
    // The TC-0000 placeholder already matches the id pattern, so a fresh
    // draft is only missing the fields that have no signal in a log row.
    const errors = validateDraftTestCase(validDraft());
    expect(errors).toContain("category is required.");
    expect(errors).toContain("persona.work_location is required.");
    expect(errors).toContain("persona.legal_entity is required.");
    expect(errors).toContain("expected.key_facts needs at least one fact.");
  });

  it("passes once id, category, persona, and at least one key fact are filled in", () => {
    const draft = validDraft();
    draft.id = "TC-1234";
    draft.category = "leave";
    draft.persona.work_location = "Ontario office";
    draft.persona.legal_entity = "CA entity";
    draft.expected.key_facts = ["", "10 days accrued in year one"];

    expect(validateDraftTestCase(draft)).toEqual([]);
  });

  it("rejects malformed ids even when every other field is filled in", () => {
    const draft = validDraft();
    draft.id = "not-an-id";
    draft.category = "leave";
    draft.persona.work_location = "Ontario office";
    draft.persona.legal_entity = "CA entity";
    draft.expected.key_facts = ["10 days accrued in year one"];

    expect(validateDraftTestCase(draft)).toEqual([
      "id must match TC-#### — assign the real ID before submitting.",
    ]);
  });

  it("treats whitespace-only key facts as missing", () => {
    const draft = validDraft();
    draft.id = "TC-1234";
    draft.category = "leave";
    draft.persona.work_location = "Ontario office";
    draft.persona.legal_entity = "CA entity";
    draft.expected.key_facts = ["   ", ""];

    expect(validateDraftTestCase(draft)).toEqual([
      "expected.key_facts needs at least one fact.",
    ]);
  });
});

describe("testCaseToYaml", () => {
  it("renders a filled-in draft in the same shape as tests/cases/example-001.yaml", () => {
    const draft = draftTestCaseFromLogRow({
      query: "How many weeks of parental leave am I entitled to?",
    });
    draft.id = "TC-1234";
    draft.category = "leave";
    draft.severity = "blocker";
    draft.persona.work_location = "Quebec office code";
    draft.persona.legal_entity = "CA legal entity code";
    draft.persona.notes = "Quebec must resolve distinctly from rest-of-Canada.";
    draft.expected.key_facts = ["18 weeks combined leave"];
    draft.expected.must_cite = true;
    draft.deterministic_assertions = ["no_out_of_region_chunk", "citation_resolves"];

    expect(testCaseToYaml(draft)).toBe(
      [
        "id: TC-1234",
        "category: leave",
        "severity: blocker",
        'input: "How many weeks of parental leave am I entitled to?"',
        "persona:",
        '  work_location: "Quebec office code"',
        '  legal_entity: "CA legal entity code"',
        '  notes: "Quebec must resolve distinctly from rest-of-Canada."',
        "expected:",
        "  key_facts:",
        '    - "18 weeks combined leave"',
        "  must_escalate: false",
        "  must_cite: true",
        "deterministic_assertions:",
        "  - no_out_of_region_chunk",
        "  - citation_resolves",
        "",
      ].join("\n")
    );
  });

  it("quotes free-text values that would otherwise break YAML parsing", () => {
    const draft = draftTestCaseFromLogRow({ query: 'Say "hi": now' });
    draft.category = "edge-case";
    draft.persona.work_location = "loc";
    draft.persona.legal_entity = "entity";
    draft.expected.key_facts = ["fact"];

    const yaml = testCaseToYaml(draft);
    expect(yaml).toContain('input: "Say \\"hi\\": now"');
  });

  it("omits blank key facts and an empty notes field", () => {
    const draft = draftTestCaseFromLogRow({ query: "q" });
    draft.category = "leave";
    draft.persona.work_location = "loc";
    draft.persona.legal_entity = "entity";
    draft.expected.key_facts = ["", "  ", "real fact"];

    const yaml = testCaseToYaml(draft);
    expect(yaml).not.toContain("notes:");
    expect(yaml.match(/- /g)).toHaveLength(1);
    expect(yaml).toContain('- "real fact"');
  });
});

describe("buildPromoteSubmitRequest", () => {
  it("labels the submission as fixture-derived, matching the sample-data-only UI copy", () => {
    const draft = draftTestCaseFromLogRow({ query: "q" });
    draft.id = "TC-1234";
    draft.category = "leave";

    const request = buildPromoteSubmitRequest(draft);
    expect(request.title).toBe("Draft test case TC-1234: leave");
    expect(request.description).toContain("fixture data");
    expect(request.description).toContain("not a real production conversation");
    expect(request.testCaseYaml).toBe(testCaseToYaml(draft));
  });
});
