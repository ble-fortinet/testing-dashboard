"""The chatbot API, reached directly as the email service does: POST /v1/query (a service
token), GET /health.

/v1/query runs one full judged turn AS the sender, on an ephemeral store, and always answers
200 with {answer, signal, confidence, sources}. Anything else is an infrastructure problem,
which the runner retries once and reports as an error, never as a failed test.
"""

import time

import httpx


class ChatbotError(Exception):
    """kind: 'infra' (worth one retry: timeout, 5xx, 429, connection) or 'config' (won't fix itself)."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


class Chatbot:
    def __init__(
        self,
        base_url: str,
        token: str,
        verify: str | bool = True,
        timeout: float = 150.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=httpx.Timeout(timeout, connect=10),
            verify=verify,
            follow_redirects=False,  # a redirect here means a login bounce: the token was refused
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def query(self, sender: str, text: str, history: list[dict] | None = None) -> dict:
        """{answer, signal, confidence, sources, latency_ms}. Raises ChatbotError."""
        body: dict = {"sender": sender, "text": text}
        if history:
            body["history"] = history
        t0 = time.perf_counter()
        try:
            res = await self._client.post("/v1/query", json=body)
        except httpx.TimeoutException:
            raise ChatbotError("infra", "the chatbot timed out") from None
        except httpx.HTTPError as e:
            raise ChatbotError("infra", f"could not reach the chatbot ({type(e).__name__})") from None
        latency = round((time.perf_counter() - t0) * 1000)
        if res.status_code in (401, 403):
            raise ChatbotError("config", f"the chatbot refused the service token (HTTP {res.status_code})")
        if 300 <= res.status_code < 400:
            raise ChatbotError(
                "config", f"the chatbot redirected (HTTP {res.status_code}) — is CHATBOT_URL the front door?"
            )
        if res.status_code == 429 or res.status_code >= 500:
            raise ChatbotError("infra", f"the chatbot answered HTTP {res.status_code}")
        if res.status_code != 200:
            raise ChatbotError("config", f"the chatbot answered HTTP {res.status_code}")
        try:
            data = res.json()
        except ValueError:
            raise ChatbotError("config", "the chatbot's answer was not JSON — is CHATBOT_URL the front door?") from None
        if not isinstance(data, dict) or not isinstance(data.get("answer"), str) or "signal" not in data:
            raise ChatbotError("config", "the chatbot's answer had no answer/signal fields")
        sources = data.get("sources")
        return {
            "answer": data["answer"],
            "signal": str(data.get("signal")),
            "confidence": data.get("confidence"),
            "sources": [s for s in sources if isinstance(s, dict)] if isinstance(sources, list) else [],
            "latency_ms": latency,
        }

    async def health(self) -> dict | None:
        """The chatbot's /health (commit, docker_tag, …), or None when it can't be read."""
        try:
            res = await self._client.get("/health", timeout=10)
            data = res.json() if res.status_code == 200 else None
        except (httpx.HTTPError, ValueError):
            return None
        return data if isinstance(data, dict) else None
