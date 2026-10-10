"""Runs: the background worker that asks the chatbot each case and grades the answer.

One run at a time. A pool of `concurrency` workers pulls (case, attempt) items; each result is
saved the moment it is graded, so a restart keeps everything that finished (the store marks
the run interrupted on the next boot). Cancel stops new work; requests in flight finish.

An infrastructure failure (timeout, 5xx, connection) is retried once, then recorded as an
error — never as a failed case. Each request records how many were in flight when it
started, so latency can be read against load. An optional load probe re-asks a small sample
at fixed concurrencies afterwards, unjudged, for a clean latency curve.
"""

import asyncio
import contextlib
import logging
from datetime import UTC, datetime

from tdash import grading, stats
from tdash import judge as judge_mod
from tdash.chatbot import Chatbot, ChatbotError
from tdash.config import Config
from tdash.regions import region_for_persona
from tdash.store import Store
from tdash.workbook import lines, runnable

log = logging.getLogger("tdash.runner")
PROBE_LEVELS = (1, 4, 8)
PROBE_REQUESTS = 8  # per level
PROBE_SAMPLE = 5
CASE_KEYS = ("id", "category", "tests", "persona", "question", "expected", "must_not", "sources", "threshold")


class Busy(Exception):
    pass


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class Runner:
    def __init__(self, store: Store, cfg: Config, chatbot: Chatbot | None, llm: "judge_mod.LLM | None"):
        self.store, self.cfg, self.chatbot, self.llm = store, cfg, chatbot, llm
        self._task: asyncio.Task | None = None
        self._run_id: int | None = None
        self._cancel = asyncio.Event()
        self._in_flight = 0
        self.retry_delay = 1.0

    @property
    def busy(self) -> bool:
        return self._task is not None and not self._task.done()

    # ------------------------------------------------------------------ start / cancel
    def plan(self, params: dict) -> tuple[list[dict], list[str]]:
        """The cases a run would ask, and why any requested ones were left out."""
        cases = self.store.cases()
        scope = params.get("scope") or "ready"
        skipped: list[str] = []
        if scope == "category":
            cases = [c for c in cases if (c.get("category") or "") == params.get("category", "")]
        elif scope == "ids":
            want = list(dict.fromkeys(params.get("ids") or []))
            have = {c["id"]: c for c in cases}
            skipped += [f"{i}: no such case" for i in want if i not in have]
            cases = [have[i] for i in want if i in have]
        elif scope != "ready":
            raise ValueError("scope must be ready, category or ids")
        out = []
        for c in cases:
            if runnable(c):
                out.append(c)
            elif scope == "ids":
                why = "; ".join(c.get("issues") or []) or f"status is {c.get('status')}"
                skipped.append(f"{c['id']}: {why}")
        return out, skipped

    def start(self, params: dict, by: str) -> int:
        if self.busy:
            raise Busy("a run is already in progress")
        if self.chatbot is None:
            raise ValueError("the chatbot isn't configured (CHATBOT_URL, CHATBOT_TOKEN)")
        if self.llm is None:
            raise ValueError("the judge isn't configured (JUDGE_URL, JUDGE_MODEL)")
        repeats = int(params.get("repeats") or 1)
        conc = int(params.get("concurrency") or self.cfg.default_concurrency)
        if not 1 <= repeats <= 5:
            raise ValueError("repeats must be 1–5")
        if not 1 <= conc <= self.cfg.max_concurrency:
            raise ValueError(f"concurrency must be 1–{self.cfg.max_concurrency}")
        cases, skipped = self.plan(params)
        if not cases:
            raise ValueError("no runnable cases in scope (only status=ready cases without issues run)")
        probe = bool(params.get("probe"))
        levels = [c for c in PROBE_LEVELS if c <= self.cfg.max_concurrency] if probe else []
        total = len(cases) * repeats + len(levels) * PROBE_REQUESTS
        info = {
            "cases": len(cases),
            "repeats": repeats,
            "concurrency": conc,
            "probe_levels": levels,
            "skipped": skipped,
            "test_set_version": self.store.test_set_version(),
            "judge_model": self.cfg.judge_model,
            "prompt_version": judge_mod.PROMPT_VERSION,
            "chatbot_url": self.cfg.chatbot_url,
            "default_threshold": self.cfg.default_threshold,
        }
        clean = {
            "scope": params.get("scope") or "ready",
            "category": params.get("category"),
            "ids": params.get("ids"),
            "repeats": repeats,
            "concurrency": conc,
            "probe": probe,
        }
        run_id = self.store.create_run("run", clean, info, total, by)
        self._cancel = asyncio.Event()
        self._run_id = run_id
        personas = {p["USERLOGIN"]: p for p in self.store.personas()}
        self._task = asyncio.create_task(self._execute(run_id, cases, personas, repeats, conc, levels, info))
        return run_id

    def cancel(self, run_id: int) -> bool:
        if self.busy and self._run_id == run_id:
            self._cancel.set()
            return True
        return False

    async def shutdown(self) -> None:
        """App shutdown: stop the worker and record the run as interrupted, results kept."""
        if self.busy and self._task is not None:
            self._cancel.set()
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._task
            if self._run_id is not None:
                self.store.update_run(
                    self._run_id, status="interrupted", finished_at=_now(), error="the dashboard stopped mid-run"
                )

    # ------------------------------------------------------------------ the run
    async def _execute(self, run_id, cases, personas, repeats, conc, levels, info) -> None:
        try:
            self.store.update_run(run_id, status="running", started_at=_now())
            health = await self.chatbot.health()
            if health:
                info = {**info, "chatbot_commit": health.get("commit"), "chatbot_tag": health.get("docker_tag")}
                self.store.update_run(run_id, info=info)
            items = [(c, a, None) for c in cases for a in range(1, repeats + 1)]
            await self._pool(run_id, items, personas, conc)
            if levels and not self._cancel.is_set():
                sample = self._sample(cases)
                for level in levels:
                    if self._cancel.is_set():
                        break
                    batch = [(sample[i % len(sample)], i + 1, level) for i in range(PROBE_REQUESTS)]
                    await self._pool(run_id, batch, personas, level)
            status = "cancelled" if self._cancel.is_set() else "done"
            await self._finish(run_id, status)
        except asyncio.CancelledError:
            raise
        except Exception as e:  # a crash must end the run visibly, never leave it 'running'
            log.exception("run %s failed", run_id)
            self.store.update_run(run_id, status="failed", finished_at=_now(), error=f"{type(e).__name__}: {e}")

    async def _finish(self, run_id: int, status: str) -> None:
        results = self.store.results(run_id)
        judged = [r for r in results if r.get("phase") is None]
        probe = [r for r in results if r.get("phase") is not None]
        audit = None
        if judged:
            prev_id = self.store.previous_judged_run(run_id)
            prev = self.store.results(prev_id) if prev_id else None
            ov = stats.overview(results, prev)
            sigs = stats.signals(results, ov, probe)
            summary = await stats.audit(sigs, self.llm)
            audit = {**summary, "signals": sigs, "baseline_run": prev_id}
        self.store.update_run(run_id, status=status, finished_at=_now(), audit=audit)

    @staticmethod
    def _sample(cases: list[dict]) -> list[dict]:
        """Up to five cases, one per category first, so the probe isn't five of a kind."""
        seen, out = set(), []
        for c in cases:
            if c.get("category") not in seen:
                seen.add(c.get("category"))
                out.append(c)
        out += [c for c in cases if c not in out]
        return out[:PROBE_SAMPLE]

    async def _pool(self, run_id, items, personas, conc) -> None:
        queue: asyncio.Queue = asyncio.Queue()
        for it in items:
            queue.put_nowait(it)

        async def worker():
            while not self._cancel.is_set():
                try:
                    case, attempt, phase = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return
                await self._one(run_id, case, attempt, phase, personas)

        await asyncio.gather(*(worker() for _ in range(min(conc, len(items)) or 1)))

    async def _ask(self, sender: str, text: str) -> tuple[dict, int, bool]:
        """(answer, in-flight count when it started, retried). One retry on an infra failure."""
        for attempt in (1, 2):
            self._in_flight += 1
            seen = self._in_flight
            try:
                bot = await self.chatbot.query(sender, text)
                return bot, seen, attempt > 1
            except ChatbotError as e:
                if e.kind != "infra" or attempt == 2 or self._cancel.is_set():
                    raise
            finally:
                self._in_flight -= 1
            await asyncio.sleep(self.retry_delay)
        raise AssertionError("unreachable")

    async def _one(self, run_id, case, attempt, phase, personas) -> None:
        persona = personas.get(case["persona"])
        region = region_for_persona(persona) if persona else None
        threshold = case["threshold"] if case.get("threshold") is not None else self.cfg.default_threshold
        res: dict = {
            "case_id": case["id"],
            "attempt": attempt,
            "phase": phase,
            "case": {k: case.get(k) for k in CASE_KEYS},
            "threshold": threshold,
            "expected_region": region,
        }
        try:
            bot, seen, retried = await self._ask(case["persona"], case["question"])
        except ChatbotError as e:
            res.update(status="error", error=str(e), error_kind=e.kind)
            self.store.add_result(run_id, res)
            return
        res.update(latency_ms=bot.pop("latency_ms"), in_flight=seen, retried=retried, bot=bot)
        if phase is not None:  # load probe: latency only, unjudged
            res["status"] = "probe"
            self.store.add_result(run_id, res)
            return
        det = grading.checks(case, region, bot["sources"])
        points, must_not = lines(case.get("expected", "")), lines(case.get("must_not", ""))
        verdict = None
        if points or must_not:
            try:
                verdict = await judge_mod.grade(self.llm, case["question"], points, must_not, bot["answer"])
            except judge_mod.JudgeError as e:
                res.update(status="error", error=f"judge: {e}", error_kind="judge", checks=det)
                self.store.add_result(run_id, res)
                return
        oc = grading.outcome(points, must_not, verdict, det, threshold)
        res.update(
            status=oc["status"],
            score=oc["score"],
            reasons=oc["reasons"],
            checks=det,
            judge=verdict,
            feedback=(verdict or {}).get("feedback", ""),
        )
        self.store.add_result(run_id, res)
