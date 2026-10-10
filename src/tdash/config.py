"""Configuration, from the environment. Secrets may be SECRET:<KEY> references (secrets.py)."""

import os
from collections.abc import Mapping
from dataclasses import dataclass, replace

SECRET_FIELDS = ("CHATBOT_TOKEN", "JUDGE_API_KEY")


def _num(env: Mapping[str, str], name: str, default: float, lo: float, hi: float) -> float:
    raw = (env.get(name) or "").strip()
    if not raw:
        return default
    try:
        v = float(raw)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {raw!r}") from None
    if not lo <= v <= hi:
        raise ValueError(f"{name} must be between {lo} and {hi}, got {v}")
    return v


def _flag(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = (env.get(name) or "").strip().lower()
    return default if not raw else raw in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Config:
    base_path: str = "/tools/testing-dash"
    data_dir: str = "/data"
    # the chatbot API, directly as tachevu does: POST {chatbot_url}/v1/query, GET {chatbot_url}/health
    chatbot_url: str = ""
    chatbot_token: str = ""
    chatbot_ca: str = ""  # CA bundle for a self-signed front door; empty = system trust
    chatbot_timeout: float = 150.0  # above the chatbot's own 120s LLM timeout
    chatbot_history: bool = False  # set once work order W3 is deployed
    # the judge: any OpenAI-compatible endpoint, POST {judge_url}/chat/completions
    judge_url: str = ""
    judge_model: str = ""
    judge_api_key: str = ""
    judge_ca: str = ""
    judge_timeout: float = 60.0
    judge_no_think: bool = True  # chat_template_kwargs.enable_thinking=false, as the chatbot does
    default_threshold: float = 0.75
    default_concurrency: int = 4
    max_concurrency: int = 16
    dev_identity: str = ""  # "user:role" — desktop only, loopback only
    git_commit: str = "unknown"

    @property
    def db_path(self) -> str:
        return os.path.join(self.data_dir, "tdash.db")

    @property
    def chatbot_ready(self) -> bool:
        return bool(self.chatbot_url and self.chatbot_token)

    @property
    def judge_ready(self) -> bool:
        return bool(self.judge_url and self.judge_model)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env
        g = lambda k, d="": (env.get(k) or d).strip()  # noqa: E731
        # BASE_PATH= (empty) is meaningful: serve at the root, as the other tools do on the desktop
        base = env.get("BASE_PATH", "/tools/testing-dash").strip().rstrip("/")
        if base and not base.startswith("/"):
            raise ValueError(f"BASE_PATH must start with '/', got {base!r}")
        conc = int(_num(env, "DEFAULT_CONCURRENCY", 4, 1, 64))
        top = int(_num(env, "MAX_CONCURRENCY", 16, 1, 64))
        if conc > top:
            raise ValueError(f"DEFAULT_CONCURRENCY ({conc}) exceeds MAX_CONCURRENCY ({top})")
        for url_var in ("CHATBOT_URL", "JUDGE_URL"):
            u = g(url_var)
            if u and not u.startswith(("http://", "https://")):
                raise ValueError(f"{url_var} must be an http(s) URL, got {u!r}")
        return cls(
            base_path=base,
            data_dir=g("DATA_DIR", "/data"),
            chatbot_url=g("CHATBOT_URL").rstrip("/"),
            chatbot_token=g("CHATBOT_TOKEN"),
            chatbot_ca=g("CHATBOT_CA"),
            chatbot_timeout=_num(env, "CHATBOT_TIMEOUT", 150.0, 5, 900),
            chatbot_history=_flag(env, "CHATBOT_HISTORY", False),
            judge_url=g("JUDGE_URL").rstrip("/"),
            judge_model=g("JUDGE_MODEL"),
            judge_api_key=g("JUDGE_API_KEY"),
            judge_ca=g("JUDGE_CA"),
            judge_timeout=_num(env, "JUDGE_TIMEOUT", 60.0, 5, 600),
            judge_no_think=_flag(env, "JUDGE_NO_THINK", True),
            default_threshold=_num(env, "DEFAULT_THRESHOLD", 0.75, 0, 1),
            default_concurrency=conc,
            max_concurrency=top,
            dev_identity=g("DEV_IDENTITY"),
            git_commit=g("GIT_COMMIT", "unknown"),
        )

    def with_secrets(self, resolved: Mapping[str, str]) -> "Config":
        return replace(
            self,
            chatbot_token=resolved.get("CHATBOT_TOKEN", self.chatbot_token),
            judge_api_key=resolved.get("JUDGE_API_KEY", self.judge_api_key),
        )
