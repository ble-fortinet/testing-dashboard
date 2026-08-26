/**
 * Surface 1 — Testing.
 * Build order: (1) read-only results view, (2) trigger run, (4) continue-conversation,
 * (5) promote-to-test. None wired to real data yet — backend routes 501 until the
 * chatbot repo and GitLab project are configured.
 *
 * The rows below are SAMPLE fixture data (not from /api/tests) purely so the design
 * system treatment is visible against real-shaped content. Replace with a fetch to
 * /api/tests once that route returns data — see docs/open-questions.md.
 */
type SampleGrade = "pass" | "fail" | "n/a";

type SampleRow = {
  id: string;
  category: string;
  severity: "blocker" | "high" | "medium";
  deterministic: SampleGrade;
  reference: SampleGrade;
  llmJudge: string;
  status: "passed" | "failed" | "flaky";
  flakeRate: string;
  jobRef: string;
};

const SAMPLE_ROWS: SampleRow[] = [
  {
    id: "HR-014",
    category: "Region resolution",
    severity: "blocker",
    deterministic: "pass",
    reference: "pass",
    llmJudge: "9/10",
    status: "passed",
    flakeRate: "0/3",
    jobRef: "#48213",
  },
  {
    id: "HR-027",
    category: "Escalation trigger",
    severity: "blocker",
    deterministic: "fail",
    reference: "n/a",
    llmJudge: "—",
    status: "failed",
    flakeRate: "0/3",
    jobRef: "#48213",
  },
  {
    id: "HR-041",
    category: "Benefits — Quebec",
    severity: "high",
    deterministic: "pass",
    reference: "pass",
    llmJudge: "7/10",
    status: "flaky",
    flakeRate: "2/3",
    jobRef: "#48213",
  },
];

function GradeCell({ value }: { value: SampleGrade }) {
  if (value === "n/a") return <span className="ds-badge-muted">N/A</span>;
  if (value === "pass") return <span className="ds-badge-success">PASS</span>;
  return <span className="grade-fail">FAIL</span>;
}

function StatusBadge({ status }: { status: SampleRow["status"] }) {
  if (status === "passed") return <span className="ds-badge-success">PASSED</span>;
  if (status === "failed") return <span className="grade-fail">FAILED</span>;
  return <span className="ds-badge-muted">FLAKY</span>;
}

function rowClassName(status: SampleRow["status"]) {
  if (status === "passed") return "row-pass";
  if (status === "failed") return "row-fail";
  return undefined;
}

export function TestingPage() {
  return (
    <section>
      <div className="page-head">
        <span className="ds-eyebrow">Surface 1</span>
        <h2 className="ds-hero page-title">Testing</h2>
      </div>

      <div className="ds-banner-info" role="status">
        Not wired up yet — this is a layout placeholder. Filters (category, severity,
        status), re-run-failures, and run-diff controls go here once{" "}
        <code>/api/tests</code> returns real data.
      </div>

      <div className="ds-card table-card">
        <div className="ds-card-title table-card-title">
          Test Results <span className="sample-flag">— sample data</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Category</th>
                <th>Severity</th>
                <th>
                  Deterministic
                  <span className="col-note">blocking</span>
                </th>
                <th>
                  Reference
                  <span className="col-note">blocking</span>
                </th>
                <th>
                  LLM judge
                  <span className="col-note">advisory only</span>
                </th>
                <th>Status</th>
                <th>Flake rate</th>
                <th>GitLab job</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_ROWS.map((row) => (
                <tr key={row.id} className={rowClassName(row.status)}>
                  <td className="mono-cell">{row.id}</td>
                  <td>{row.category}</td>
                  <td className="mono-cell severity-cell">{row.severity}</td>
                  <td>
                    <GradeCell value={row.deterministic} />
                  </td>
                  <td>
                    <GradeCell value={row.reference} />
                  </td>
                  <td className="mono-cell muted-cell">{row.llmJudge}</td>
                  <td>
                    <StatusBadge status={row.status} />
                  </td>
                  <td className="mono-cell">{row.flakeRate}</td>
                  <td>
                    <a href="#" className="job-link">
                      {row.jobRef} →
                    </a>
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={9}>
                  <div className="empty-state">
                    Remaining ~97 cases — chatbot repo not linked.
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
