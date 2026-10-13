import { html, render, useState, useEffect, useLayoutEffect, useMemo, useCallback, useRef } from "./vendor/preact-htm.mjs";

const BASE = document.body.dataset.base;

async function api(path, { method = "GET", body, form } = {}) {
  const opts = { method, headers: {} };
  if (form) opts.body = form;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers["Content-Type"] = "application/json";
  }
  const r = await fetch(`${BASE}/api/${path}`, opts);
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = undefined; }
  // An expired session comes back from the gate as the sign-in page, not as JSON.
  if (r.ok && (data === undefined || r.redirected)) throw new Error("Your session has expired — reload the page to sign in again.");
  if (!r.ok) {
    const d = data && (data.detail ?? data.error);
    throw new Error(typeof d === "string" ? d : d ? JSON.stringify(d) : `HTTP ${r.status}`);
  }
  return data;
}

// ------------------------------------------------------------------ helpers
const fmtMs = (ms) => (ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const fmtPct = (x) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
const fmtClock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
const lines = (t) => (t || "").split("\n").map((s) => s.trim()).filter(Boolean);
const runnable = (c) => c.status === "ready" && !(c.issues || []).length;
const pl = (n, w, p) => `${n} ${n === 1 ? w : p || w + "s"}`;
const isFull = (r) => r && (r.params || {}).scope === "ready";
const LIVE = new Set(["queued", "running"]);
// "Run #3", "Run #4 · Red team", "Re-run #5 · TC-004", "Run #6 · 13 cases"
function runLabel(r) {
  const p = r.params || {}, ids = p.ids || [];
  if (p.scope === "ready") return `Run #${r.id}`;
  if (p.scope === "category") return `Run #${r.id} · ${p.category || "—"}`;
  return ids.length === 1 ? `Re-run #${r.id} · ${ids[0]}` : `Run #${r.id} · ${pl(ids.length, "case")}`;
}
const store = {
  get(k, d) { try { const v = localStorage.getItem(`tdash.${k}`); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`tdash.${k}`, JSON.stringify(v)); } catch { /* private window: per-viewer only */ } },
};

// Per case across attempts: pass only if every graded attempt passed.
function outcomeOf(rs) {
  if (!rs || !rs.length) return null;
  const graded = rs.filter((r) => r.status === "pass" || r.status === "fail");
  if (!graded.length) return "error";
  return graded.some((r) => r.status === "fail") ? "fail" : "pass";
}

const svg = (paths) => () => html`<svg class="ic" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" dangerouslySetInnerHTML=${{ __html: paths }}></svg>`;
const I = {
  pass: svg('<path d="M3.5 8.5l3 3 6-7"/>'), fail: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'),
  error: svg('<path d="M8 3v6"/><circle cx="8" cy="12.5" r=".6" fill="currentColor"/>'), none: svg('<circle cx="8" cy="8" r="4.5" stroke-dasharray="2 2"/>'),
  missing: svg('<path d="M4 8h8"/>'), unknown: svg('<circle cx="8" cy="8" r="4.5" stroke-dasharray="2 2"/>'),
  critical: svg('<path d="M8 2.5l6 11H2z"/><path d="M8 6.5v3"/><circle cx="8" cy="11.6" r=".5" fill="currentColor"/>'),
  serious: svg('<circle cx="8" cy="8" r="6"/><path d="M8 5v3.5"/><circle cx="8" cy="11" r=".5" fill="currentColor"/>'),
  warning: svg('<circle cx="8" cy="8" r="6"/><path d="M5.5 8h5"/>'), info: svg('<circle cx="8" cy="8" r="6"/><path d="M8 7.5V11"/><circle cx="8" cy="5" r=".5" fill="currentColor"/>'),
  play: svg('<path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor"/>'), rerun: svg('<path d="M13 8a5 5 0 1 1-1.5-3.5"/><path d="M13 2.5v3h-3"/>'),
  down: svg('<path d="M4 6l4 4 4-4"/>'), close: svg('<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>'), plus: svg('<path d="M8 3v10M3 8h10"/>'),
  user: svg('<circle cx="8" cy="5.5" r="2.5"/><path d="M3 13.5c.8-2.6 2.7-3.8 5-3.8s4.2 1.2 5 3.8"/>'), trash: svg('<path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5"/>'),
  tests: svg('<path d="M2.5 4l1.5 1.5L6.5 3M2.5 10l1.5 1.5L6.5 9M9 4.5h4.5M9 10.5h4.5"/>'), set: svg('<rect x="2.5" y="2.5" width="11" height="11" rx="1.5"/><path d="M2.5 6.5h11M6.5 6.5v7"/>'),
  chat: svg('<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'), log: svg('<path d="M3 4h10M3 8h10M3 12h6"/>'), up: svg('<path d="M8 13V3.5M4 7.5l4-4 4 4"/>'),
  more: svg('<circle cx="3.5" cy="8" r=".8" fill="currentColor"/><circle cx="8" cy="8" r=".8" fill="currentColor"/><circle cx="12.5" cy="8" r=".8" fill="currentColor"/>'),
};
const LABEL = { pass: "Pass", fail: "Fail", error: "Error", none: "Not run" };
const SEVL = { critical: "Critical", serious: "Serious", warning: "Warning", info: "Note" };
// The audit's finding kinds (stats.signals), by how much they should worry you.
const SEV = { region_leak: "critical", regressions: "serious", errors: "warning", kb_gap: "warning", retrieval_miss: "warning", language: "warning", flaky: "warning" };
const sevOf = (kind) => SEV[kind] || "info";
const Status = ({ s, plain }) => html`<span class="sb sb-${s}${plain ? " sb-plain" : ""}">${I[s]()}<span>${LABEL[s]}</span></span>`;

function Dots({ r }) {
  const v = (r && r.judge && r.judge.points) || [];
  if (!r || r.status === "error") return html`<span class="faint">—</span>`;
  if (!v.length) return html`<span class="faint" title="No expected points: graded on checks only">checks only</span>`;
  const cov = v.filter((x) => x === "covered").length;
  const need = Math.max(1, Math.ceil((r.threshold ?? 0) * v.length - 1e-9));
  return html`<span class="dots-score" title=${`${cov} of ${v.length} expected points covered; needs ${need}`}>
    <span class="dots">${v.map((x) => html`<i class=${x === "covered" ? "" : x === "missing" ? "m" : "c"}></i>`)}</span><span class="f">${cov}/${v.length}</span></span>`;
}
const Stack = ({ c }) => {
  const n = c.pass + c.fail + c.error || 1;
  return html`<span class="stack" title=${`${c.pass} pass · ${c.fail} fail · ${c.error} error`}>
    ${c.pass > 0 && html`<i class="p" style=${`flex:${c.pass / n}`}></i>`}${c.fail > 0 && html`<i class="f" style=${`flex:${c.fail / n}`}></i>`}${c.error > 0 && html`<i class="e" style=${`flex:${c.error / n}`}></i>`}</span>`;
};
const Marker = ({ c }) => html`${c.review && html`<span class="mk mk-${c.review.kind}" title=${c.review.note || ""}>${c.review.kind === "add" ? "Add" : "Check"}</span>`}${(c.issues || []).length > 0 && html`<span class="mk mk-issue" title=${c.issues.join("\n")}>${pl(c.issues.length, "issue")}</span>`}`;

function useEscape(fn, on = true) {
  useEffect(() => {
    if (!on) return;
    const k = (e) => { if (e.key === "Escape") fn(); };
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [fn, on]);
}

// ------------------------------------------------------------------ header (N2)
function Header({ view, setView, info, latest, active }) {
  const tabs = [["tests", "Tests", I.tests], ["play", "Playground", I.chat], ["set", "Test set", I.set]];
  let chip = null;
  if (active) chip = html`<button class="runchip" onClick=${() => setView("tests")} title="A run is in progress"><span class="ring-spin"></span><span>Running ${runLabel(active).replace("Run ", "").replace("Re-run ", "re-run ")}</span><b>${active.done || 0}/${active.total || "…"}</b></button>`;
  else if (latest) chip = html`<button class="runchip" onClick=${() => setView("tests")} title=${`Latest full run, ${fmtTime(latest.created_at)}`}><i class="dot ok"></i><span>Run #${latest.id}</span><b>${fmtPct(latest.overview && latest.overview.pass_rate)}</b><span class="faint">${fmtClock(latest.created_at)}</span></button>`;
  const who = info.user.username;
  return html`<header class="top">
    <div class="brand"><i></i><span>Testing Dashboard</span></div>
    <nav class="pillnav" aria-label="Sections">
      ${tabs.map(([k, label, ic]) => html`<button aria-current=${view === k ? "page" : null} onClick=${() => setView(k)}>${ic()}<span>${label}</span></button>`)}
      <button disabled title="Logging is planned for later">${I.log()}<span>Logging</span><span class="todo">TODO</span></button>
    </nav>
    <div class="right">${chip}<span class="avatar" title=${`${who} · ${info.user.role}${info.dev ? " (dev)" : ""}`}>${who.slice(0, 2)}</span></div>
  </header>`;
}

// ------------------------------------------------------------------ run controls
function RunControls({ info, cases, results, active, onStart, onCancel }) {
  const [scope, setScope] = useState("ready");
  // remembered per browser between runs; a value the server no longer allows falls back
  const [repeats, setRepeats] = useState(() => ([1, 3].includes(store.get("repeats")) ? store.get("repeats") : 1));
  const [conc, setConc] = useState(() => { const c = store.get("conc"); return c >= 1 && c <= info.max_concurrency ? c : info.default_concurrency; });
  const [probe, setProbe] = useState(false);
  useEffect(() => { store.set("repeats", repeats); }, [repeats]);
  useEffect(() => { const c = Number(conc); if (c >= 1 && c <= info.max_concurrency) store.set("conc", c); }, [conc]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = cases.filter(runnable);
  const cats = [...new Set(ready.map((c) => c.category || ""))].sort();
  const failing = useMemo(() => {
    const by = {};
    for (const r of results) if (r.phase == null) (by[r.case_id] = by[r.case_id] || []).push(r);
    return ready.filter((c) => ["fail", "error"].includes(outcomeOf(by[c.id]))).map((c) => c.id);
  }, [results, cases]);
  const n = scope === "ready" ? ready.length : scope === "failing" ? failing.length : ready.filter((c) => `cat:${c.category || ""}` === scope).length;
  if (active) {
    const done = active.done || 0, total = active.total || 1, c = active.counts || {};
    return html`<div class="card live">
      <strong>${runLabel(active)} · ${active.status}</strong>
      <div class="progress" role="progressbar" aria-valuenow=${done} aria-valuemax=${total}><i style=${`width:${Math.min(100, (done / total) * 100)}%`}></i></div>
      <span class="mut num">${done} / ${total}</span>
      <span class="num">${c.pass || 0} pass · ${c.fail || 0} fail · ${c.error || 0} error${c.probe ? ` · ${c.probe} probe` : ""}</span>
      <button class="btn danger" onClick=${onCancel}>Cancel</button>
    </div>`;
  }
  const blocked = !info.chatbot.ready ? "The chatbot isn't configured (CHATBOT_URL, CHATBOT_TOKEN)." : !info.judge.ready ? "The judge isn't configured (JUDGE_URL, JUDGE_MODEL)." : "";
  const start = async () => {
    setErr(""); setBusy(true);
    const body = { repeats, concurrency: Number(conc), probe };
    if (scope === "ready") body.scope = "ready";
    else if (scope === "failing") Object.assign(body, { scope: "ids", ids: failing });
    else Object.assign(body, { scope: "category", category: scope.slice(4) });
    try { await onStart(body); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return html`<div class="ctl">
    <label>Run <select class="input" value=${scope} onChange=${(e) => setScope(e.target.value)} aria-label="Which cases">
      <option value="ready">All ready (${ready.length})</option>
      ${failing.length > 0 && html`<option value="failing">Failing in this run (${failing.length})</option>`}
      ${cats.map((c) => html`<option value=${`cat:${c}`}>${c || "—"} (${ready.filter((x) => (x.category || "") === c).length})</option>`)}
    </select></label>
    <label>In flight <input class="input" type="number" min="1" max=${info.max_concurrency} value=${conc} onInput=${(e) => setConc(e.target.value)} /></label>
    <div class="seg" role="group" aria-label="Repeats">${[1, 3].map((k) => html`<button aria-pressed=${repeats === k} onClick=${() => setRepeats(k)} title=${k > 1 ? "Ask each case three times: catches flaky answers" : ""}>×${k}</button>`)}</div>
    <label title="After the run: 8 unjudged requests each at 1, 4 and 8 in flight, for a latency curve"><input type="checkbox" checked=${probe} onChange=${(e) => setProbe(e.target.checked)} /> Load probe</label>
    <button class="btn pri" disabled=${!!blocked || n === 0 || busy} onClick=${start}>${I.play()} Run ${pl(n, "case")}${repeats > 1 ? ` ×${repeats}` : ""}</button>
    ${blocked && html`<span class="banner warn">${blocked}</span>`}
    ${err && html`<span class="banner err">${err}</span>`}
  </div>`;
}

// ------------------------------------------------------------------ pass summary (H1; the L1 spinner while running)
function Ring({ c, spin, children }) {
  const size = 136, w = 14, cx = size / 2, r = cx - w / 2 - 1, C = 2 * Math.PI * r;
  const n = spin ? 0 : c.pass + c.fail + c.error;
  let off = 0;
  // pass / fail / error as rounded arcs with a gap between them
  const segs = [["pass", "good"], ["fail", "bad"], ["error", "warn"]].map(([k, col]) => {
    const v = n ? c[k] : 0;
    if (!v) return null;
    const whole = v === n, len = (v / n) * C, cut = whole ? 0 : Math.min(len * 0.5, 3 + w);
    const el = html`<circle cx=${cx} cy=${cx} r=${r} fill="none" stroke=${`var(--${col})`} stroke-width=${w} stroke-linecap=${whole ? "butt" : "round"}
      stroke-dasharray=${`${Math.max(0.01, len - cut)} ${C}`} stroke-dashoffset=${-(off + cut / 2)} transform=${`rotate(-90 ${cx} ${cx})`}><title>${v} ${LABEL[k].toLowerCase()}</title></circle>`;
    off += len;
    return el;
  });
  return html`<div class="ring"><svg width=${size} height=${size} aria-hidden="true">
    <circle cx=${cx} cy=${cx} r=${r} fill="none" stroke="var(--surface2)" stroke-width=${w} />
    ${spin ? html`<g class="spinring"><circle cx=${cx} cy=${cx} r=${r} fill="none" stroke="var(--accent)" stroke-width=${w} stroke-linecap="round" stroke-dasharray=${`${C * 0.24} ${C}`} /></g>` : segs}
  </svg><div class="mid"><div>${children}</div></div></div>`;
}

function Counts({ c, fresh, onPick }) {
  const item = (k, n, label, extra) => onPick
    ? html`<button class=${`cnt ${k}`} onClick=${() => onPick(k)} title=${`Show only ${label}`}><i></i><b>${n}</b><span>${label}${extra}</span></button>`
    : html`<span class=${`cnt ${k}`}><i></i><b>${n}</b><span>${label}${extra}</span></span>`;
  return html`${item("pass", c.pass || 0, "passed", "")}${item("fail", c.fail || 0, "failed", fresh ? html` · <em>${fresh} new</em>` : "")}${item("error", c.error || 0, "didn't answer", "")}`;
}

function Summary({ run, live, delta, fresh, onPick, onCancel }) {
  if (live) {
    const done = live.done || 0, total = live.total || 0, c = live.counts || {};
    const mins = (Date.now() - new Date(live.created_at).getTime()) / 60000;
    const left = done && total > done && mins > 0 ? Math.max(1, Math.round((mins / done) * (total - done))) : null;
    return html`<div class="card sum" aria-live="polite">
      <${Ring} c=${c} spin><span class="rn">${done}<small> / ${total || "…"}</small></span><span class="rs">graded</span><//>
      <div class="sum-r"><div class="sum-top"><${Counts} c=${c} /></div>
        <div class="sum-bot"><span class="livehead"><span class="ring-spin"></span>${runLabel(live)} · ${live.status}</span>
          <span class="mut" style="font-size:13px">Started ${fmtClock(live.created_at)} · ${(live.info || {}).concurrency || "?"} in flight${left ? ` · about ${pl(left, "min", "min")} left` : ""}</span>
          <button class="btn sm danger" onClick=${onCancel}>Cancel run</button></div></div></div>`;
  }
  const ov = run.overview || {}, c = { pass: ov.passed || 0, fail: ov.failed || 0, error: ov.errored || 0 };
  const going = LIVE.has(run.status);
  return html`<div class="card sum">
    <${Ring} c=${c}>${ov.pass_rate != null ? html`<span class="rn">${(ov.pass_rate * 100).toFixed(1)}<small>%</small></span><span class="rs">passed</span>`
      : html`<span class="rn none">${going ? "Running…" : "—"}</span>${!going && html`<span class="rs">nothing judged</span>`}`}<//>
    <div class="sum-r">
      <div class="sum-top"><${Counts} c=${c} fresh=${fresh} onPick=${onPick} />
        ${delta != null && html`<span class=${`delta ${delta <= -0.05 ? "down" : delta >= 0.05 ? "up" : "flat"}`}>${delta <= -0.05 ? "▼ " : delta >= 0.05 ? "▲ " : ""}${Math.abs(delta).toFixed(1)} pts vs #${run.baseline_run}</span>`}</div>
      <div class="sum-bot">
        <div class="fx"><span>Judged</span><b>${c.pass + c.fail}</b></div>
        <div class="fx"><span>Median score</span><b>${ov.score_median != null ? ov.score_median.toFixed(2) : "—"}</b></div>
        <div class="fx"><span>Latency p50</span><b>${fmtMs(ov.latency_p50_ms)}</b></div>
        <div class="fx"><span>Latency p95</span><b>${fmtMs(ov.latency_p95_ms)}</b></div>
      </div></div></div>`;
}

// ------------------------------------------------------------------ breakdown (C1)
function FoldCard({ k, title, sub, open, toggle, summary, children }) {
  return html`<div class="card fold${open ? "" : " shut"}">
    <button class="fold-h" data-fold=${k} aria-expanded=${open} onClick=${toggle}><span class="car">${I.down()}</span><b>${title}</b>${open ? html`<small>${sub}</small>` : html`<span class="fold-sum">${summary}</span>`}</button>
    ${open && html`<div class="fold-b">${children}</div>`}
  </div>`;
}

function Breakdown({ run }) {
  // Folded by default; the choice is remembered per browser.
  const [fold, setFold] = useState(() => store.get("fold", { cat: true, aud: true }));
  const [allSig, setAllSig] = useState(false);
  const anchor = useRef(null);
  // Keep whatever was clicked under the cursor: the page never jumps.
  useLayoutEffect(() => {
    if (!anchor.current) return;
    const { sel, y } = anchor.current;
    anchor.current = null;
    const n = document.querySelector(sel);
    if (n) window.scrollBy(0, n.getBoundingClientRect().top - y);
  }, [fold]);
  const change = (next, sel, el) => {
    anchor.current = { sel, y: el.getBoundingClientRect().top };
    setFold(next); store.set("fold", next);
  };
  const ov = run.overview || {};
  const cats = Object.entries(ov.by_category || {}).filter(([, c]) => c.pass + c.fail + c.error > 0);
  const audit = run.audit;
  const items = audit ? (allSig ? audit.signals || [] : audit.findings || []) : [];
  const failing = cats.filter(([, c]) => c.fail || c.error).sort((a, b) => b[1].fail - a[1].fail);
  const bySev = ["critical", "serious", "warning", "info"].map((s) => [s, (audit ? audit.findings || [] : []).filter((f) => sevOf(f.kind) === s).length]).filter(([, n]) => n);
  const both = fold.cat && fold.aud;
  return html`
    <div class="sechead"><span>Breakdown</span>
      <button class="btn sm ghost" data-fold="all" onClick=${(e) => change(both ? { cat: false, aud: false } : { cat: true, aud: true }, '[data-fold="all"]', e.currentTarget)}>${both ? "Expand both" : "Collapse both"}</button></div>
    <div class="pair${both ? " allshut" : ""}">
      <${FoldCard} k="cat" title="By category" sub="passed / judged" open=${!fold.cat} toggle=${(e) => change({ ...fold, cat: !fold.cat }, '[data-fold="cat"]', e.currentTarget)}
        summary=${html`${failing.map(([cat, c]) => html`<span class="mini"><i style=${`background:var(--${c.fail ? "bad" : "warn"})`}></i>${cat} <b>${c.fail ? `${c.fail} ✕` : `${c.error} !`}</b></span>`)}<span class="mut">${failing.length ? `${cats.length - failing.length} clean` : `all ${cats.length} clean`}</span>`}>
        ${cats.map(([cat, c]) => html`<div class="catrow"><span class="cn" title=${cat}>${cat}</span><${Stack} c=${c} /><span class="r">${c.pass}/${c.pass + c.fail}</span></div>`)}
      <//>
      <${FoldCard} k="aud" title="Audit" sub=${audit ? (audit.phrased_by === "llm" ? "numbers computed, then phrased" : "computed findings") : ""} open=${!fold.aud} toggle=${(e) => change({ ...fold, aud: !fold.aud }, '[data-fold="aud"]', e.currentTarget)}
        summary=${audit ? (bySev.length ? bySev.map(([s, n]) => html`<span class="mini sev-${s}">${I[s]()}<span style="color:var(--fg)">${n} ${s === "info" ? (n === 1 ? "note" : "notes") : SEVL[s].toLowerCase()}</span></span>`) : html`<span class="mut">Nothing stood out</span>`) : html`<span class="mut">${isFull(run) ? (LIVE.has(run.status) ? "After the run" : "None for this run") : "Only full runs get an audit"}</span>`}>
        ${!audit ? html`<p class="mut" style="margin:0">${LIVE.has(run.status) ? "The audit is written when the run finishes." : "No audit for this run."}</p>`
          : items.length ? html`<ul class="aud">${items.map((f) => html`<li key=${f.id}><span class=${`sev sev-${sevOf(f.kind)}`} title=${SEVL[sevOf(f.kind)]}>${I[sevOf(f.kind)]()}</span><span><b style="font-weight:600">${SEVL[sevOf(f.kind)]}.</b> ${f.text}</span></li>`)}</ul>`
          : html`<p class="mut" style="margin:0">Nothing stood out.</p>`}
        ${audit && (audit.signals || []).length > (audit.findings || []).length && html`<button class="btn sm ghost" style="margin-top:10px" onClick=${() => setAllSig(!allSig)}>${allSig ? "Top findings only" : `All ${audit.signals.length} signals`}</button>`}
      <//>
    </div>`;
}

// ------------------------------------------------------------------ the case detail
function Detail({ c, rs, rr, run, onRerun, rerunning, canRerun, onEdit, onTry }) {
  const attempts = rr ? [rr] : rs || [];
  const [pick, setPick] = useState(attempts.length - 1);
  useEffect(() => setPick(attempts.length - 1), [c.id, rr && rr.result_id, attempts.length]);
  const r = attempts[Math.max(0, Math.min(pick, attempts.length - 1))];
  const cs = (r && r.case) || c;
  const s = rr ? rr.status : outcomeOf(rs) || "none";
  const head = html`<div class="det-meta"><span class="mono">${cs.id}</span><span>${cs.category || "—"}</span><span>Asked as <span class="mono">${cs.persona}</span></span>${cs.tests && html`<span>Tests <b>${cs.tests}</b></span>`}</div>
    <h3 class="det-q">${cs.question}</h3>`;
  const rerunBtn = html`<button class="btn sm" disabled=${!canRerun} onClick=${onRerun} title=${canRerun ? "" : "Waiting for the current run"}>${rerunning ? html`<span class="spin">${I.rerun()}</span> Running…` : html`${I.rerun()} Re-run now`}</button>`;
  if (!r) return html`<div class="det">${head}<div class="det-banner"><span class="fbt">Not part of run #${run.id}.</span>${runnable(c) && rerunBtn}</div>
    <div class="acts"><button class="btn" onClick=${onEdit}>Edit case</button></div></div>`;
  const pts = lines(cs.expected), mn = lines(cs.must_not), j = r.judge || {}, bot = r.bot || {};
  const fb = r.error || r.feedback || (r.status === "pass" ? "Covered every expected point." : (r.reasons || []).join(" · ") || "");
  const region = r.expected_region;
  return html`<div class="det">${head}
    <div class=${`det-banner s-${s}`}><${Status} s=${s} /><span class="fbt">${fb}</span>${rerunBtn}</div>
    ${attempts.length > 1 && html`<div class="attempts" role="group" aria-label="Attempts">${attempts.map((a, i) => html`<button class="btn sm" aria-pressed=${i === pick} style=${i === pick ? "border-color:var(--accent)" : ""} onClick=${() => setPick(i)}><${Status} s=${a.status === "probe" ? "none" : a.status} plain /> Attempt ${a.attempt}</button>`)}</div>`}
    <div class="det-meta">
      ${r.score != null && html`<span>Score <${Dots} r=${r} /></span>`}
      <span>Latency <b class="num">${fmtMs(r.latency_ms)}</b>${r.in_flight ? ` at ${r.in_flight} in flight` : ""}${r.retried ? " · retried once" : ""}</span>
      ${bot.signal && html`<span>Chatbot's own judge <b>${bot.signal}</b></span>`}
      ${rr && html`<span class="tag-rr">Re-run ${fmtClock(rr.at)} · ${(rs || []).length ? `run #${run.id} said ${LABEL[outcomeOf(rs)].toLowerCase()}` : `not in run #${run.id}`}</span>`}
    </div>
    ${r.status === "fail" && (r.reasons || []).length > 0 && r.feedback && html`<div class="det-meta">Failed because <b>${r.reasons.join(" · ")}</b></div>`}
    <div class="det-grid">
      ${pts.length > 0 && html`<div class="det-sec"><h4>Expected points</h4><ul class="pts">${pts.map((p, i) => {
        const v = (j.points || [])[i] || "unknown";
        return html`<li class=${`v-${v}`}>${(v === "covered" ? I.pass : v === "missing" ? I.missing : v === "contradicted" ? I.fail : I.unknown)()}<span>${p}</span><span class="lab">${v === "unknown" ? "—" : v[0].toUpperCase() + v.slice(1)}</span></li>`;
      })}</ul></div>`}
      ${(r.checks || []).length > 0 && html`<div class="det-sec"><h4>Checks</h4><ul class="pts">${r.checks.map((k) => html`<li class=${k.passed ? "v-covered" : "v-hit"}>${(k.passed ? I.pass : I.fail)()}<span>${k.check}${k.detail ? html` <span class="mono faint">${k.detail}</span>` : ""}</span><span class="lab">${k.passed ? "Passed" : "Failed"}</span></li>`)}</ul></div>`}
    </div>
    ${mn.length > 0 && html`<div class="det-sec"><h4>Must not say</h4><ul class="pts">${mn.map((m, i) => {
      const hit = (j.must_not || [])[i];
      return html`<li class=${hit ? "v-hit" : j.must_not ? "v-covered" : "v-unknown"}>${(hit ? I.fail : j.must_not ? I.pass : I.unknown)()}<span>${m}</span><span class="lab">${hit ? "Said" : j.must_not ? "Not said" : "—"}</span></li>`;
    })}</ul></div>`}
    ${bot.answer != null && html`<div class="det-sec"><h4>Answer</h4><pre class="ans">${bot.answer}</pre></div>`}
    ${bot.answer != null && html`<div class="det-sec"><h4>Sources${region ? html` <span class="faint" style="text-transform:none;letter-spacing:0;font-weight:400">· expected <span class="kb">${region}</span></span>` : ""}</h4>
      ${(bot.sources || []).length ? html`<ul class="srcs">${bot.sources.map((x) => html`<li><span class=${`kb${x.region && x.region !== region ? " leak" : ""}`}>${x.region || "—"}</span><span class="p">${x.path || x.title || ""}</span><span class="chip">${x.cited ? `cited [${x.n}]` : "retrieved, not cited"}</span></li>`)}</ul>` : html`<span class="mut">No documents.</span>`}</div>`}
    <div class="acts"><button class="btn" onClick=${onEdit}>Edit case</button><button class="btn" onClick=${onTry}>${I.chat()} Try in playground</button></div>
  </div>`;
}

// ------------------------------------------------------------------ tests view
function TestsView({ info, cases, runs, active, tick, refresh, openCase, tryInPlayground, rerun, rerunId, toast }) {
  const fullRuns = runs.filter(isFull);
  const [runId, setRunId] = useState(null);
  const [run, setRun] = useState(null);
  const [results, setResults] = useState([]);
  const [reruns, setReruns] = useState({});
  const [f, setF] = useState({ f: "all", cat: "", q: "" });
  const [closed, setClosed] = useState({});
  const [sel, setSel] = useState(null);
  const [err, setErr] = useState("");
  const shown = runId ?? (fullRuns[0] || runs[0] || {}).id ?? null;

  useEffect(() => {
    if (shown == null) { setRun(null); setResults([]); setReruns({}); return; }
    let stop = false, timer;
    const tickRun = async () => {
      try {
        const [r, rs, rr] = await Promise.all([api(`runs/${shown}`), api(`runs/${shown}/results`), api(`runs/${shown}/reruns`)]);
        if (stop) return;
        setRun(r); setResults(rs.results); setReruns(rr.reruns); setErr("");
        if (LIVE.has(r.status)) timer = setTimeout(tickRun, 2000);
      } catch (e) { if (!stop) setErr(e.message); }
    };
    tickRun();
    return () => { stop = true; clearTimeout(timer); };
  }, [shown, tick]);
  useEscape(useCallback(() => setSel(null), []), !!sel);
  // a result filter picked for one run doesn't follow you to the next
  useEffect(() => setF((x) => ({ ...x, f: "all" })), [shown]);

  const byCase = useMemo(() => {
    const m = {};
    for (const r of results) if (r.phase == null) (m[r.case_id] = m[r.case_id] || []).push(r);
    return m;
  }, [results]);
  const caseById = useMemo(() => Object.fromEntries(cases.map((c) => [c.id, c])), [cases]);
  // The run's cases, in test-set order; a case deleted since keeps its snapshot.
  const rows = useMemo(() => {
    const order = Object.fromEntries(cases.map((c, i) => [c.id, i]));
    // a case re-run since but not in the run itself (added later) still gets its row
    const ids = [...new Set([...Object.keys(byCase), ...Object.keys(reruns)])];
    return ids.sort((a, b) => (order[a] ?? 1e9) - (order[b] ?? 1e9)).map((id) => {
      const rs = byCase[id] || [], last = rs[rs.length - 1], rr = reruns[id];
      return { id, c: caseById[id] || (rr || last).case, rs, rr, last: rr || last, s: rr ? rr.status : outcomeOf(rs) };
    });
  }, [byCase, reruns, caseById, cases]);
  const ov = (run && run.overview) || {};
  const regressions = new Set(ov.regressions || []);
  const q = f.q.trim().toLowerCase();
  const fOk = (k, row) => k === "all" || (k === "attention" ? row.s === "fail" || row.s === "error" : row.s === k);
  const visible = rows.filter((row) => fOk(f.f, row) && (!f.cat || (row.c.category || "—") === f.cat)
    && (!q || [row.id, row.c.question, row.c.persona, row.last.feedback, row.last.error].join(" ").toLowerCase().includes(q)));
  const cats = [...new Set(rows.map((r) => r.c.category || "—"))];
  const groups = cats.map((cat) => ({ cat, rows: visible.filter((r) => (r.c.category || "—") === cat), all: rows.filter((r) => (r.c.category || "—") === cat) })).filter((g) => g.rows.length);
  const counts = (rs) => rs.reduce((a, r) => (a[r.s] = (a[r.s] || 0) + 1, a), { pass: 0, fail: 0, error: 0 });
  const selRow = sel && (rows.find((r) => r.id === sel) || null);

  const start = async (body) => { const r = await api("runs", { method: "POST", body }); setRunId(r.id); await refresh(); };
  const cancel = async () => { try { await api(`runs/${active.id}/cancel`, { method: "POST" }); await refresh(); } catch (e) { setErr(e.message); } };
  const step = (d) => {
    const flat = groups.flatMap((g) => (closed[g.cat] ? [] : g.rows));
    const i = flat.findIndex((r) => r.id === sel), n = flat[i + d];
    if (n) setSel(n.id);
  };

  const rrList = Object.values(reruns);
  const nowPass = rrList.filter((x) => x.status === "pass" && byCase[x.case_id] && outcomeOf(byCase[x.case_id]) !== "pass").length;
  const delta = ov.pass_rate != null && isFull(run) && run.baseline_pass_rate != null ? (ov.pass_rate - run.baseline_pass_rate) * 100 : null;
  const canRerun = !active && info.chatbot.ready && info.judge.ready;

  return html`<main>
    ${err && html`<div class="banner err">${err}<button class="btn sm" onClick=${() => setErr("")}>Dismiss</button></div>`}
    <div class="runbar">
      <h2>${run ? runLabel(run) : "No runs yet"}
        ${run && html`<span class="meta">${fmtTime(run.created_at)}${run.info.chatbot_commit ? html` · chatbot <span class="mono">${run.info.chatbot_commit}</span>` : ""} · test set v${run.info.test_set_version} · ${run.info.concurrency} in flight · ×${run.info.repeats} · judge ${run.info.judge_model}</span>`}
        ${runs.length > 1 && html`<select class="input" style="font-size:12.5px;font-weight:400" aria-label="Show another run" value=${shown} onChange=${(e) => { setRunId(Number(e.target.value)); setSel(null); }}>
          ${runs.map((r) => html`<option value=${r.id}>${runLabel(r)} · ${fmtTime(r.created_at)} · ${r.status}</option>`)}</select>`}
      </h2>
      ${!active && html`<${RunControls} info=${info} cases=${cases} results=${results} active=${null} onStart=${start} onCancel=${cancel} />`}
    </div>
    ${active && active.id !== shown && html`<${RunControls} info=${info} cases=${cases} results=${results} active=${active} onStart=${start} onCancel=${cancel} />`}
    ${!run ? html`<div class="card empty">${cases.length ? html`Nothing has run yet. Choose what to run above, then <b>Run</b>.` : html`No test set yet. Open <b>Test set</b> and import the workbook.`}</div>` : html`
      ${run.error && html`<div class="banner err">${run.error}</div>`}
      ${["cancelled", "interrupted"].includes(run.status) && html`<div class="banner warn">This run was ${run.status} — the numbers cover the ${pl(rows.length, "case")} that finished.</div>`}
      <${Summary} run=${run} live=${active && active.id === run.id ? active : null} delta=${delta} fresh=${regressions.size}
        onPick=${(k) => setF({ ...f, f: k })} onCancel=${cancel} />
      ${rrList.length > 0 && html`<div class="since">${I.rerun()}<span><b>Since run #${run.id}:</b> ${pl(rrList.length, "case")} re-run${nowPass ? `, ${nowPass} now ${nowPass === 1 ? "passes" : "pass"}` : ""}. The pass rate stays the run's own; re-run rows are marked below.</span></div>`}
      <${Breakdown} run=${run} />
      <div class="filters">
        <div class="seg">${[["all", "All"], ["attention", "Needs attention"], ["fail", "Failed"], ["error", "Errors"], ["pass", "Passed"]].map(([k, l]) => html`<button aria-pressed=${f.f === k} onClick=${() => setF({ ...f, f: k })}>${l}<span class="n">${rows.filter((r) => fOk(k, r)).length}</span></button>`)}</div>
        <select class="input" value=${f.cat} onChange=${(e) => setF({ ...f, cat: e.target.value })} aria-label="Category"><option value="">All categories</option>${cats.map((c) => html`<option value=${c}>${c}</option>`)}</select>
        <input class="input grow" type="search" placeholder="Search question, persona, feedback" value=${f.q} onInput=${(e) => setF({ ...f, q: e.target.value })} aria-label="Search" />
      </div>
      <div class="tablecard tblwrap"><table class="t res">
        <thead><tr><th style="width:104px">Result</th><th style="width:80px">ID</th><th>Question</th><th style="width:130px">Score</th><th style="width:76px">Latency</th><th>Feedback</th><th style="width:104px"><span class="sr">Re-run</span></th></tr></thead>
        <tbody>
          ${groups.map((g) => {
            const cl = !!closed[g.cat], gc = counts(g.all);
            return [html`<tr class=${`grp${cl ? " closed" : ""}`} key=${`g-${g.cat}`} onClick=${() => setClosed({ ...closed, [g.cat]: !cl })}>
              <td colspan="7"><div class="gh"><span class="car">${I.down()}</span><b>${g.cat}</b><span class="mut num">${gc.pass} pass · ${gc.fail} fail${gc.error ? ` · ${gc.error} error` : ""}</span><${Stack} c=${gc} /></div></td></tr>`,
            ...(cl ? [] : g.rows.map((row) => {
              const busy = rerunId === row.id;
              return html`<tr key=${row.id} class=${`row s-${row.s}${sel === row.id ? " sel" : ""}`} tabindex="0" onClick=${() => setSel(row.id)} onKeyDown=${(e) => e.key === "Enter" && e.target === e.currentTarget && setSel(row.id)}>
                <td><${Status} s=${row.s} /></td>
                <td class="mono">${row.id}</td>
                <td><span class="q">${row.c.question}</span><div class="sub"><span class="mono">${row.c.persona}</span>
                  ${regressions.has(row.id) && !row.rr && html`<span class="tag-new">new failure</span>`}
                  ${row.rr && html`<span class="tag-rr">re-run ${fmtClock(row.rr.at)} (${row.rs.length ? `was ${LABEL[outcomeOf(row.rs)].toLowerCase()}` : "not in this run"})</span>`}
                  ${!row.rr && row.rs.length > 1 && html`<span>${row.rs.filter((r) => r.status === "pass").length}/${row.rs.length} attempts passed</span>`}
                  ${row.rr && row.rr.attempts > 1 && html`<span>${row.rr.passed_attempts}/${row.rr.attempts} attempts passed</span>`}
                  ${!caseById[row.id] && html`<span>deleted since</span>`}</div></td>
                <td><${Dots} r=${row.last} /></td>
                <td class="num">${fmtMs(row.last.latency_ms)}</td>
                <td class="mut" style="font-size:13px">${row.last.error || row.last.feedback || (row.last.reasons || []).join(" · ")}</td>
                <td style="text-align:right" onClick=${(e) => e.stopPropagation()}>
                  <button class="btn sm" disabled=${!canRerun || !caseById[row.id] || !runnable(caseById[row.id])} onClick=${() => rerun(row.id)} aria-label=${`Re-run ${row.id}`}
                    title=${!caseById[row.id] ? "Deleted from the test set" : !runnable(caseById[row.id]) ? "Only ready cases without issues run" : active ? "Waiting for the current run" : ""}>
                    ${busy ? html`<span class="spin">${I.rerun()}</span> Running` : html`${I.rerun()} Re-run`}</button></td>
              </tr>`;
            }))];
          })}
          ${!groups.length && html`<tr><td colspan="7" class="empty">${rows.length ? "No cases match these filters." : LIVE.has(run.status) ? "Results appear here as they're graded." : "This run has no results."}</td></tr>`}
        </tbody></table></div>`}
    ${selRow && html`<div class="scrim" onClick=${() => setSel(null)}></div>
      <aside class="over" role="dialog" aria-label=${`Case ${selRow.id}`}>
        <div class="over-h"><b class="mono">${selRow.id}</b><span class="mut">${runLabel(run)}</span><span class="grow"></span>
          <button class="btn ghost" onClick=${() => step(-1)} aria-label="Previous case">↑</button><button class="btn ghost" onClick=${() => step(1)} aria-label="Next case">↓</button>
          <button class="btn ghost" onClick=${() => setSel(null)} aria-label="Close">${I.close()}</button></div>
        <div class="over-b"><${Detail} c=${caseById[selRow.id] || selRow.c} rs=${selRow.rs} rr=${selRow.rr} run=${run}
          canRerun=${canRerun && !!caseById[selRow.id] && runnable(caseById[selRow.id])} rerunning=${rerunId === selRow.id} onRerun=${() => rerun(selRow.id)}
          onEdit=${() => (caseById[selRow.id] ? openCase(caseById[selRow.id]) : toast("That case was deleted from the test set."))}
          onTry=${() => tryInPlayground(selRow.c.persona, selRow.c.question)} /></div>
      </aside>`}
  </main>`;
}

// ------------------------------------------------------------------ test set view
function Confirm({ text, yes, onYes, onNo }) {
  return html`<div class="confirm" role="alert"><span>${text}</span><span class="grow"></span><button class="btn sm" onClick=${onNo}>Keep</button><button class="btn sm danger solid" onClick=${onYes}>${yes}</button></div>`;
}

function Menu({ children, label }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const off = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("click", off);
    return () => document.removeEventListener("click", off);
  }, [open]);
  useEscape(useCallback(() => setOpen(false), []), open);
  return html`<div class="menu" ref=${ref}><button class="btn sm" aria-expanded=${open} aria-label=${label} onClick=${() => setOpen(!open)}>${I.more()} More</button>
    ${open && html`<div class="menu-list" role="menu" onClick=${() => setOpen(false)}>${children}</div>`}</div>`;
}

function SetView({ info, cases, personas, columns, regionOf, active, refresh, openCase, openPersona, rerun, toast }) {
  const [tab, setTab] = useState("cases");
  const [q, setQ] = useState("");
  const [cf, setCf] = useState("all");
  const [sel, setSel] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState("");
  const [modal, setModal] = useState(null);
  useEffect(() => { setConfirm(false); setErr(""); }, [sel, tab]);
  const used = useMemo(() => cases.reduce((m, c) => (m[c.persona] = (m[c.persona] || 0) + 1, m), {}), [cases]);
  const ql = q.trim().toLowerCase();
  const edited = cases.filter((c) => c._edited).length;
  const caseList = cases.filter((c) => (cf === "all" || (cf === "ready" ? c.status === "ready" : cf === "draft" ? c.status !== "ready" : cf === "review" ? !!c.review : (c.issues || []).length > 0))
    && (!ql || [c.id, c.question, c.category, c.persona, c.tests].join(" ").toLowerCase().includes(ql)));
  const persList = personas.filter((p) => !ql || Object.values(p).join(" ").toLowerCase().includes(ql));
  const selCase = tab === "cases" && cases.find((c) => c.id === sel);
  const selPers = tab === "personas" && personas.find((p) => p.USERLOGIN === sel);
  const del = async () => {
    try {
      if (selCase) await api(`cases/${encodeURIComponent(selCase.id)}`, { method: "DELETE" });
      else await api(`personas/${encodeURIComponent(selPers.USERLOGIN)}`, { method: "DELETE" });
      toast(`Deleted ${sel}. It's still in the version history.`); setSel(null); await refresh();
    } catch (e) { setErr(e.message); setConfirm(false); }
  };
  const kb = (p) => { const r = regionOf(p); return r ? html`<span class="kb">${r}</span>` : html`<span class="kb none">no KB</span>`; };
  const casePanel = selCase && html`<div class="ts-ed">
    <div class="acts"><b class="mono">${selCase.id}</b><${Marker} c=${selCase} /><span class="chip">${selCase.status}</span><span class="grow"></span><button class="btn ghost sm" onClick=${() => setSel(null)} aria-label="Close">${I.close()}</button></div>
    ${selCase.review && html`<div class=${`banner ${selCase.review.kind === "add" ? "warn" : "info"}`}><b>${selCase.review.kind === "add" ? "Add" : "Check"}:</b> ${selCase.review.note || "(no note)"}</div>`}
    ${(selCase.issues || []).length > 0 && html`<div class="banner err">Won't run until fixed: ${selCase.issues.join("; ")}</div>`}
    <div class="det-q" style="font-size:15px">${selCase.question}</div>
    <dl class="kv">
      <dt>persona</dt><dd>${selCase.persona}</dd><dt>category</dt><dd>${selCase.category || "—"}</dd><dt>tests</dt><dd>${selCase.tests || "—"}</dd>
      <dt>expected</dt><dd>${lines(selCase.expected).map((x) => `• ${x}`).join("\n") || "—"}</dd>
      <dt>must not</dt><dd>${lines(selCase.must_not).map((x) => `• ${x}`).join("\n") || "—"}</dd>
      <dt>sources</dt><dd>${selCase.sources || "no rule"}</dd><dt>threshold</dt><dd>${selCase.threshold ?? `${info.default_threshold} (default)`}</dd>
      ${selCase.notes && html`<dt>notes</dt><dd>${selCase.notes}</dd>`}
      ${selCase._updated_by && html`<dt>changed</dt><dd>${fmtTime(selCase._updated_at)} by ${selCase._updated_by}${selCase._edited ? " · in the app" : ""}</dd>`}
    </dl>
    ${err && html`<div class="banner err">${err}</div>`}
    ${confirm ? html`<${Confirm} text=${`Delete ${selCase.id}?`} yes="Delete" onYes=${del} onNo=${() => setConfirm(false)} />`
      : html`<div class="acts"><button class="btn pri" onClick=${() => openCase(selCase)}>Edit</button>
        <button class="btn" disabled=${!runnable(selCase) || !!active} onClick=${() => rerun(selCase.id)} title=${!runnable(selCase) ? "Only ready cases without issues run" : active ? "Waiting for the current run" : ""}>${I.rerun()} Run it</button>
        <span class="grow"></span><button class="btn ghost danger" onClick=${() => setConfirm(true)} aria-label="Delete">${I.trash()}</button></div>`}
  </div>`;
  const persPanel = selPers && html`<div class="ts-ed">
    <div class="acts"><b class="mono">${selPers.USERLOGIN}</b>${kb(selPers)}<span class="grow"></span><button class="btn ghost sm" onClick=${() => setSel(null)} aria-label="Close">${I.close()}</button></div>
    ${selPers.purpose && html`<div class="ts-note">${selPers.purpose}</div>`}
    <dl class="kv">${columns.filter((k) => k !== "USERLOGIN" && k !== "purpose" && selPers[k]).map((k) => html`<dt>${k}</dt><dd>${selPers[k]}</dd>`)}</dl>
    <div class="ts-note">${used[selPers.USERLOGIN] ? `${pl(used[selPers.USERLOGIN], "case")} ask as this persona.` : "No cases use this persona yet."}</div>
    ${err && html`<div class="banner err">${err}</div>`}
    ${confirm ? html`<${Confirm} text=${`Delete ${selPers.USERLOGIN}?`} yes="Delete" onYes=${del} onNo=${() => setConfirm(false)} />`
      : html`<div class="acts"><button class="btn pri" onClick=${() => openPersona(selPers)}>Edit</button><button class="btn" onClick=${() => openCase(null, selPers.USERLOGIN)}>${I.plus()} Case as this persona</button>
        <span class="grow"></span><button class="btn ghost danger" onClick=${() => setConfirm(true)} aria-label="Delete">${I.trash()}</button></div>`}
  </div>`;
  return html`<main>
    <div class="setcards" role="tablist" aria-label="Test set">
      ${[["cases", "Cases", cases.length, `${cases.filter((c) => c.status === "ready").length} ready · ${cases.filter((c) => c.review).length} to review`, I.set],
        ["personas", "Personas", personas.length, `${personas.filter((p) => String(p.in_roster || "Y").trim().toUpperCase() !== "N").length} in the roster · ${personas.filter((p) => regionOf(p)).length} with a KB`, I.user]]
        .map(([k, label, n, sub, ic]) => html`<button role="tab" aria-selected=${tab === k} aria-pressed=${tab === k} onClick=${() => { setTab(k); setSel(null); setQ(""); }}>
          <span class="ico">${ic()}</span><b>${label}</b><span class="n">${n}</span><small>${sub}</small></button>`)}
    </div>
    <div class="ts-head">
      <input class="input" type="search" placeholder=${`Search ${tab}`} value=${q} onInput=${(e) => setQ(e.target.value)} aria-label="Search" />
      <span class="grow"></span>
      <button class="btn pri" onClick=${() => openCase(null)}>${I.plus()} New case</button>
      <button class="btn" onClick=${() => openPersona(null)}>${I.user()} New persona</button>
    </div>
    <div class="ts-head" style="gap:8px">
      <span class="ts-note">Test set v${info.test_set_version}${edited ? ` · ${pl(edited, "case")} edited in the app since the last import — export carries them, and the review highlights` : ""}</span>
      <span class="grow"></span>
      <button class="btn sm" disabled=${!!active} title=${active ? "Import after the run finishes" : "Replace the whole set from a workbook; you see the changes first"} onClick=${() => setModal("import")}>Import .xlsx</button>
      <a class="btn sm" href=${`${BASE}/api/export/test-set`}>Export .xlsx</a>
      <${Menu} label="More test-set actions">
        <a role="menuitem" href=${`${BASE}/api/export/test-roster.csv`}>Test roster CSV<small>The Personas sheet as the file the chatbot reads (work order W1)</small></a>
        <a role="menuitem" href=${`${BASE}/api/export/test-roster.csv?resolve_dates=true`}>Test roster CSV, dates resolved<small>-10d written as a date, for a chatbot without relative dates</small></a>
        <button role="menuitem" onClick=${() => setModal("versions")}>Versions<small>Every change to the set; restore any of them</small></button>
      <//>
    </div>
    ${info.test_roster && info.test_roster.error && html`<div class="banner err" role="alert">${info.test_roster.error}. The chatbot keeps the last copy it read, so persona changes since then don't reach it.</div>`}
    ${tab === "cases" && html`<div class="seg" style="align-self:flex-start">${[["all", "All", cases.length], ["ready", "Ready", cases.filter((c) => c.status === "ready").length], ["draft", "Draft & off", cases.filter((c) => c.status !== "ready").length], ["review", "Needs your review", cases.filter((c) => c.review).length], ["issues", "Has issues", cases.filter((c) => (c.issues || []).length).length]].map(([k, l, n]) => html`<button aria-pressed=${cf === k} onClick=${() => setCf(k)}>${l}<span class="n">${n}</span></button>`)}</div>`}
    ${!cases.length && !personas.length ? html`<div class="card empty">No test set yet. Use <b>Import .xlsx</b> with the test-set workbook, or start with <b>New persona</b>.</div>` : html`
    <div class=${`ts-body${selCase || selPers ? "" : " nosel"}`}>
      <div class="tablecard tblwrap">${tab === "cases" ? html`<table class="t"><thead><tr><th>ID</th><th>Status</th><th>Category</th><th>Question</th><th>Persona</th><th>Review</th></tr></thead><tbody>
        ${caseList.map((c) => html`<tr key=${c.id} class=${`row${sel === c.id ? " chosen" : ""}`} tabindex="0" onClick=${() => setSel(c.id)} onKeyDown=${(e) => e.key === "Enter" && setSel(c.id)}>
          <td class="mono">${c.id}</td><td>${c.status === "ready" ? "Ready" : html`<span class="mut">${c.status === "off" ? "Off" : "Draft"}</span>`}</td>
          <td class="mut" style="white-space:nowrap">${c.category}</td><td><span class="q">${c.question}</span></td><td class="mono" style="font-size:12.5px">${c.persona}</td><td><${Marker} c=${c} /></td></tr>`)}
        ${!caseList.length && html`<tr><td colspan="6" class="empty">No cases match.</td></tr>`}</tbody></table>`
      : html`<table class="t"><thead><tr><th>Login</th><th>Purpose</th><th>Where</th><th>Title · type</th><th>Manager</th><th>Roster</th><th>Cases</th></tr></thead><tbody>
        ${persList.map((p) => html`<tr key=${p.USERLOGIN} class=${`row${sel === p.USERLOGIN ? " chosen" : ""}`} tabindex="0" onClick=${() => setSel(p.USERLOGIN)} onKeyDown=${(e) => e.key === "Enter" && setSel(p.USERLOGIN)}>
          <td class="mono">${p.USERLOGIN}</td><td><span class="q">${p.purpose || ""}</span></td><td style="white-space:nowrap">${p.LOCATION || p.COUNTRY || "—"} ${kb(p)}</td>
          <td>${p.BUSINESSTITLE || "—"}<div class="sub">${p.USERTYPE || ""}${p.LOA ? " · on leave" : ""}</div></td><td class="mono" style="font-size:12.5px">${p.MGRLVL1 || "—"}</td>
          <td>${String(p.in_roster || "Y").toUpperCase() === "N" ? html`<span class="mut">No</span>` : "Yes"}</td><td class="num">${used[p.USERLOGIN] || 0}</td></tr>`)}
        ${!persList.length && html`<tr><td colspan="7" class="empty">No personas match.</td></tr>`}</tbody></table>`}</div>
      ${casePanel || persPanel || ""}
    </div>`}
    ${modal === "import" && html`<${ImportModal} onClose=${() => setModal(null)} onDone=${async (r) => { setModal(null); setSel(null); toast(`Imported ${pl(r.cases, "case")} as version ${r.version}.`); await refresh(); }} />`}
    ${modal === "versions" && html`<${VersionsModal} busy=${!!active} onClose=${() => setModal(null)} onRestored=${async (v) => { setModal(null); setSel(null); toast(`Restored — the set is now version ${v}.`); await refresh(); }} />`}
  </main>`;
}

function Modal({ title, onClose, children, foot, narrow = true }) {
  useEscape(onClose);
  return html`<div class="mscrim" onClick=${(e) => e.target === e.currentTarget && onClose()}>
    <div class=${`modal${narrow ? " narrow" : ""}`} role="dialog" aria-modal="true" aria-label=${title}>
      <div class="m-h"><h2>${title}</h2><span class="grow"></span><button class="btn ghost" aria-label="Close" onClick=${onClose}>${I.close()}</button></div>
      <div class="m-b"><div class="m-main">${children}</div></div>
      ${foot && html`<div class="m-f">${foot}</div>`}
    </div></div>`;
}

function ImportModal({ onClose, onDone }) {
  const [prev, setPrev] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const upload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setErr(""); setPrev(null); setBusy(true);
    const form = new FormData();
    form.append("file", file);
    try { setPrev(await api("import/preview", { method: "POST", form })); } catch (x) { setErr(x.message); } finally { setBusy(false); }
  };
  const apply = async () => {
    setBusy(true); setErr("");
    try { onDone(await api("import/apply", { method: "POST", body: { token: prev.token } })); } catch (x) { setErr(x.message); setBusy(false); }
  };
  const d = prev && prev.diff;
  const list = (ids) => (ids.length ? ids.join(", ") : "none");
  return html`<${Modal} title="Import the test set" onClose=${onClose}
      foot=${html`${err && html`<span class="err">${err}</span>`}<span class="grow"></span><button class="btn" onClick=${onClose}>Cancel</button><button class="btn pri" disabled=${!prev || busy} onClick=${apply}>Replace the test set</button>`}>
    <p class="mut" style="margin:0">Importing replaces every case and persona. The current set is kept as a version you can restore.</p>
    <input type="file" accept=".xlsx" onChange=${upload} disabled=${busy} aria-label="Workbook" />
    ${busy && !prev && html`<span class="mut">Reading…</span>`}
    ${d && html`
      <div><b>${prev.file}</b>: ${pl(prev.cases, "case")}, ${pl(prev.personas, "persona")}</div>
      ${d.cases.reverts_in_app_edits.length > 0 && html`<div class="banner warn">This undoes in-app edits to ${d.cases.reverts_in_app_edits.join(", ")}. Export first if you want to keep them.</div>`}
      <dl class="diff">
        <dt>Cases added</dt><dd>${list(d.cases.added)}</dd><dt>Cases removed</dt><dd>${list(d.cases.removed)}</dd>
        <dt>Cases changed</dt><dd>${d.cases.changed.length ? d.cases.changed.map((x) => `${x.id} (${x.fields.join(", ")})`).join("; ") : "none"}</dd>
        <dt>Unchanged</dt><dd>${d.cases.unchanged}</dd>
        <dt>Personas</dt><dd>+${d.personas.added.length} −${d.personas.removed.length} ~${d.personas.changed.length}${d.personas.columns_changed ? " · columns changed" : ""}</dd>
      </dl>
      ${d.issues.length > 0 && html`<div class="banner err"><div><b>${pl(d.issues.length, "case")} won't run until fixed:</b><ul style="margin:6px 0 0;padding-left:18px">${d.issues.map((x) => html`<li>${x.id}: ${x.issues.join("; ")}</li>`)}</ul></div></div>`}
      ${d.warnings.length > 0 && html`<div class="banner info">${d.warnings.join(" · ")}</div>`}`}
  <//>`;
}

function VersionsModal({ onClose, onRestored, busy }) {
  const [vs, setVs] = useState(null);
  const [err, setErr] = useState("");
  const [ask, setAsk] = useState(null);
  useEffect(() => { api("versions").then(setVs).catch((e) => setErr(e.message)); }, []);
  const restore = async (id) => {
    try { const r = await api(`versions/${id}/rollback`, { method: "POST" }); onRestored(r.version); } catch (e) { setErr(e.message); setAsk(null); }
  };
  return html`<${Modal} title="Versions" onClose=${onClose}>
    ${err && html`<div class="banner err">${err}</div>`}
    ${busy && html`<div class="banner warn">A run is in progress; restore after it finishes.</div>`}
    ${!vs ? html`<span class="mut">Loading…</span>` : !vs.versions.length ? html`<div class="empty">No versions yet — import a test set.</div>` : html`<div class="tblwrap"><table class="t">
      <thead><tr><th>#</th><th>When</th><th>Who</th><th>What</th><th>Cases</th><th></th></tr></thead>
      <tbody>${vs.versions.map((v) => html`<tr key=${v.id}>
        <td class="mono">${v.id}${v.id === vs.current ? " · now" : ""}</td><td style="white-space:nowrap">${fmtTime(v.at)}</td><td>${v.by}</td>
        <td>${v.kind}: ${v.note}</td><td class="num">${v.n}</td>
        <td style="white-space:nowrap">${v.id !== vs.current && (ask === v.id
          ? html`<span class="acts"><button class="btn sm" onClick=${() => setAsk(null)}>Keep</button><button class="btn sm pri" onClick=${() => restore(v.id)}>Restore</button></span>`
          : html`<button class="btn sm" disabled=${busy} onClick=${() => setAsk(v.id)}>Restore…</button>`)}</td></tr>`)}</tbody></table></div>`}
  <//>`;
}

// ------------------------------------------------------------------ wizards (F1)
const Field = ({ label, hint, children }) => html`<label class="field">${label}${children}${hint && html`<span class="hint">${hint}</span>`}</label>`;
const Choice = ({ value, set, opts }) => html`<div class="choice">${opts.map(([k, l, s]) => html`<button type="button" aria-pressed=${value === k} onClick=${() => set(k)}>${l}${s && html`<small>${s}</small>`}</button>`)}</div>`;
const LOGIN_OK = /^test-[a-z0-9][a-z0-9-]{0,39}$/i;
const DATE_OK = /^(\d{4}-\d{2}-\d{2}|-\d{1,4}d)$/;
const ID_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function PersonaCard({ p, region }) {
  if (!p) return html`<div class="mut">—</div>`;
  const name = `${p.FIRSTNAME || ""} ${p.LASTNAME || ""}`.trim();
  return html`<div class="persona-card"><b>${name || p.USERLOGIN}</b><span class="mono" style="font-size:12px">${p.USERLOGIN}</span>
    <span class="mut" style="font-size:12.5px">${p.BUSINESSTITLE || "No title"}${p.USERTYPE ? ` · ${p.USERTYPE}` : ""}${p.LOA ? " · on leave" : ""}</span>
    <span style="font-size:12.5px">${p.LOCATION || p.COUNTRY || "No location"} ${region ? html`<span class="kb">${region}</span>` : html`<span class="kb none">no KB</span>`}</span></div>`;
}

function Wizard({ title, steps, step, setStep, side, err, saving, onSave, onClose, saveLabel, canNext }) {
  useEscape(onClose);
  const last = step === steps.length - 1;
  // no close on a backdrop click: a stray click must not throw away a half-written case
  return html`<div class="mscrim">
    <div class="modal" role="dialog" aria-modal="true" aria-label=${title}>
      <div class="m-h"><h2>${title}</h2><span class="mut" style="font-size:12.5px">Step ${step + 1} of ${steps.length}</span><span class="grow"></span><button class="btn ghost" onClick=${onClose} aria-label="Close">${I.close()}</button></div>
      <div class="steps">${steps.map((s, i) => html`<button type="button" aria-current=${i === step ? "step" : null} class=${i < step ? "done" : ""} onClick=${() => (i < step || canNext(step, i)) && setStep(i)}><i>${i < step ? "✓" : i + 1}</i>${s.t}</button>`)}</div>
      <div class="m-b"><div class="m-main">${steps[step].body}</div><aside class="m-side">${side}</aside></div>
      <div class="m-f">${err && html`<span class="err">${err}</span>`}<span class="grow"></span>
        ${step ? html`<button class="btn" onClick=${() => setStep(step - 1)}>Back</button>` : html`<button class="btn" onClick=${onClose}>Cancel</button>`}
        ${last ? html`<button class="btn pri" disabled=${saving} onClick=${onSave}>${saving ? "Saving…" : saveLabel}</button>` : html`<button class="btn pri" onClick=${() => canNext(step, step + 1) && setStep(step + 1)}>Next</button>`}</div>
    </div></div>`;
}

function ListEditor({ items, set, ph, add }) {
  const rows = items.length ? items : [""];
  const upd = (i, v) => set(rows.map((x, j) => (j === i ? v : x)));
  return html`<div class="plist">${rows.map((v, i) => html`<div class="prow"><span class="n">${i + 1}</span>
      <input class="input" value=${v} placeholder=${ph} onInput=${(e) => upd(i, e.target.value)} aria-label=${`${add} ${i + 1}`}
        onKeyDown=${(e) => { if (e.key === "Enter") { e.preventDefault(); set([...rows, ""]); } }} />
      <button type="button" class="btn ghost sm" onClick=${() => set(rows.length > 1 ? rows.filter((_, j) => j !== i) : [""])} aria-label="Remove">${I.close()}</button></div>`)}
    <button type="button" class="btn sm" style="align-self:flex-start" onClick=${() => set([...rows, ""])}>${I.plus()} Add ${add}</button></div>`;
}

function CaseWizard({ init, info, cases, personas, regionOf, onClose, onSaved }) {
  const editing = !!init.id && cases.some((c) => c.id === init.id);
  const [d, setD] = useState(() => ({ id: "", status: "draft", category: "", tests: "", persona: (personas[0] || {}).USERLOGIN || "", question: "", sources: "", threshold: null, notes: "", review: null, ...init,
    exp: lines(init.expected).length ? lines(init.expected) : ["", ""], mn: lines(init.must_not).length ? lines(init.must_not) : [""] }));
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k) => (v) => { setD((x) => ({ ...x, [k]: v })); setErr(""); };
  const cats = [...new Set(cases.map((c) => c.category).filter(Boolean))].sort();
  const pts = d.exp.filter((x) => x.trim()), mn = d.mn.filter((x) => x.trim());
  const thr = d.threshold ?? info.default_threshold;
  const need = Math.max(1, Math.ceil(thr * pts.length - 1e-9));
  const persona = personas.find((p) => p.USERLOGIN === d.persona);
  const region = persona ? regionOf(persona) : null;
  const check = (from) => {
    if (from === 0 && !d.question.trim()) return "Write the question.";
    if (from === 0 && !d.persona) return "Pick a persona.";
    if (from === 1 && !pts.length && !mn.length && !d.sources) return "Add at least one expected point (or a must-not, or a source rule on the next step).";
    if (from === 3 && !editing && d.id && !ID_OK.test(d.id)) return "An ID may use letters, digits, . _ - only.";
    if (from === 3 && !editing && d.id && cases.some((c) => c.id === d.id)) return `${d.id} already exists.`;
    return "";
  };
  const canNext = (from, to) => { for (let s = from; s < to; s++) { const e = check(s); if (e) { setErr(e); setStep(s); return false; } } return true; };
  const save = async () => {
    for (let s = 0; s < 4; s++) { const e = check(s); if (e) { setErr(e); setStep(s); return; } }
    setSaving(true); setErr("");
    const body = { id: d.id, status: d.status, category: d.category.trim(), tests: d.tests.trim(), persona: d.persona, question: d.question.trim(),
      expected: pts.join("\n"), must_not: mn.join("\n"), sources: d.sources, threshold: d.threshold, notes: d.notes, review: d.review && d.review.kind ? d.review : null };
    try {
      const saved = editing ? await api(`cases/${encodeURIComponent(init.id)}`, { method: "PUT", body }) : await api("cases", { method: "POST", body });
      onSaved(saved, editing);
    } catch (e) { setErr(e.message); setSaving(false); }
  };
  const steps = [
    { t: "Question", body: html`<div class="sec"><h3>What is asked, and by whom</h3><p>The persona sets the region, profile and manager chain the chatbot sees.</p>
      <${Field} label="Question"><textarea class="input" rows="3" value=${d.question} onInput=${(e) => set("question")(e.target.value)} placeholder="How many sick days do I get?"></textarea><//>
      <div class="fgrid" style="margin-top:12px">
        <${Field} label="Persona" hint=${html`Knowledge base: <b>${region || "none"}</b>`}><select class="input" value=${d.persona} onChange=${(e) => set("persona")(e.target.value)}>
          ${!persona && html`<option value=${d.persona}>${d.persona || "—"}</option>`}${personas.map((p) => html`<option value=${p.USERLOGIN}>${p.USERLOGIN}</option>`)}</select><//>
        <${Field} label="Category"><input class="input" list="tdash-cats" value=${d.category} onInput=${(e) => set("category")(e.target.value)} placeholder="Time off" /><datalist id="tdash-cats">${cats.map((c) => html`<option value=${c} />`)}</datalist><//>
        <${Field} label="What this tests"><input class="input" value=${d.tests} onInput=${(e) => set("tests")(e.target.value)} placeholder="Provincial awareness: BC sick days" /><//>
      </div></div>` },
    { t: "Expected", body: html`<div class="sec"><h3>What a right answer says</h3><p>One point per line, each checkable on its own. The judge marks each covered, missing or contradicted. Enter adds a line.</p>
        <${ListEditor} items=${d.exp} set=${set("exp")} ph="States they get 5 paid sick days a year" add="a point" /></div>
      <div class="sec"><h3>What it must never say</h3><p>Saying any of these fails the case outright.</p><${ListEditor} items=${d.mn} set=${set("mn")} ph="Gives the Ontario number" add="one" /></div>` },
    { t: "Grading", body: html`<div class="sec"><h3>Sources</h3><${Choice} value=${d.sources} set=${set("sources")} opts=${[["", "Either", "No rule about citations"], ["cite", "Must cite", "Fails without a document"], ["none", "Must not cite", "e.g. small talk, refusals"]]} /></div>
      <div class="sec"><h3>Pass mark</h3><p>The share of expected points it must cover. ${d.threshold == null ? `Using the default, ${info.default_threshold}.` : ""}</p>
        <div class="range"><input type="range" min="0.25" max="1" step="0.05" value=${thr} onInput=${(e) => set("threshold")(Number(e.target.value))} aria-label="Pass mark" /><b>${thr.toFixed(2)}</b>
          ${d.threshold != null && html`<button type="button" class="btn sm ghost" onClick=${() => set("threshold")(null)}>Use default</button>`}</div>
        <div class="hint" style="margin-top:6px">${pts.length ? html`With ${pl(pts.length, "point")}: needs <b>${need}</b> covered.` : "Add expected points to see what this means."}</div></div>
      <div class="sec"><h3>Status</h3><${Choice} value=${d.status} set=${set("status")} opts=${[["draft", "Draft", "Saved, not run"], ["ready", "Ready", "Runs from the next run"], ["off", "Off", "Kept, never run"]]} /></div>` },
    { t: "Review", body: html`<div class="sec"><h3>Notes and review</h3><p>A review marker exports as a coloured cell with your note, so HR sees what to fill in.</p>
        <${Choice} value=${(d.review && d.review.kind) || ""} set=${(k) => set("review")(k ? { kind: k, note: (d.review && d.review.note) || "", col: (d.review && d.review.col) || "expected" } : null)}
          opts=${[["", "No marker", ""], ["add", "Add", "Information is missing"], ["check", "Check", "Verify a guess"]]} />
        ${d.review && html`<div style="margin-top:10px"><${Field} label="What to add or check"><input class="input" value=${d.review.note} onInput=${(e) => set("review")({ ...d.review, note: e.target.value })} /><//></div>`}
        <div style="margin-top:12px"><${Field} label="Notes"><textarea class="input" rows="2" value=${d.notes} onInput=${(e) => set("notes")(e.target.value)}></textarea><//></div>
        ${!editing && html`<div style="margin-top:12px"><${Field} label="ID" hint="Blank takes the next free TC- number."><input class="input" value=${d.id} onInput=${(e) => set("id")(e.target.value.trim())} placeholder="TC-…" spellcheck="false" /><//></div>`}</div>` },
  ];
  const side = html`<h4>How it will be graded</h4><div class="preview">
      <div class="rule">${I.pass()}<span>${pts.length ? html`Covers at least <b>${need} of ${pts.length}</b> expected ${pts.length === 1 ? "point" : "points"}` : html`<span class="mut">No expected points</span>`}</span></div>
      ${pts.length > 0 && html`<div class="rule">${I.pass()}<span>Contradicts none of them</span></div>`}
      ${mn.length > 0 && html`<div class="rule x">${I.fail()}<span>Says none of: ${mn.map((m) => `“${m}”`).join(", ")}</span></div>`}
      ${d.sources === "cite" && html`<div class="rule">${I.pass()}<span>Cites a document</span></div>`}${d.sources === "none" && html`<div class="rule">${I.pass()}<span>Cites nothing</span></div>`}
      <div class="rule">${I.pass()}<span>${region ? html`Every document is from <span class="kb">${region}</span>` : "Uses no knowledge-base document (this persona has none)"}</span></div>
      ${d.status !== "ready" && html`<div class="rule x">${I.info()}<span>${d.status === "off" ? "Off" : "A draft"}: not run until it's marked Ready</span></div>`}
    </div><h4 style="margin-top:8px">Asked as</h4><${PersonaCard} p=${persona} region=${region} />`;
  return html`<${Wizard} title=${editing ? `Edit ${init.id}` : "New test case"} steps=${steps} step=${step} setStep=${(s) => { setErr(""); setStep(s); }} side=${side}
    err=${err} saving=${saving} onSave=${save} onClose=${onClose} saveLabel=${editing ? "Save case" : "Create case"} canNext=${canNext} />`;
}

const PERSONA_FIELDS = new Set(["USERLOGIN", "purpose", "FIRSTNAME", "LASTNAME", "COUNTRY", "STATE", "LOCATION", "BUSINESSTITLE", "DEPARTMENT", "USERTYPE", "HIREDATE", "REHIREDATE", "LOA", "MGRLVL1", "MGRLVL2", "MANAGERLOGIN", "in_roster"]);

function PersonaWizard({ init, columns, personas, regionOf, regions, onClose, onSaved }) {
  const editing = !!init && personas.some((p) => p.USERLOGIN === init.USERLOGIN);
  const [d, setD] = useState(() => ({ ...Object.fromEntries(columns.map((c) => [c, ""])), USERLOGIN: "test-", COUNTRY: "CA", USERTYPE: "Full-Time", HIREDATE: "-365d", in_roster: "Y", ...(init || {}) }));
  const [step, setStep] = useState(0);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k) => (v) => { setD((x) => ({ ...x, [k]: v })); setErr(""); };
  const others = personas.filter((p) => p.USERLOGIN !== d.USERLOGIN);
  const mgr = personas.find((p) => p.USERLOGIN === d.MGRLVL1);
  const row = { ...d, MANAGERLOGIN: d.MGRLVL1, MGRLVL2: mgr ? mgr.MGRLVL1 || "" : d.MGRLVL1 ? d.MGRLVL2 : "" };
  const region = regionOf(row);
  const seen = (k) => [...new Set(personas.filter((p) => p.COUNTRY === d.COUNTRY).map((p) => p[k]).filter(Boolean))].sort();
  const known = Object.keys(regions);
  const check = (from) => {
    if (from === 0 && !LOGIN_OK.test(d.USERLOGIN)) return "The login must start test- and use letters, digits and - only.";
    if (from === 0 && !editing && personas.some((p) => p.USERLOGIN === d.USERLOGIN)) return `${d.USERLOGIN} already exists.`;
    if (from === 2 && d.HIREDATE && !DATE_OK.test(d.HIREDATE)) return "Hired is a date (2021-03-15) or days ago (-30d).";
    if (from === 2 && d.REHIREDATE && !DATE_OK.test(d.REHIREDATE)) return "Rehired is a date (2024-01-08) or days ago (-10d).";
    return "";
  };
  const canNext = (from, to) => { for (let s = from; s < to; s++) { const e = check(s); if (e) { setErr(e); setStep(s); return false; } } return true; };
  const save = async () => {
    for (let s = 0; s < 5; s++) { const e = check(s); if (e) { setErr(e); setStep(s); return; } }
    setSaving(true); setErr("");
    const body = Object.fromEntries(columns.map((c) => [c, String(row[c] ?? "").trim()]));
    if (columns.includes("EMAIL") && !body.EMAIL) body.EMAIL = `${body.USERLOGIN}@fortinet.com`;
    try {
      const saved = editing ? await api(`personas/${encodeURIComponent(init.USERLOGIN)}`, { method: "PUT", body }) : await api("personas", { method: "POST", body });
      onSaved(saved, editing);
    } catch (e) { setErr(e.message); setSaving(false); }
  };
  const extra = columns.filter((c) => !PERSONA_FIELDS.has(c));
  const country = d.COUNTRY.toUpperCase();
  const steps = [
    { t: "Who", body: html`<div class="sec"><h3>Who they are</h3><p>Test logins start <span class="mono">test-</span>, so they can never be a real employee.</p>
      <div class="fgrid">
        <${Field} label="Login" hint=${editing ? "A login can't be renamed; add a new persona instead." : "letters, digits and - only"}><input class="input mono" value=${d.USERLOGIN} disabled=${editing} spellcheck="false" onInput=${(e) => set("USERLOGIN")(e.target.value.trim())} /><//>
        <${Field} label="First name"><input class="input" value=${d.FIRSTNAME || ""} onInput=${(e) => set("FIRSTNAME")(e.target.value)} placeholder="Nadia" /><//>
        <${Field} label="Last name"><input class="input" value=${d.LASTNAME || ""} onInput=${(e) => set("LASTNAME")(e.target.value)} placeholder="Test" /><//>
      </div>
      <div style="margin-top:12px"><${Field} label="Why this persona exists"><input class="input" value=${d.purpose || ""} onInput=${(e) => set("purpose")(e.target.value)} placeholder="New Brunswick employee: NB holidays" /><//></div></div>` },
    { t: "Where", body: html`<div class="sec"><h3>Where they work</h3><p>The country picks the knowledge base the chatbot searches.</p>
      <${Choice} value=${["CA", "US", "JP"].includes(country) ? country : "other"} set=${(k) => { set("COUNTRY")(k === "other" ? "" : k); setD((x) => ({ ...x, COUNTRY: k === "other" ? "" : k, STATE: "", LOCATION: "" })); }}
        opts=${[["CA", "Canada", "hrcanada"], ["US", "United States", "hrus (empty today)"], ["JP", "Japan", "no knowledge base"], ["other", "Elsewhere", "type the code"]]} />
      ${!["CA", "US", "JP"].includes(country) && html`<div style="margin-top:12px"><${Field} label="Country code" hint=${country ? (regions[country] ? `Knowledge base: ${regions[country]}` : "No knowledge base for this country") : `ISO-2, e.g. FR, BR. ${known.length} codes have a knowledge base.`}>
        <input class="input mono" value=${d.COUNTRY} maxlength="8" onInput=${(e) => set("COUNTRY")(e.target.value.toUpperCase())} /><//></div>`}
      <div class="fgrid" style="margin-top:12px">
        <${Field} label="Province / state"><input class="input" list="tdash-states" value=${d.STATE || ""} onInput=${(e) => set("STATE")(e.target.value)} /><datalist id="tdash-states">${seen("STATE").map((s) => html`<option value=${s} />`)}</datalist><//>
        <${Field} label="Location"><input class="input" list="tdash-locs" value=${d.LOCATION || ""} onInput=${(e) => set("LOCATION")(e.target.value)} placeholder="Canada - Remote" /><datalist id="tdash-locs">${seen("LOCATION").map((s) => html`<option value=${s} />`)}</datalist><//>
      </div></div>` },
    { t: "Job", body: html`<div class="sec"><h3>Their job</h3>
      <div class="fgrid"><${Field} label="Title"><input class="input" value=${d.BUSINESSTITLE || ""} onInput=${(e) => set("BUSINESSTITLE")(e.target.value)} placeholder="Technical Support Engineer" /><//>
        <${Field} label="Department"><input class="input" value=${d.DEPARTMENT || ""} onInput=${(e) => set("DEPARTMENT")(e.target.value)} placeholder="TAC" /><//></div>
      <div style="margin-top:12px"><${Choice} value=${d.USERTYPE} set=${set("USERTYPE")} opts=${[["Full-Time", "Full-time", "Benefits eligible"], ["Contractor", "Contractor", "Not benefits eligible"]]} /></div>
      <div class="fgrid" style="margin-top:12px">
        <${Field} label="Hired" hint=${html`<span class="mono">-30d</span> = 30 days before today, so they never age out; or a date like 2021-03-15`}><input class="input mono" value=${d.HIREDATE || ""} onInput=${(e) => set("HIREDATE")(e.target.value.trim())} /><//>
        <${Field} label="Rehired (optional)"><input class="input mono" value=${d.REHIREDATE || ""} onInput=${(e) => set("REHIREDATE")(e.target.value.trim())} placeholder="-10d" /><//>
      </div>
      <label class="toggle" style="margin-top:12px"><input type="checkbox" checked=${!!d.LOA} onChange=${(e) => set("LOA")(e.target.checked ? "LOA" : "")} /> On leave of absence</label></div>` },
    { t: "Manager", body: html`<div class="sec"><h3>Who they report to</h3><p>Only other test personas. The skip-level follows from the manager.</p>
      <${Field} label="Manager" hint=${mgr ? html`Skip-level: <span class="mono">${mgr.MGRLVL1 || "none"}</span>` : ""}><select class="input" value=${d.MGRLVL1 || ""} onChange=${(e) => set("MGRLVL1")(e.target.value)}>
        <option value="">No manager</option>${others.map((p) => html`<option value=${p.USERLOGIN}>${p.USERLOGIN}${p.BUSINESSTITLE ? ` — ${p.BUSINESSTITLE}` : ""}</option>`)}</select><//>
      <label class="toggle" style="margin-top:14px"><input type="checkbox" checked=${String(d.in_roster).toUpperCase() !== "N"} onChange=${(e) => set("in_roster")(e.target.checked ? "Y" : "N")} /> In the test roster</label>
      <span class="hint">Untick only to test what happens to someone the chatbot can't find.</span></div>` },
    { t: "Review", body: html`<div class="sec"><h3>Check it</h3><p>This is the row the chatbot's test roster will carry.${extra.length ? " The other columns are editable here." : ""}</p>
      <dl class="kv">${columns.filter((k) => PERSONA_FIELDS.has(k)).map((k) => html`<dt>${k}</dt><dd>${String(row[k] ?? "") || "—"}</dd>`)}</dl>
      ${extra.length > 0 && html`<div class="fgrid" style="margin-top:14px">${extra.map((k) => html`<${Field} label=${k} hint=${k === "EMAIL" ? "Blank: login@fortinet.com" : ""}><input class="input" value=${d[k] || ""} onInput=${(e) => set(k)(e.target.value)} /><//>`)}</div>`}</div>` },
  ];
  const side = html`<h4>Preview</h4><${PersonaCard} p=${row} region=${region} />
    <div class="preview" style="margin-top:6px">
      <div class="rule">${I.pass()}<span>${region ? html`Searches <span class="kb">${region}</span>` : "Searches no knowledge base"}</span></div>
      <div class="rule">${I.pass()}<span>${String(d.in_roster).toUpperCase() !== "N" ? "In the test roster" : "Left out of the roster (roster-miss test)"}</span></div>
      ${d.MGRLVL1 && html`<div class="rule">${I.pass()}<span>Reports to <span class="mono">${d.MGRLVL1}</span></span></div>`}
    </div>`;
  return html`<${Wizard} title=${editing ? `Edit ${init.USERLOGIN}` : "New persona"} steps=${steps} step=${step} setStep=${(s) => { setErr(""); setStep(s); }} side=${side}
    err=${err} saving=${saving} onSave=${save} onClose=${onClose} saveLabel=${editing ? "Save persona" : "Create persona"} canNext=${canNext} />`;
}

// ------------------------------------------------------------------ playground (Y2 banner, C1 messenger)
const isNo = (v) => String(v || "").trim().toUpperCase() === "N";
// days since a hire date: "2021-03-04", or "-10d" meaning ten days ago
function daysSince(v) {
  const m = /^-(\d+)d$/.exec(String(v || "").trim());
  if (m) return Number(m[1]);
  const d = v ? new Date(v) : null;
  return d && !isNaN(d) ? Math.round((Date.now() - d.getTime()) / 864e5) : null;
}
const tenure = (d) => (d < 60 ? pl(d, "day") : d < 365 ? pl(Math.round(d / 30), "month") : `${Math.floor(d / 365)} y ${Math.floor((d % 365) / 30)} m`);
const PLABEL = { USERLOGIN: "Login", FIRSTNAME: "First name", LASTNAME: "Last name", PREFERREDNAME: "Preferred name", EMAIL: "Email", EMPNO: "Employee no.",
  BUSINESSTITLE: "Title", USERTYPE: "Type", DEPARTMENT: "Department", BUSINESSUNIT: "Business unit", DIVISION: "Division", COUNTRY: "Country", STATE: "Province / state",
  LOCATION: "Location", in_roster: "In the roster", HIREDATE: "Hired", REHIREDATE: "Rehired", LOA: "Leave", MANAGERLOGIN: "Manager login", MGRLVL1: "Manager", MGRLVL2: "Skip-level" };
const MONO_F = new Set(["USERLOGIN", "EMAIL", "EMPNO", "HIREDATE", "REHIREDATE", "MANAGERLOGIN", "MGRLVL1", "MGRLVL2"]);
const PGROUPS = [["Who", ["USERLOGIN", "FIRSTNAME", "LASTNAME", "PREFERREDNAME", "EMAIL", "EMPNO"]], ["Work", ["BUSINESSTITLE", "USERTYPE", "DEPARTMENT", "BUSINESSUNIT", "DIVISION"]],
  ["Where", ["COUNTRY", "STATE", "LOCATION", "in_roster"]], ["Dates", ["HIREDATE", "REHIREDATE", "LOA"]], ["Reports to", ["MANAGERLOGIN", "MGRLVL1", "MGRLVL2"]]];

function PersonaBanner({ p, persona, personas, regionOf, onPick, onClear }) {
  const [more, setMore] = useState(false);
  if (!p) return html`<div class="pbanner"><div class="r1"><b>${personas.length ? `Unknown persona ${persona}` : "No personas yet"}</b>
    ${personas.length > 0 && html`<select class="input" value=${persona} onChange=${(e) => onPick(e.target.value)} aria-label="Persona">${personas.map((x) => html`<option value=${x.USERLOGIN}>${x.USERLOGIN}</option>`)}</select>`}
    ${!personas.length && html`<span class="mut">Add one in Test set first.</span>`}</div></div>`;
  const name = `${p.FIRSTNAME || ""} ${p.LASTNAME || ""}`.trim();
  const kb = regionOf(p), h = daysSince(p.REHIREDATE || p.HIREDATE), reports = personas.filter((x) => x.MGRLVL1 === p.USERLOGIN).length;
  const known = new Set(PGROUPS.flatMap(([, ks]) => ks).concat("purpose"));
  const rest = Object.keys(p).filter((k) => !known.has(k) && !k.startsWith("_") && p[k] !== "" && p[k] != null);
  const groups = [...PGROUPS, ...(rest.length ? [["Other", rest]] : [])];
  return html`<div class="pbanner">
    <div class="r1"><span class="av">${((p.FIRSTNAME || p.USERLOGIN.slice(5))[0] || "") + ((p.LASTNAME || "")[0] || "")}</span>${name && html`<b>${name}</b>`}<span class="mono">${p.USERLOGIN}</span>
      <select class="input" value=${persona} onChange=${(e) => onPick(e.target.value)} aria-label="Persona">${personas.map((x) => html`<option value=${x.USERLOGIN}>${x.USERLOGIN}</option>`)}</select>
      <span class="more">${onClear && html`<button class="btn sm ghost" onClick=${onClear} title="Start a fresh conversation as this persona">Clear</button>`}
        <button class="btn sm" aria-expanded=${more} onClick=${() => setMore(!more)}>${more ? "Hide details" : "All details"}</button></span></div>
    <div class="chips">
      ${kb ? html`<span class="fc kb">KB <b class="mono">${kb}</b></span>` : html`<span class="fc warn">No knowledge base</span>`}
      ${isNo(p.in_roster) && html`<span class="fc bad">Not in the roster</span>`}
      ${p.BUSINESSTITLE && html`<span class="fc">${p.BUSINESSTITLE}</span>`}
      ${(p.LOCATION || p.COUNTRY) && html`<span class="fc">${p.LOCATION || p.COUNTRY}${p.STATE ? ` · ${p.STATE}` : ""}</span>`}
      ${p.USERTYPE && html`<span class=${`fc${/contract/i.test(p.USERTYPE) ? " warn" : ""}`}>${p.USERTYPE}</span>`}
      ${h != null && h >= 0 && html`<span class=${`fc${h <= 30 ? " good" : ""}`}>${h <= 30 ? "New hire · " : ""}${p.REHIREDATE ? "rehired " : ""}${tenure(h)}</span>`}
      ${p.LOA && html`<span class="fc warn">On leave</span>`}
      ${reports > 0 && html`<span class="fc">Manages <b>${reports}</b></span>`}
    </div>
    ${more && html`<div class="drawer">${p.purpose && html`<div class="fgroup" style="grid-column:1/-1"><h5>Purpose</h5><div style="font-size:13px">${p.purpose}</div></div>`}
      ${groups.map(([title, ks]) => html`<div class="fgroup"><h5>${title}</h5><dl>${ks.map((k) => html`<dt title=${k}>${PLABEL[k] || k}</dt><dd class=${MONO_F.has(k) && p[k] ? "mono" : ""}>${k === "in_roster" ? (isNo(p[k]) ? "No" : "Yes") : p[k] || html`<span class="faint">—</span>`}</dd>`)}</dl></div>`)}</div>`}
  </div>`;
}

// "[1]" in an answer becomes a small citation mark; a trailing References block is dropped when the sources are listed
function answerBody(m) {
  const t = m.sources && m.sources.length ? m.text.split(/\n\s*References\s*\n/)[0] : m.text;
  return t.split(/(\[\d+\])/).map((x) => (/^\[\d+\]$/.test(x) ? html`<span class="cite">${x.slice(1, -1)}</span>` : x));
}

function Playground({ info, personas, regionOf, preset, clearPreset }) {
  const [persona, setPersona] = useState(() => (personas[0] || {}).USERLOGIN || "");
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const box = useRef(null), list = useRef(null), input = useRef(null), turn = useRef(0);
  // the message box grows with what's typed, and shrinks back when it's sent or replaced
  useLayoutEffect(() => { const el = input.current; if (el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight}px`; } }, [text]);
  useEffect(() => { if (!personas.some((p) => p.USERLOGIN === persona) && personas.length) setPersona(personas[0].USERLOGIN); }, [personas]);
  // a new persona, or a case brought over from the results, starts a fresh conversation
  const pick = (login) => { if (login !== persona) { setPersona(login); setMsgs([]); setSending(false); turn.current++; } };
  useEffect(() => {
    if (!preset) return;
    setPersona(preset.persona); setMsgs([]); setSending(false); turn.current++;
    setText(preset.text); clearPreset();
    setTimeout(() => input.current && input.current.focus(), 0);
  }, [preset]);
  // The chat fills the window down to its bottom edge; the messages scroll inside it.
  const fit = useCallback(() => {
    if (box.current) box.current.style.height = `${Math.max(420, window.innerHeight - box.current.getBoundingClientRect().top - window.scrollY - 20)}px`;
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, []);
  useLayoutEffect(fit, [msgs, sending, persona]);
  useEffect(() => { window.addEventListener("resize", fit); return () => window.removeEventListener("resize", fit); }, []);
  const p = personas.find((x) => x.USERLOGIN === persona);
  const kb = p ? regionOf(p) : null;
  const send = async () => {
    const say = text.trim();
    if (!say || sending || !p) return;
    const mine = turn.current;
    setSending(true);
    const history = msgs.filter((m) => !m.error).map((m) => ({ role: m.role, text: m.text })).slice(-20);
    setMsgs((m) => [...m, { role: "user", text: say }]);
    setText("");
    let reply;
    try {
      const r = await api("playground", { method: "POST", body: { persona, text: say, history } });
      reply = { role: "assistant", text: r.answer, signal: r.signal, sources: r.sources || [], latency: r.latency_ms };
    } catch (e) { reply = { role: "assistant", text: e.message, error: true }; }
    // an answer to a conversation that has since been replaced is dropped
    if (turn.current !== mine) return;
    setMsgs((m) => [...m, reply]); setSending(false);
  };
  const initials = p ? ((p.FIRSTNAME || p.USERLOGIN.slice(5))[0] || "") + ((p.LASTNAME || "")[0] || "") : "?";
  return html`<main class="play">
    ${!info.chatbot.ready && html`<div class="banner err">The chatbot isn't configured (CHATBOT_URL, CHATBOT_TOKEN), so nothing can be asked yet.</div>`}
    <div class="pgw"><section class="chatbox" ref=${box}>
      <${PersonaBanner} p=${p} persona=${persona} personas=${personas} regionOf=${regionOf} onPick=${pick}
        onClear=${msgs.length || sending ? () => { setMsgs([]); setSending(false); turn.current++; } : null} />
      <div class="msgs" ref=${list} aria-live="polite">
        ${!msgs.length && !sending && html`<div class="pg-empty">${I.chat()}<b>Ask as ${p ? `${p.FIRSTNAME || ""} ${p.LASTNAME || ""}`.trim() || p.USERLOGIN : "a persona"}</b>
          ${p && html`<span>The chatbot answers as if <span class="mono">${p.USERLOGIN}</span> asked. Changing persona starts over.</span>`}</div>`}
        ${msgs.map((m, i) => m.role === "user"
          ? html`<div key=${i} class="mrow me"><span class="av">${initials}</span><div class="mstack"><div class="bub">${m.text}</div></div></div>`
          : html`<div key=${i} class="mrow bot"><span class="av bot">HR</span><div class="mstack"><div class=${`bub${m.error ? " error" : ""}`}>${m.error ? m.text : answerBody(m)}</div>
              ${!m.error && html`<div class="mmeta"><span>${fmtMs(m.latency)}</span>${m.signal && html`<span class=${`sig ${m.signal === "ok" ? "ok" : "low"}`}><i></i>${m.signal === "ok" ? "signal ok" : m.signal.replace(/_/g, " ")}</span>`}
                ${m.sources.filter((s) => s.cited).map((s) => html`<span class=${`ref${s.region && kb && s.region !== kb ? " leak" : ""}`} title=${`${s.region || "—"} · ${s.path || s.title || ""}`}>[${s.n}] ${String(s.path || s.title || s.region || "").split("/").pop()}</span>`)}
                ${!m.sources.length && html`<span>no sources</span>`}</div>`}</div></div>`)}
        ${sending && html`<div class="mrow bot"><span class="av bot">HR</span><div class="mstack"><div class="bub"><span class="typing" aria-label="Answering"><i></i><i></i><i></i></span></div></div></div>`}
      </div>
      <div class="compose">
        <textarea rows="1" ref=${input} placeholder=${p ? `Ask as ${p.FIRSTNAME || p.USERLOGIN}…` : "Pick a persona first"} value=${text} aria-label="Message"
          onInput=${(e) => setText(e.target.value)}
          onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } }}></textarea>
        <button class="send" aria-label="Send" disabled=${sending || !text.trim() || !p || !info.chatbot.ready} onClick=${send}>${I.up()}</button>
      </div>
    </section></div>
  </main>`;
}

// ------------------------------------------------------------------ app
function App() {
  const [view, setView] = useState(() => (["tests", "play", "set"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "tests"));
  const [info, setInfo] = useState(null);
  const [cases, setCases] = useState([]);
  const [personas, setPersonas] = useState([]);
  const [columns, setColumns] = useState([]);
  const [runs, setRuns] = useState([]);
  const [latest, setLatest] = useState(null);
  const [active, setActive] = useState(null);
  const [tick, setTick] = useState(0);
  const [modal, setModal] = useState(null);
  const [preset, setPreset] = useState(null);
  const [toastMsg, setToast] = useState("");
  const [err, setErr] = useState("");
  const toastT = useRef(null);
  const toast = useCallback((m) => { setToast(m); clearTimeout(toastT.current); toastT.current = setTimeout(() => setToast(""), 3200); }, []);
  const go = (v) => { setView(v); try { history.replaceState(null, "", `#${v}`); } catch { /* sandboxed */ } };

  const refresh = useCallback(async () => {
    try {
      const [s, c, p, r] = await Promise.all([api("state"), api("cases"), api("personas"), api("runs")]);
      setInfo(s); setCases(c.cases); setPersonas(p.personas); setColumns(p.columns); setRuns(r.runs); setErr("");
      // the header shows the newest complete full run, the same one the next run is compared with
      const full = r.runs.find((x) => isFull(x) && x.status === "done");
      setLatest(full ? await api(`runs/${full.id}`) : null);
      setActive(s.active_run ? await api(`runs/${s.active_run}`) : null);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { refresh(); }, []);
  // While a run is going, follow it; when it ends, reload everything once.
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const s = await api("state");
        if (stop) return;
        if (s.active_run === active.id) setActive(await api(`runs/${active.id}`));
        else { clearInterval(t); await refresh(); setTick((x) => x + 1); }
      } catch (e) { if (!stop) setErr(e.message); }
    }, 1500);
    return () => { stop = true; clearInterval(t); };
  }, [active && active.id]);

  const rerun = useCallback(async (id) => {
    try { await api(`cases/${encodeURIComponent(id)}/rerun`, { method: "POST" }); toast(`Re-running ${id}…`); await refresh(); }
    catch (e) { toast(e.message); }
  }, []);
  const regionOf = useCallback((p) => {
    if (!info || !p) return null;
    if (String(p.in_roster || "Y").trim().toUpperCase() === "N") return null;
    return info.regions[String(p.COUNTRY || "").trim().toUpperCase()] || null;
  }, [info]);
  const rerunId = active && !isFull(active) && (active.params.ids || []).length === 1 ? active.params.ids[0] : null;

  if (!info) return html`<main>${err ? html`<div class="banner err">${err}</div>` : html`<div class="empty">Loading…</div>`}</main>`;
  return html`<div>
    <${Header} view=${view} setView=${go} info=${info} latest=${latest} active=${active} />
    ${err && html`<div style="max-width:1440px;margin:12px auto 0;padding:0 20px"><div class="banner err">${err}<button class="btn sm" onClick=${refresh}>Retry</button></div></div>`}
    ${view === "tests" && html`<${TestsView} info=${info} cases=${cases} runs=${runs} active=${active} tick=${tick} refresh=${refresh} toast=${toast}
      rerun=${rerun} rerunId=${rerunId}
      openCase=${(c) => setModal({ kind: "case", init: c })}
      tryInPlayground=${(persona, text) => { setPreset({ persona, text }); go("play"); }} />`}
    ${view === "play" && html`<${Playground} info=${info} personas=${personas} regionOf=${regionOf} preset=${preset} clearPreset=${() => setPreset(null)} />`}
    ${view === "set" && html`<${SetView} info=${info} cases=${cases} personas=${personas} columns=${columns} regionOf=${regionOf} active=${active} refresh=${refresh} toast=${toast} rerun=${rerun}
      openCase=${(c, persona) => setModal({ kind: "case", init: c || { persona: persona || "" } })}
      openPersona=${(p) => setModal({ kind: "persona", init: p })} />`}
    ${modal && modal.kind === "case" && html`<${CaseWizard} init=${modal.init} info=${info} cases=${cases} personas=${personas} regionOf=${regionOf} onClose=${() => setModal(null)}
      onSaved=${async (c, editing) => { setModal(null); await refresh(); toast(`${editing ? "Saved" : "Created"} ${c.id}${(c.issues || []).length ? ` — won't run until fixed: ${c.issues.join("; ")}` : c.status !== "ready" ? ` as ${c.status === "off" ? "off" : "a draft"}` : ""}.`); }} />`}
    ${modal && modal.kind === "persona" && html`<${PersonaWizard} init=${modal.init} columns=${columns} personas=${personas} regionOf=${regionOf} regions=${info.regions} onClose=${() => setModal(null)}
      onSaved=${async (p, editing) => { setModal(null); await refresh(); toast(`${editing ? "Saved" : "Added"} ${p.USERLOGIN}.`); }} />`}
    ${toastMsg && html`<div class="toast" role="status">${toastMsg}</div>`}
  </div>`;
}

render(html`<${App} />`, document.getElementById("app"));
