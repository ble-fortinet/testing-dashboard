/**
 * Surface 2 — Logging. Build order stage 3.
 * Reads production conversation logs through the backend, which reads them
 * with the caller's own on-behalf-of token — this page never touches a
 * dashboard-owned copy of that data because there isn't one.
 *
 * The rows below are SAMPLE fixture data (not from /api/logs) purely so the design
 * system treatment is visible against real-shaped content. Replace with a fetch to
 * /api/logs once that route returns data — see docs/open-questions.md.
 */
type Outcome = "answered" | "escalated" | "abstained";

type SampleLogRow = {
  timestamp: string;
  query: string;
  region: string;
  outcome: Outcome;
  latency: string;
  flagged?: boolean;
};

const SAMPLE_ROWS: SampleLogRow[] = [
  {
    timestamp: "2026-08-26 09:14",
    query: "How many paid sick days do I get in my first year?",
    region: "ON",
    outcome: "answered",
    latency: "1.8s",
  },
  {
    timestamp: "2026-08-26 09:07",
    query: "Can I roll over unused vacation into next year?",
    region: "QC",
    outcome: "escalated",
    latency: "0.9s",
  },
  {
    timestamp: "2026-08-26 08:52",
    query: "What's the parental leave top-up policy for contractors?",
    region: "BC",
    outcome: "abstained",
    latency: "2.4s",
    flagged: true,
  },
];

function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  if (outcome === "answered") return <span className="ds-badge">ANSWERED</span>;
  if (outcome === "escalated") return <span className="ds-badge-outline">ESCALATED</span>;
  return <span className="ds-badge-muted">ABSTAINED</span>;
}

export function LoggingPage() {
  return (
    <section>
      <div className="page-head">
        <span className="ds-eyebrow">Surface 2</span>
        <h2 className="ds-hero page-title">Logging</h2>
      </div>

      <div className="ds-banner-info" role="status">
        Not wired up yet. Once <code>/api/logs</code> has a real log store client behind
        it: filter by region/topic/outcome/date, a low-confidence &amp; abstained-queries
        view, abstention/escalation trend charts, and thumbs-down flagged conversations
        go here.
      </div>

      <ul className="view-list">
        <li>Low-confidence &amp; abstained queries — content-gap report</li>
        <li>Abstention / escalation rate trends over time</li>
        <li>Filter by region, topic, outcome, date</li>
        <li>Flagged conversations from user thumbs-down</li>
      </ul>

      <div className="ds-card table-card">
        <div className="ds-card-title table-card-title">
          Log Stream <span className="sample-flag">— sample data</span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Query</th>
                <th>Resolved region</th>
                <th>Outcome</th>
                <th>Latency</th>
              </tr>
            </thead>
            <tbody>
              {SAMPLE_ROWS.map((row) => (
                <tr key={row.timestamp}>
                  <td className="mono-cell muted-cell">{row.timestamp}</td>
                  <td>
                    {row.query}
                    {row.flagged ? <span className="flag-note"> · flagged</span> : null}
                  </td>
                  <td className="mono-cell severity-cell">{row.region}</td>
                  <td>
                    <OutcomeBadge outcome={row.outcome} />
                  </td>
                  <td className="mono-cell">{row.latency}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={5}>
                  <div className="empty-state">No further rows — log store not configured.</div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
