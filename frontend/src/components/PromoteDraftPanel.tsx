import { useMemo, useState } from "react";
import type { DraftTestCase, Severity } from "../lib/testCaseDraft.js";
import {
  buildPromoteSubmitRequest,
  draftTestCaseFromLogRow,
  testCaseToYaml,
  validateDraftTestCase,
} from "../lib/testCaseDraft.js";

const SEVERITIES: Severity[] = ["blocker", "major", "minor"];

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; webUrl: string }
  | { status: "error"; message: string };

export interface PromoteDraftPanelProps {
  row: { timestamp: string; query: string };
  onClose: () => void;
}

export function PromoteDraftPanel({ row, onClose }: PromoteDraftPanelProps) {
  const [draft, setDraft] = useState<DraftTestCase>(() => draftTestCaseFromLogRow(row));
  const [submitState, setSubmitState] = useState<SubmitState>({ status: "idle" });

  const errors = useMemo(() => validateDraftTestCase(draft), [draft]);
  const yaml = useMemo(() => testCaseToYaml(draft), [draft]);

  function updateDraft(patch: Partial<DraftTestCase>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function updatePersona(patch: Partial<DraftTestCase["persona"]>) {
    setDraft((prev) => ({ ...prev, persona: { ...prev.persona, ...patch } }));
  }

  function updateKeyFact(index: number, value: string) {
    setDraft((prev) => {
      const key_facts = [...prev.expected.key_facts];
      key_facts[index] = value;
      return { ...prev, expected: { ...prev.expected, key_facts } };
    });
  }

  function addKeyFact() {
    setDraft((prev) => ({
      ...prev,
      expected: { ...prev.expected, key_facts: [...prev.expected.key_facts, ""] },
    }));
  }

  function removeKeyFact(index: number) {
    setDraft((prev) => {
      const key_facts = prev.expected.key_facts.filter((_, i) => i !== index);
      return { ...prev, expected: { ...prev.expected, key_facts } };
    });
  }

  async function handleSubmit() {
    setSubmitState({ status: "submitting" });
    try {
      const response = await fetch("/api/promote/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPromoteSubmitRequest(draft)),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error ?? `Request failed with status ${response.status}`);
      }
      setSubmitState({ status: "success", webUrl: body.webUrl });
    } catch (err) {
      setSubmitState({ status: "error", message: (err as Error).message });
    }
  }

  const submitting = submitState.status === "submitting";

  return (
    <div className="ds-card promote-panel">
      <div className="ds-card-title table-card-title promote-panel-title">
        <span>
          Draft test case from log row{" "}
          <span className="mono-cell muted-cell">{row.timestamp}</span>
        </span>
        <button type="button" className="ds-btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="promote-panel-body">
        <div className="ds-banner-info promote-panel-note" role="status">
          Built from a sample Log Stream row — fixture data, not a real production
          conversation. The scrub/redaction step (<code>POST /api/promote/scrub</code>) isn't
          implemented yet, so this draft has not gone through any automated redaction —
          review every field yourself before submitting. Nothing is sent until you
          click Submit below.
        </div>

        <div className="promote-form">
          <label className="promote-field">
            <span className="promote-label">
              id <span className="promote-hint">placeholder pending real assignment</span>
            </span>
            <input
              className="promote-input mono-cell"
              value={draft.id}
              onChange={(e) => updateDraft({ id: e.target.value })}
            />
          </label>

          <label className="promote-field">
            <span className="promote-label">category</span>
            <input
              className="promote-input"
              placeholder="e.g. leave, benefits, pay, region-boundary, escalation"
              value={draft.category}
              onChange={(e) => updateDraft({ category: e.target.value })}
            />
          </label>

          <label className="promote-field">
            <span className="promote-label">severity</span>
            <select
              className="promote-input"
              value={draft.severity}
              onChange={(e) => updateDraft({ severity: e.target.value as Severity })}
            >
              {SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {severity}
                </option>
              ))}
            </select>
          </label>

          <label className="promote-field promote-field-wide">
            <span className="promote-label">input</span>
            <textarea
              className="promote-input"
              rows={2}
              value={draft.input}
              onChange={(e) => updateDraft({ input: e.target.value })}
            />
          </label>

          <label className="promote-field">
            <span className="promote-label">persona.work_location</span>
            <input
              className="promote-input"
              placeholder="e.g. Quebec office code"
              value={draft.persona.work_location}
              onChange={(e) => updatePersona({ work_location: e.target.value })}
            />
          </label>

          <label className="promote-field">
            <span className="promote-label">persona.legal_entity</span>
            <input
              className="promote-input"
              placeholder="e.g. CA legal entity code"
              value={draft.persona.legal_entity}
              onChange={(e) => updatePersona({ legal_entity: e.target.value })}
            />
          </label>

          <label className="promote-field promote-field-wide">
            <span className="promote-label">
              persona.notes <span className="promote-hint">optional</span>
            </span>
            <input
              className="promote-input"
              value={draft.persona.notes}
              onChange={(e) => updatePersona({ notes: e.target.value })}
            />
          </label>

          <div className="promote-field promote-field-wide">
            <span className="promote-label">expected.key_facts</span>
            {draft.expected.key_facts.map((fact, index) => (
              <div className="promote-key-fact-row" key={index}>
                <input
                  className="promote-input"
                  placeholder="Fact checked by reference comparison, not prose similarity"
                  value={fact}
                  onChange={(e) => updateKeyFact(index, e.target.value)}
                />
                <button
                  type="button"
                  className="ds-btn-ghost"
                  onClick={() => removeKeyFact(index)}
                  disabled={draft.expected.key_facts.length === 1}
                >
                  Remove
                </button>
              </div>
            ))}
            <button type="button" className="ds-btn-ghost" onClick={addKeyFact}>
              + Add key fact
            </button>
          </div>

          <label className="promote-field promote-checkbox">
            <input
              type="checkbox"
              checked={draft.expected.must_escalate}
              onChange={(e) => updateDraft({ expected: { ...draft.expected, must_escalate: e.target.checked } })}
            />
            <span className="promote-label">expected.must_escalate</span>
          </label>

          <label className="promote-field promote-checkbox">
            <input
              type="checkbox"
              checked={draft.expected.must_cite}
              onChange={(e) => updateDraft({ expected: { ...draft.expected, must_cite: e.target.checked } })}
            />
            <span className="promote-label">expected.must_cite</span>
          </label>
        </div>

        <div className="promote-yaml-section">
          <span className="promote-label">YAML preview</span>
          <pre className="yaml-preview">{yaml}</pre>
        </div>

        {errors.length > 0 && (
          <div className="ds-banner-error promote-panel-note">
            <strong>Fix before submitting:</strong>
            <ul className="promote-error-list">
              {errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </div>
        )}

        {submitState.status === "error" && (
          <div className="ds-banner-error promote-panel-note">{submitState.message}</div>
        )}

        {submitState.status === "success" && (
          <div className="ds-banner-info promote-panel-note" role="status">
            Stub MR opened (sample flow, stub GitLab client) —{" "}
            <a href={submitState.webUrl} target="_blank" rel="noreferrer">
              {submitState.webUrl}
            </a>
          </div>
        )}

        <div className="promote-actions">
          <button type="button" className="ds-btn-ghost" onClick={onClose}>
            Discard
          </button>
          <button
            type="button"
            className="ds-btn"
            disabled={errors.length > 0 || submitting || submitState.status === "success"}
            onClick={handleSubmit}
          >
            {submitting ? "Submitting…" : "Submit draft MR"}
          </button>
        </div>
      </div>
    </div>
  );
}
