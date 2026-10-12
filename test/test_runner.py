import asyncio

import httpx
import pytest

from tdash import grading
from tdash import judge as J
from tdash.chatbot import Chatbot
from tdash.config import Config
from tdash.runner import PROBE_REQUESTS, Busy, Runner
from tdash.store import Store


@pytest.fixture
def store(tmp_path, seed):
    s = Store(str(tmp_path / "t.db"))
    s.replace_set(seed["cases"], seed["personas"], seed["persona_columns"], [], "ben", "import")
    return s


def make(store, fakes, **cfg):
    bot, judge = fakes
    c = Config(
        chatbot_url="https://web.test", chatbot_token="svc-token", judge_url="https://j.test/v1", judge_model="m", **cfg
    )
    r = Runner(
        store,
        c,
        Chatbot(c.chatbot_url, c.chatbot_token, transport=httpx.MockTransport(bot.handler)),
        J.LLM(c.judge_url, c.judge_model, transport=httpx.MockTransport(judge.handler)),
    )
    r.retry_delay = 0
    return r


async def finish(r: Runner, run_id: int, store: Store) -> dict:
    await asyncio.wait_for(r._task, 20)
    return store.run(run_id)


def ready(store):
    return [c for c in store.cases() if c["status"] == "ready" and not c["issues"]]


async def test_full_run_grades_every_ready_case(store, fakes):
    r = make(store, fakes)
    run_id = r.start({"scope": "ready"}, "ben")
    run = await finish(r, run_id, store)
    n = len(ready(store))
    assert run["status"] == "done" and run["done"] == run["total"] == n == 65
    assert run["info"]["chatbot_commit"] == "abc1234" and run["info"]["prompt_version"] == J.PROMPT_VERSION
    by = {x["case_id"]: x for x in store.results(run_id)}
    # The fake judge covers every point, so the outcome is decided by the deterministic checks
    # against what the fake returns: one cited document from the persona's region, or nothing
    # when the persona has no region. Predict each case exactly.
    bot = fakes[0]
    want = {}
    for c in ready(store):
        region = bot.regions.get(c["persona"])
        src = [{"cited": True, "tool": "kb_search", "region": region}] if region else []
        want[c["id"]] = "pass" if all(k["passed"] for k in grading.checks(c, region, src)) else "fail"
    assert {i: x["status"] for i, x in by.items()} == want
    assert "fail" in want.values() and "pass" in want.values()  # the prediction isn't trivial
    assert run["audit"]["findings"] is not None and run["audit"]["baseline_run"] is None


async def test_concurrency_is_a_hard_ceiling(store, fakes):
    bot, _ = fakes
    bot.gate = asyncio.Event()
    r = make(store, fakes)
    run_id = r.start({"scope": "ready", "concurrency": 3}, "ben")
    await asyncio.sleep(0.2)
    assert bot.active == 3  # three held in flight, no more
    bot.gate.set()
    await finish(r, run_id, store)
    assert bot.max_active == 3
    assert max(x["in_flight"] for x in store.results(run_id)) <= 3


async def test_infra_failures_retry_once_then_error(store, fakes):
    bot, _ = fakes
    cs = ready(store)
    bot.fail[cs[0]["question"]] = [503]  # recovers on the retry
    bot.fail[cs[1]["question"]] = [503, "timeout"]  # fails twice
    bot.fail[cs[2]["question"]] = [401]  # config: not retried
    r = make(store, fakes)
    run_id = r.start({"scope": "ids", "ids": [c["id"] for c in cs[:3]]}, "ben")
    await finish(r, run_id, store)
    by = {x["case_id"]: x for x in store.results(run_id)}
    assert by[cs[0]["id"]]["status"] in ("pass", "fail") and by[cs[0]["id"]]["retried"] is True
    assert by[cs[1]["id"]]["status"] == "error" and "timed out" in by[cs[1]["id"]]["error"]
    assert by[cs[2]["id"]]["status"] == "error" and by[cs[2]["id"]]["error_kind"] == "config"
    assert sum(1 for c in bot.calls if c["text"] == cs[2]["question"]) == 1  # no retry on 401


async def test_judge_failure_is_an_error_not_a_fail(store, fakes):
    _, judge = fakes
    judge.mode = ["garbage", "garbage"]
    r = make(store, fakes)
    run_id = r.start({"scope": "ids", "ids": [ready(store)[0]["id"]]}, "ben")
    await finish(r, run_id, store)
    (res,) = store.results(run_id)
    assert res["status"] == "error" and res["error_kind"] == "judge"


async def test_verdicts_drive_the_outcome(store, fakes):
    bot, _judge = fakes
    c = next(x for x in ready(store) if x["must_not"] and x["sources"] != "none")
    bot.answers[c["question"]] = "HIT and BAD"
    r = make(store, fakes)
    run_id = r.start({"scope": "ids", "ids": [c["id"]]}, "ben")
    await finish(r, run_id, store)
    (res,) = store.results(run_id)
    assert res["status"] == "fail"
    assert any("contradicted" in x for x in res["reasons"]) and any("must_not hit" in x for x in res["reasons"])
    assert res["feedback"] == "Wrong: first point."


async def test_cancel_stops_new_work(store, fakes):
    bot, _ = fakes
    bot.gate = asyncio.Event()
    r = make(store, fakes)
    run_id = r.start({"scope": "ready", "concurrency": 2}, "ben")
    await asyncio.sleep(0.1)
    assert r.cancel(run_id) and not r.cancel(run_id + 1)
    bot.gate.set()
    run = await finish(r, run_id, store)
    assert run["status"] == "cancelled" and run["done"] == 2 < run["total"]


async def test_one_run_at_a_time(store, fakes):
    bot, _ = fakes
    bot.gate = asyncio.Event()
    r = make(store, fakes)
    run_id = r.start({"scope": "ready"}, "ben")
    with pytest.raises(Busy):
        r.start({"scope": "ready"}, "ben")
    bot.gate.set()
    await finish(r, run_id, store)
    second = r.start({"scope": "ready"}, "ben")  # free again
    await finish(r, second, store)
    assert store.run(second)["audit"]["baseline_run"] == run_id


async def test_scope_and_validation(store, fakes):
    r = make(store, fakes)
    draft = next(c for c in store.cases() if c["status"] == "draft")
    with pytest.raises(ValueError, match="no runnable"):
        r.start({"scope": "ids", "ids": [draft["id"]]}, "ben")
    with pytest.raises(ValueError, match="repeats"):
        r.start({"repeats": 9}, "ben")
    with pytest.raises(ValueError, match="concurrency"):
        r.start({"concurrency": 99}, "ben")
    with pytest.raises(ValueError, match="scope"):
        r.start({"scope": "everything"}, "ben")
    ok = ready(store)[0]
    run_id = r.start({"scope": "ids", "ids": [ok["id"], draft["id"], "TC-NOPE"]}, "ben")
    run = await finish(r, run_id, store)
    assert run["total"] == 1
    assert any(draft["id"] in s for s in run["info"]["skipped"]) and any("TC-NOPE" in s for s in run["info"]["skipped"])
    cat = ok["category"]
    run_id = r.start({"scope": "category", "category": cat, "repeats": 3}, "ben")
    run = await finish(r, run_id, store)
    assert run["total"] == 3 * sum(1 for c in ready(store) if c["category"] == cat)


async def test_unconfigured(store):
    c = Config()
    with pytest.raises(ValueError, match="chatbot"):
        Runner(store, c, None, None).start({}, "ben")


async def test_load_probe(store, fakes):
    r = make(store, fakes)
    ids = [c["id"] for c in ready(store)[:2]]
    run_id = r.start({"scope": "ids", "ids": ids, "probe": True}, "ben")
    run = await finish(r, run_id, store)
    probe = [x for x in store.results(run_id) if x["phase"] is not None]
    assert run["total"] == 2 + 3 * PROBE_REQUESTS == run["done"]
    assert sorted({x["phase"] for x in probe}) == [1, 4, 8]
    assert all(x["status"] == "probe" and "judge" not in x for x in probe)
    assert max(x["in_flight"] for x in probe if x["phase"] == 1) == 1


async def test_a_crash_fails_the_run_visibly(store, fakes, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("bug")

    monkeypatch.setattr(grading, "checks", boom)
    r = make(store, fakes)
    run_id = r.start({"scope": "ids", "ids": [ready(store)[0]["id"]]}, "ben")
    run = await finish(r, run_id, store)
    assert run["status"] == "failed" and "RuntimeError: bug" in run["error"]


async def test_restart_marks_the_run_interrupted(store, fakes, tmp_path):
    bot, _ = fakes
    bot.gate = asyncio.Event()
    r = make(store, fakes)
    run_id = r.start({"scope": "ready"}, "ben")
    await asyncio.sleep(0.05)
    again = Store(store.path)  # a new process starting up
    assert again.interrupt_active() == [run_id]
    assert again.run(run_id)["status"] == "interrupted"
    r._task.cancel()


async def test_shutdown_interrupts_cleanly(store, fakes):
    bot, _ = fakes
    bot.gate = asyncio.Event()
    r = make(store, fakes)
    run_id = r.start({"scope": "ready"}, "ben")
    await asyncio.sleep(0.05)
    await r.shutdown()
    assert store.run(run_id)["status"] == "interrupted" and not r.busy


async def test_a_cancelled_run_is_never_the_baseline(store, fakes):
    r = make(store, fakes)
    one = r.start({"scope": "ready"}, "ben")
    await finish(r, one, store)
    bot, _ = fakes
    bot.gate = asyncio.Event()
    two = r.start({"scope": "ready", "concurrency": 1}, "ben")
    await asyncio.sleep(0.05)
    r.cancel(two)
    bot.gate.set()
    assert (await finish(r, two, store))["status"] == "cancelled"
    bot.gate = None
    three = r.start({"scope": "ready"}, "ben")
    assert (await finish(r, three, store))["audit"]["baseline_run"] == one  # skips the cancelled #2
