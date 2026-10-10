"""Overview statistics and the audit summary for a run.

Every number is computed here, in code. The audit's LLM only ranks and rephrases findings
this module has already worded; a rephrasing that carries any number not in the evidence is
discarded in favour of the code's own sentence. The model never computes a statistic.
"""

import json
import math
import re
import statistics
from collections import defaultdict

from tdash import judge as judge_mod
from tdash.workbook import lines

CANT_FIND = re.compile(
    r"(can(?:not|'t|’t)|could(?:n't|n’t| not)|unable to|not able to|do(?:n't|n’t| not) have|did(?:n't|n’t| not)) "
    r"(?:\w+ ){0,3}(?:find|locate|see|access|information)"
    r"|no (?:relevant )?(?:information|documents?|policy|policies) (?:on|about|for|available)"
    r"|(?:isn't|isn’t|is not|aren't|are not) (?:covered|mentioned|included) in",
    re.I,
)
FRENCH = re.compile(
    r"\b(?:je|j'ai|j’ai|mon|ma|mes|vous|votre|vos|est-ce|combien|quel|quelle|quels|quelles|"
    r"pour|avec|dans|une|des|les|du|au|aux|ai-je|suis|êtes|congé|congés|vacances|année|jours|"
    r"politique|employés|travail|donne-moi|toutes|tes|précédentes|aussi|mais|où)\b",
    re.I,
)


def pct(values: list[float], p: float) -> float | None:
    """Nearest-rank percentile."""
    if not values:
        return None
    s = sorted(values)
    k = max(0, min(len(s) - 1, math.ceil(p / 100 * len(s)) - 1))
    return s[k]


def is_french(text: str) -> bool:
    words = re.findall(r"[\w'’-]+", text or "")
    if len(words) < 3:
        return False
    return len(FRENCH.findall(text)) / len(words) >= 0.12


def case_outcomes(results: list[dict]) -> dict[str, str]:
    """Per case across attempts: pass (all graded attempts pass), fail (any fails), error (none graded)."""
    by: dict[str, list[str]] = defaultdict(list)
    for r in results:
        if r.get("phase") is None:
            by[r["case_id"]].append(r["status"])
    out = {}
    for cid, sts in by.items():
        graded = [s for s in sts if s in ("pass", "fail")]
        out[cid] = "error" if not graded else ("fail" if "fail" in graded else "pass")
    return out


def overview(results: list[dict], prev: list[dict] | None = None) -> dict:
    judged = [r for r in results if r.get("phase") is None]
    outcomes = case_outcomes(judged)
    n_pass = sum(1 for o in outcomes.values() if o == "pass")
    n_fail = sum(1 for o in outcomes.values() if o == "fail")
    n_err = sum(1 for o in outcomes.values() if o == "error")
    lat = [r["latency_ms"] for r in judged if r.get("latency_ms") is not None and r["status"] != "error"]
    scores = [r["score"] for r in judged if r.get("score") is not None]
    cats: dict[str, dict] = defaultdict(lambda: {"pass": 0, "fail": 0, "error": 0})
    cat_of = {r["case_id"]: (r.get("case") or {}).get("category") or "—" for r in judged}
    for cid, o in outcomes.items():
        cats[cat_of[cid]][o] += 1
    for c in cats.values():
        graded = c["pass"] + c["fail"]
        c["pass_rate"] = round(c["pass"] / graded, 4) if graded else None
    signals: dict[str, int] = defaultdict(int)
    for r in judged:
        if (r.get("bot") or {}).get("signal"):
            signals[r["bot"]["signal"]] += 1
    flaky = sorted(
        cid
        for cid in outcomes
        if len({r["status"] for r in judged if r["case_id"] == cid and r["status"] in ("pass", "fail")}) > 1
    )
    reg, fixed = [], []
    if prev is not None:
        before = case_outcomes(prev)
        reg = sorted(c for c, o in outcomes.items() if o == "fail" and before.get(c) == "pass")
        fixed = sorted(c for c, o in outcomes.items() if o == "pass" and before.get(c) == "fail")
    return {
        "cases": len(outcomes),
        "passed": n_pass,
        "failed": n_fail,
        "errored": n_err,
        "pass_rate": round(n_pass / (n_pass + n_fail), 4) if n_pass + n_fail else None,
        "latency_p50_ms": pct(lat, 50),
        "latency_p95_ms": pct(lat, 95),
        "score_median": round(statistics.median(scores), 4) if scores else None,
        "by_category": dict(sorted(cats.items())),
        "bot_signals": dict(signals),
        "flaky": flaky,
        "regressions": reg,
        "fixed": fixed,
        "has_baseline": prev is not None,
    }


def pl(n: int, word: str, plural: str | None = None) -> str:
    """'1 case', '3 cases' — findings are read by people."""
    return f"{n} {word if n == 1 else plural or word + 's'}"


def _ids(ids: list[str], n: int = 4) -> str:
    return ", ".join(ids[:n]) + (f" +{len(ids) - n}" if len(ids) > n else "")


def _sec(ms: float) -> str:
    return f"{ms / 1000:.1f} s"


def signals(results: list[dict], ov: dict, probe: list[dict] | None = None) -> list[dict]:
    """Ranked findings, each with its evidence. Lower rank = more important."""
    judged = [r for r in results if r.get("phase") is None]
    outcomes = case_outcomes(judged)
    first = {}
    for r in judged:
        first.setdefault(r["case_id"], r)
    out: list[dict] = []

    def add(kind: str, rank: float, text: str, **evidence) -> None:
        out.append({"id": f"{kind}:{len(out)}", "kind": kind, "rank": rank, "text": text, "evidence": evidence})

    leak = sorted(
        {r["case_id"] for r in judged for c in r.get("checks", []) if c["check"] == "region" and not c["passed"]}
    )
    if leak:
        add(
            "region_leak",
            0,
            f"Region leak: {pl(len(leak), 'case')} {'was' if len(leak) == 1 else 'were'} given another region's documents ({_ids(leak)}).",
            cases=len(leak),
        )
    errs = sorted(c for c, o in outcomes.items() if o == "error")
    if errs:
        add(
            "errors",
            1,
            f"{pl(len(errs), 'case')} never got a usable answer (timeouts, 5xx or judge errors): {_ids(errs)}.",
            cases=len(errs),
        )
    if ov.get("regressions"):
        r = ov["regressions"]
        add(
            "regressions",
            1.5,
            f"Regressions: {pl(len(r), 'case')} passed last run and fail now ({_ids(r)}).",
            cases=len(r),
        )

    # KB gap: a category whose failures mostly retrieved nothing
    by_cat: dict[str, list[str]] = defaultdict(list)
    for cid in outcomes:
        by_cat[(first[cid].get("case") or {}).get("category") or "—"].append(cid)
    for cat, ids in sorted(by_cat.items()):
        fails = [c for c in ids if outcomes[c] == "fail"]
        empty = [c for c in fails if not ((first[c].get("bot") or {}).get("sources"))]
        if len(empty) >= 2 or (empty and len(empty) / len(ids) >= 0.5):
            add(
                "kb_gap",
                2,
                f"{cat}: {len(fails)} of {pl(len(ids), 'case')} failed and {len(empty)} retrieved no documents — likely a knowledge-base gap.",
                category_cases=len(ids),
                failed=len(fails),
                empty=len(empty),
            )
    miss = sorted(
        c
        for c, o in outcomes.items()
        if o == "fail"
        and (first[c].get("bot") or {}).get("sources")
        and CANT_FIND.search((first[c].get("bot") or {}).get("answer") or "")
    )
    if miss:
        add(
            "retrieval_miss",
            3,
            f"{pl(len(miss), 'failing case')} retrieved documents yet answered that it couldn't find the information ({_ids(miss)}).",
            cases=len(miss),
        )
    dis = sorted(c for c, o in outcomes.items() if o == "fail" and (first[c].get("bot") or {}).get("signal") == "ok")
    if dis:
        add(
            "judge_disagreement",
            4,
            f"The chatbot's own judge passed {pl(len(dis), 'answer')} this suite failed ({_ids(dis)}).",
            cases=len(dis),
        )

    # Load sensitivity: within the run, latency against how many requests were in flight
    pairs = [
        (r["in_flight"], r["latency_ms"])
        for r in judged
        if r.get("in_flight") and r.get("latency_ms") is not None and r["status"] != "error"
    ]
    if len(pairs) >= 8 and len({p[0] for p in pairs}) >= 2:
        top = max(p[0] for p in pairs)
        low = [lat for f, lat in pairs if f <= max(1, top // 3)]
        high = [lat for f, lat in pairs if f >= max(2, top - top // 3)]
        if len(low) >= 3 and len(high) >= 3:
            a, b = statistics.median(low), statistics.median(high)
            if a and b / a >= 1.5:
                add(
                    "load",
                    5,
                    f"Latency rises with load: p50 {_sec(a)} at {max(1, top // 3)} or fewer in flight vs {_sec(b)} at {max(2, top - top // 3)}+ (×{b / a:.1f}).",
                    low_ms=a,
                    high_ms=b,
                )
    if probe:
        curve = {}
        for r in probe:
            if r.get("latency_ms") is not None and r["status"] != "error":
                curve.setdefault(r["phase"], []).append(r["latency_ms"])
        if len(curve) >= 2:
            pts = sorted((c, pct(v, 50)) for c, v in curve.items())
            add(
                "load_probe",
                5.5,
                "Load probe p50: " + ", ".join(f"{_sec(v)} at {c} in flight" for c, v in pts) + ".",
                points=len(pts),
            )

    # Slow categories
    lat_all = [r["latency_ms"] for r in judged if r.get("latency_ms") is not None and r["status"] != "error"]
    if len(lat_all) >= 6:
        overall = statistics.median(lat_all)
        cat_lat: dict[str, list[int]] = defaultdict(list)
        for r in judged:
            if r.get("latency_ms") is not None and r["status"] != "error":
                cat_lat[(r.get("case") or {}).get("category") or "—"].append(r["latency_ms"])
        slow = sorted(
            (
                (statistics.median(v), c)
                for c, v in cat_lat.items()
                if len(v) >= 2 and statistics.median(v) >= 1.5 * overall
            ),
            reverse=True,
        )
        if slow:
            m, c = slow[0]
            add(
                "slow",
                6,
                f"Slowest category: {c}, p50 {_sec(m)} vs {_sec(overall)} overall.",
                category_ms=m,
                overall_ms=overall,
            )

    # Verbosity: answer words per expected point, by category
    ratio: dict[str, list[float]] = defaultdict(list)
    for r in judged:
        n = len(lines((r.get("case") or {}).get("expected", "")))
        ans = (r.get("bot") or {}).get("answer") or ""
        body = ans.split("\nReferences", 1)[0]
        if n and body:
            ratio[(r.get("case") or {}).get("category") or "—"].append(len(body.split()) / n)
    allr = [x for v in ratio.values() for x in v]
    if len(allr) >= 6:
        med = statistics.median(allr)
        wordy = sorted(
            (
                (statistics.median(v), c)
                for c, v in ratio.items()
                if len(v) >= 2 and med and statistics.median(v) >= 2 * med
            ),
            reverse=True,
        )
        if wordy:
            m, c = wordy[0]
            add(
                "verbosity",
                7,
                f"Most verbose: {c}, {m:.0f} words per expected point vs {med:.0f} across the set.",
                words=m,
                median=med,
            )

    fr = [r for r in first.values() if is_french((r.get("case") or {}).get("question", ""))]
    en = [r["case_id"] for r in fr if (r.get("bot") or {}).get("answer") and not is_french(r["bot"]["answer"])]
    if en:
        add(
            "language",
            8,
            f"{len(en)} of {pl(len(fr), 'French question')} {'was' if len(en) == 1 else 'were'} answered in English ({_ids(en)}).",
            cases=len(en),
            french=len(fr),
        )
    if ov.get("flaky"):
        f = ov["flaky"]
        add(
            "flaky",
            9,
            f"Flaky: {pl(len(f), 'case')} passed on some attempts and failed on others ({_ids(f)}).",
            cases=len(f),
        )
    return sorted(out, key=lambda s: s["rank"])


NUMBER = re.compile(r"\d+(?:\.\d+)?")


def _numbers(text: str) -> set[str]:
    return set(NUMBER.findall(text))


AUDIT_SYSTEM = """You write the audit summary for an HR chatbot test run. You get findings that were computed by code, each with an id and a sentence.

Pick at most 5, most important first, and rewrite each as one plain line of at most 22 words for an HR engineering lead.
Rules: keep every number exactly as given; never add a number, a percentage, or a case id that is not in that finding's sentence; no advice you cannot support from the sentence.

Reply with JSON only: {"findings": [{"id": "...", "text": "..."}]}"""


async def audit(sigs: list[dict], llm: "judge_mod.LLM | None") -> dict:
    """At most 5 findings. The LLM's wording is kept only where it invents no number."""
    top = sigs[:8]
    findings = [{"id": s["id"], "kind": s["kind"], "text": s["text"], "by": "code"} for s in top[:5]]
    if llm is None or not top:
        return {"findings": findings, "phrased_by": "code"}
    try:
        content = await llm.complete(
            [
                {"role": "system", "content": AUDIT_SYSTEM},
                {"role": "user", "content": json.dumps([{"id": s["id"], "sentence": s["text"]} for s in top])},
            ],
            max_tokens=600,
        )
        data = judge_mod.extract_json(content)
        items = data.get("findings") if isinstance(data, dict) else None
        if not isinstance(items, list):
            raise ValueError("no findings list")
    except (judge_mod.JudgeError, ValueError) as e:
        return {"findings": findings, "phrased_by": "code", "llm_error": str(e)[:200]}
    by_id = {s["id"]: s for s in top}
    out, seen = [], set()
    for it in items[:5]:
        if not isinstance(it, dict) or it.get("id") not in by_id or it["id"] in seen:
            continue
        s = by_id[it["id"]]
        seen.add(s["id"])
        text = " ".join(str(it.get("text") or "").split())
        ok = bool(text) and _numbers(text) <= _numbers(s["text"])
        out.append({"id": s["id"], "kind": s["kind"], "text": text if ok else s["text"], "by": "llm" if ok else "code"})
    if not out:
        return {"findings": findings, "phrased_by": "code", "llm_error": "no usable findings"}
    return {"findings": out, "phrased_by": "llm"}
