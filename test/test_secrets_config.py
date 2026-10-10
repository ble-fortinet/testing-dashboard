import json

import httpx
import pytest

from tdash.config import Config
from tdash.secrets import SecretUnavailable, resolve

ENV = {"FORTIPAM_TOKEN": "pam-token", "FORTIPAM_SECRET_ID": "4738"}


def pam(calls: list, *, field_status=200, value="s3cret", secret_id=4738, fields=None):
    fields = fields if fields is not None else [{"name": "CHATBOT_TOKEN", "id": 7}, {"name": "JUDGE_KEY", "id": 9}]

    def handler(req: httpx.Request) -> httpx.Response:
        calls.append((req.method, req.url.path, json.loads(req.content) if req.content else None))
        assert req.headers["authorization"] == "Bearer pam-token"
        if req.url.path.endswith("/cmdb/secret/database/4738"):
            return httpx.Response(200, json={"http_status": 200, "results": [{"field": fields}]})
        if req.url.path.endswith("/internal/secret-clear-text"):
            if field_status != 200:
                return httpx.Response(field_status)
            return httpx.Response(200, json={"http_status": 200, "secret-id": secret_id, "results": value})
        return httpx.Response(404)

    return httpx.MockTransport(handler)


async def test_no_refs_means_no_network():
    assert await resolve({"CHATBOT_TOKEN": "plain"}, ["CHATBOT_TOKEN"]) == {}


async def test_resolves_and_fetches_each_key_once():
    calls: list = []
    env = {**ENV, "CHATBOT_TOKEN": "SECRET:CHATBOT_TOKEN", "JUDGE_API_KEY": "SECRET:CHATBOT_TOKEN"}
    out = await resolve(env, ["CHATBOT_TOKEN", "JUDGE_API_KEY"], transport=pam(calls))
    assert out == {"CHATBOT_TOKEN": "s3cret", "JUDGE_API_KEY": "s3cret"}
    assert [c[0] for c in calls] == ["GET", "POST"]  # the shared key was fetched once
    assert calls[1][2] == {"secret-id": 4738, "field-id": 7}


@pytest.mark.parametrize(
    ("env", "kw", "msg"),
    [
        ({"CHATBOT_TOKEN": "SECRET:bad-key!"}, {}, "not a SECRET:<KEY>"),
        ({"CHATBOT_TOKEN": "SECRET:X", "FORTIPAM_SECRET_ID": "4738"}, {}, "need FORTIPAM_TOKEN"),
        ({**ENV, "CHATBOT_TOKEN": "SECRET:X", "FORTIPAM_URL": "http://pam"}, {}, "must be https"),
        ({**ENV, "CHATBOT_TOKEN": "SECRET:NOPE"}, {}, "has no key NOPE"),
        ({**ENV, "CHATBOT_TOKEN": "SECRET:CHATBOT_TOKEN"}, {"field_status": 500}, "HTTP 500"),
        ({**ENV, "CHATBOT_TOKEN": "SECRET:CHATBOT_TOKEN"}, {"value": '""'}, "no value returned"),
        ({**ENV, "CHATBOT_TOKEN": "SECRET:CHATBOT_TOKEN"}, {"secret_id": 1}, "no value returned"),
        ({**ENV, "CHATBOT_TOKEN": "SECRET:CHATBOT_TOKEN"}, {"fields": "x"}, "no field list"),
    ],
)
async def test_failures_stop_the_boot_without_leaking(env, kw, msg):
    with pytest.raises(SecretUnavailable, match=msg) as e:
        await resolve(env, ["CHATBOT_TOKEN"], transport=pam([], **kw))
    assert "pam-token" not in str(e.value) and "s3cret" not in str(e.value)


async def test_unreachable_pam():
    def down(req):
        raise httpx.ConnectError("no route", request=req)

    with pytest.raises(SecretUnavailable, match="ConnectError"):
        await resolve({**ENV, "CHATBOT_TOKEN": "SECRET:X"}, ["CHATBOT_TOKEN"], transport=httpx.MockTransport(down))


# ---------------------------------------------------------------- config
def test_config_defaults_and_empty_base_path():
    c = Config.from_env({})
    assert c.base_path == "/tools/testing-dash" and c.default_threshold == 0.75 and not c.chatbot_ready
    assert Config.from_env({"BASE_PATH": ""}).base_path == ""
    assert Config.from_env({"BASE_PATH": "/x/"}).base_path == "/x"


@pytest.mark.parametrize(
    ("env", "msg"),
    [
        ({"BASE_PATH": "tools"}, "must start with"),
        ({"DEFAULT_THRESHOLD": "2"}, "between 0"),
        ({"DEFAULT_CONCURRENCY": "x"}, "must be a number"),
        ({"DEFAULT_CONCURRENCY": "20", "MAX_CONCURRENCY": "8"}, "exceeds"),
        ({"CHATBOT_URL": "web.hrassist.docker"}, "http"),
    ],
)
def test_config_rejects(env, msg):
    with pytest.raises(ValueError, match=msg):
        Config.from_env(env)


def test_config_with_secrets():
    c = Config.from_env({"CHATBOT_URL": "https://w/", "CHATBOT_TOKEN": "SECRET:T"}).with_secrets(
        {"CHATBOT_TOKEN": "real"}
    )
    assert c.chatbot_token == "real" and c.chatbot_url == "https://w" and c.chatbot_ready
