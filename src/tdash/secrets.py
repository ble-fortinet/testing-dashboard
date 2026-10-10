"""SECRET:<KEY> config values, fetched from this server's FortiPAM entry at startup.

A port of hrai-report's src/secrets.js, which runs against the real FortiPAM: the entry's
field list maps key names to field ids (looked up every start: their order is not stable),
then each key's clear text is fetched once. Values live in the returned dict only, never in
os.environ. Any failure stops the boot, and no message carries the token or a value.
"""

import re
from collections.abc import Mapping

import httpx

DEFAULT_URL = "https://itpam.corp.fortinet.com/api/v2"
REF = re.compile(r"^SECRET:(\w+)$")


class SecretUnavailable(RuntimeError):
    pass


async def _pam(client: httpx.AsyncClient, url: str, path: str, token: str, body: dict | None = None) -> dict:
    try:
        res = await client.request(
            "POST" if body is not None else "GET", url + path, json=body, headers={"Authorization": f"Bearer {token}"}
        )
    except httpx.HTTPError as e:
        raise SecretUnavailable(f"FortiPAM {path}: {type(e).__name__}") from None
    if res.status_code != 200:
        raise SecretUnavailable(f"FortiPAM {path}: HTTP {res.status_code}")
    try:
        data = res.json()
    except ValueError:
        data = None
    if not isinstance(data, dict) or data.get("http_status") != 200:
        raise SecretUnavailable(f"FortiPAM {path}: no result")
    return data


async def resolve(env: Mapping[str, str], names: list[str], transport: httpx.AsyncBaseTransport | None = None) -> dict:
    """{name: clear text} for each of `names` whose env value is a SECRET:<KEY> reference."""
    refs: dict[str, str] = {}
    for name in names:
        value = (env.get(name) or "").strip()
        if not value.lower().startswith("secret:"):
            continue
        m = REF.match(value)
        if not m:  # a typo'd reference must not become the credential itself
            raise SecretUnavailable(f"{name}: not a SECRET:<KEY> reference")
        refs[name] = m.group(1)
    if not refs:
        return {}

    token = (env.get("FORTIPAM_TOKEN") or "").strip()
    try:
        entry = int((env.get("FORTIPAM_SECRET_ID") or "").strip())
    except ValueError:
        entry = 0
    if not token or entry <= 0:
        raise SecretUnavailable("SECRET: values need FORTIPAM_TOKEN and FORTIPAM_SECRET_ID")
    url = (env.get("FORTIPAM_URL") or "").strip() or DEFAULT_URL
    if not url.startswith("https://"):
        raise SecretUnavailable("FORTIPAM_URL must be https")
    verify: str | bool = (env.get("FORTIPAM_CA") or "").strip() or True

    async with httpx.AsyncClient(timeout=10, follow_redirects=False, verify=verify, transport=transport) as client:
        data = await _pam(client, url, f"/cmdb/secret/database/{entry}", token)
        results = data.get("results")
        fields = (
            results[0].get("field") if isinstance(results, list) and results and isinstance(results[0], dict) else None
        )
        if not isinstance(fields, list):
            raise SecretUnavailable(f"FortiPAM entry {entry}: no field list")
        ids = {f.get("name"): f.get("id") for f in fields if isinstance(f, dict)}
        values: dict[str, str] = {}
        out: dict[str, str] = {}
        for name, key in refs.items():
            if key not in values:
                if key not in ids:
                    raise SecretUnavailable(f"FortiPAM entry {entry} has no key {key}")
                data = await _pam(
                    client, url, "/internal/secret-clear-text", token, {"secret-id": entry, "field-id": ids[key]}
                )
                value = data.get("results").strip() if isinstance(data.get("results"), str) else ""
                if data.get("secret-id") != entry or not value or value == '""':
                    raise SecretUnavailable(f"FortiPAM {key}: no value returned")
                values[key] = value
            out[name] = values[key]
    return out
