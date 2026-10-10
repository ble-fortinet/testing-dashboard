"""Turning a chatbot answer and the judge's verdicts into pass / fail.

Deterministic checks need no model: whether documents were cited as the case requires, and
whether every knowledge-base document came from the persona's own region. A region leak
fails a case whatever the judge says.

Score = covered points ÷ points. A case passes when every check passes, no point is
contradicted, no must_not is hit, and the score reaches its threshold.
"""


def checks(case: dict, expected_region: str | None, sources: list[dict]) -> list[dict]:
    out = []
    want = case.get("sources") or ""
    if want == "cite":
        n = sum(1 for s in sources if s.get("cited"))
        out.append({"check": "cites a document", "passed": n > 0, "detail": "" if n else "no cited document"})
    elif want == "none":
        out.append(
            {
                "check": "cites nothing",
                "passed": not sources,
                "detail": "" if not sources else f"{len(sources)} document(s) returned",
            }
        )
    # Every knowledge-base document must be from the persona's region. Web sources carry no
    # region and are not the knowledge base. A persona with no region must get no KB documents
    # at all. A KB document with no region label is reported, not failed: whether the chatbot
    # always labels them depends on its configuration.
    kb = [s for s in sources if s.get("region") or s.get("tool") == "kb_search"]
    if expected_region is None:
        leaks, unlabelled = kb, []
    else:
        leaks = [s for s in kb if s.get("region") and s["region"] != expected_region]
        unlabelled = [s for s in kb if not s.get("region")]
    name = lambda s: f"{s.get('region') or '?'}::{s.get('path') or s.get('title') or '?'}"  # noqa: E731
    detail = []
    if leaks:
        detail.append("out-of-region: " + ", ".join(name(s) for s in leaks[:3]))
    if unlabelled:
        detail.append(f"{len(unlabelled)} KB document(s) with no region label")
    out.append({"check": "region", "passed": not leaks, "detail": "; ".join(detail)})
    return out


def outcome(points: list[str], must_not: list[str], verdict: dict | None, det: list[dict], threshold: float) -> dict:
    """{status, score, reasons}. `verdict` is None when there was nothing for the judge to grade."""
    reasons = [f"check failed: {c['check']}" for c in det if not c["passed"]]
    score = None
    if verdict is not None:
        vs = verdict["points"]
        if points:
            score = round(sum(1 for v in vs if v == "covered") / len(points), 4)
        n_bad = sum(1 for v in vs if v == "contradicted")
        if n_bad:
            reasons.append(f"{n_bad} point(s) contradicted")
        hits = [m for m, h in zip(must_not, verdict["must_not"], strict=True) if h]
        if hits:
            reasons.append("must_not hit: " + "; ".join(hits))
        if score is not None and score < threshold:
            reasons.append(f"score {score:.2f} below {threshold:.2f}")
    return {"status": "fail" if reasons else "pass", "score": score, "reasons": reasons}
