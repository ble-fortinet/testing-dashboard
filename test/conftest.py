"""Fakes that speak the real wire formats: the chatbot's /v1/query and /health, and an
OpenAI-compatible judge. Both run in-process through httpx.MockTransport."""

import asyncio
import json
import re
from pathlib import Path

import httpx
import pytest

from tdash.regions import region_for_persona
from tdash.workbook import parse

# A frozen copy of the seed workbook as of 2026-10-09. Tests pin its counts, so they must not
# read test-set/hr-assist-test-set.xlsx, which Ben and HR keep editing.
SEED = Path(__file__).resolve().parent / "fixtures" / "seed.xlsx"
LIVE = Path(__file__).resolve().parent.parent / "test-set" / "hr-assist-test-set.xlsx"


@pytest.fixture(scope="session")
def seed_bytes() -> bytes:
    return SEED.read_bytes()


@pytest.fixture(scope="session")
def seed(seed_bytes) -> dict:
    return parse(seed_bytes)


class FakeBot:
    """The chatbot. Answers as the sender, citing a document from the sender's region."""

    def __init__(self, personas: list[dict]):
        self.regions = {p["USERLOGIN"]: region_for_persona(p) for p in personas}
        self.calls: list[dict] = []
        self.active = 0
        self.max_active = 0
        self.delay = 0.0
        self.fail: dict[str, list] = {}  # question -> list of statuses to return before succeeding
        self.answers: dict[str, str] = {}  # question -> answer text
        self.sources: dict[str, list] = {}  # question -> sources override
        self.signal = "ok"
        self.health_status = 200
        self.gate = None  # an asyncio.Event a request waits on, to hold requests in flight

    async def handler(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/health"):
            if self.health_status != 200:
                return httpx.Response(self.health_status)
            return httpx.Response(200, json={"status": "ok", "commit": "abc1234", "docker_tag": "v0.1.3"})
        assert request.url.path.endswith("/v1/query"), request.url.path
        assert request.headers["authorization"] == "Bearer svc-token"
        body = json.loads(request.content)
        self.calls.append(body)
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            if self.gate is not None:
                await self.gate.wait()
            if self.delay:
                await asyncio.sleep(self.delay)
            plan = self.fail.get(body["text"])
            if plan:
                status = plan.pop(0)
                if status == "timeout":
                    raise httpx.ReadTimeout("slow", request=request)
                return httpx.Response(status, json={"detail": "nope"})
            region = self.regions.get(body["sender"])
            src = self.sources.get(body["text"])
            if src is None:
                src = (
                    [
                        {
                            "n": 1,
                            "title": "Policy",
                            "url": None,
                            "cited": True,
                            "tool": "kb_search",
                            "region": region,
                            "path": "hr/policy.pdf",
                        }
                    ]
                    if region
                    else []
                )
            return httpx.Response(
                200,
                json={
                    "answer": self.answers.get(body["text"], f"Here is the answer to: {body['text']} [1]"),
                    "signal": self.signal,
                    "confidence": 0.9,
                    "sources": src,
                },
            )
        finally:
            self.active -= 1


def _numbered(section: str) -> int:
    if section.strip() == "(none)":
        return 0
    return len(re.findall(r"^\d+\. ", section, re.M))


class FakeJudge:
    """OpenAI-compatible. Marks everything covered unless the answer contains BAD (first point
    contradicted) or MISSING (first point missing) or HIT (first must_not hit)."""

    def __init__(self):
        self.calls: list[dict] = []
        self.mode: list[str] = []  # queued behaviours: "garbage", "short", "500", "fenced"
        self.audit_reply: str | None = None
        self.contradict = 0  # the next N gradings contradict the first point

    async def handler(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/chat/completions")
        body = json.loads(request.content)
        self.calls.append(body)
        system = body["messages"][0]["content"]
        user = body["messages"][1]["content"]
        if "audit summary" in system:
            reply = self.audit_reply or json.dumps({"findings": []})
            return httpx.Response(200, json={"choices": [{"message": {"content": reply}}]})
        mode = self.mode.pop(0) if self.mode else "ok"
        if mode == "500":
            return httpx.Response(500)
        m = re.search(r"EXPECTED POINTS:\n(.*?)\n\nMUST NOT:\n(.*?)\n\nANSWER", user, re.S)
        n_pts, n_mn = _numbered(m.group(1)), _numbered(m.group(2))
        answer = user.split("<<<ANSWER\n", 1)[1]
        pts = ["covered"] * n_pts
        mn = [False] * n_mn
        fb = ""
        if "BAD" in answer and pts:
            pts[0], fb = "contradicted", "Wrong: first point."
        if "MISSING" in answer and pts:
            pts[0], fb = "missing", "Missing: first point."
        if self.contradict and pts:
            self.contradict -= 1
            pts[0], fb = "contradicted", "Wrong: first point."
        if "HIT" in answer and mn:
            mn[0] = True
        if mode == "short":
            pts = pts[:-1] or ["covered", "covered"]
        out = json.dumps({"points": pts, "must_not": mn, "feedback": fb})
        if mode == "garbage":
            out = "I think it's fine."
        if mode == "fenced":
            out = f"Sure:\n```json\n{out}\n```"
        return httpx.Response(200, json={"choices": [{"message": {"content": out}}]})


@pytest.fixture
def fakes(seed):
    bot, judge = FakeBot(seed["personas"]), FakeJudge()
    return bot, judge
