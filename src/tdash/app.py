"""Testing Dashboard: runs HR Assist test cases against the chatbot and grades them. Admins only.

Identity is nginx's X-Auth-* headers; the gate sends only admins, and every route re-checks.
State is one SQLite file under DATA_DIR. See PLAN.md and CONTRACT.md.

uvicorn --factory tdash.app:create_app --port 9230
DEV_IDENTITY=ble:admin DATA_DIR=. BASE_PATH= uvicorn --factory tdash.app:create_app --reload --port 9230   # desktop
"""

import logging
import os
import secrets as pysecrets
import time
from collections.abc import Mapping
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated
from urllib.parse import unquote

import httpx
from fastapi import APIRouter, Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from tdash import judge as judge_mod
from tdash import regions, secrets, stats, workbook
from tdash.chatbot import Chatbot, ChatbotError
from tdash.config import SECRET_FIELDS, Config
from tdash.runner import Busy, Runner
from tdash.store import Store

HERE = Path(__file__).parent
LOOPBACK = {"127.0.0.1", "::1"}
MAX_UPLOAD = 10 * 1024 * 1024
PENDING_TTL = 30 * 60
MAX_HISTORY = 20
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
log = logging.getLogger("tdash")


def identity(req: Request, cfg: Config) -> dict | None:
    if cfg.dev_identity:
        name, _, role = cfg.dev_identity.partition(":")
        return {"username": name.strip().lower(), "role": role.strip() or "user"}
    h = lambda k: unquote(req.headers.get(f"x-auth-{k}", "")).strip()  # noqa: E731
    if not (name := h("username").lower()):
        return None
    return {
        "username": name,
        "first": h("first-name"),
        "last": h("last-name"),
        "role": "admin" if h("role") == "admin" else "user",  # absent != admin
    }


def create_app(
    cfg: Config | None = None,
    env: Mapping[str, str] | None = None,
    chatbot_transport: httpx.AsyncBaseTransport | None = None,
    judge_transport: httpx.AsyncBaseTransport | None = None,
    pam_transport: httpx.AsyncBaseTransport | None = None,
) -> FastAPI:
    env = os.environ if env is None else env
    cfg = cfg or Config.from_env(env)
    base = cfg.base_path
    os.makedirs(cfg.data_dir, exist_ok=True)
    store = Store(cfg.db_path)
    state: dict = {"cfg": cfg, "runner": None, "chatbot": None, "llm": None}
    pending: dict[str, dict] = {}

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        resolved = await secrets.resolve(env, list(SECRET_FIELDS), transport=pam_transport)
        c = cfg.with_secrets(resolved)
        state["cfg"] = c
        stale = store.interrupt_active()
        if stale:
            log.warning("runs %s were cut off by a restart; marked interrupted", stale)
        if c.chatbot_ready:
            state["chatbot"] = Chatbot(
                c.chatbot_url, c.chatbot_token, c.chatbot_ca or True, c.chatbot_timeout, chatbot_transport
            )
        if c.judge_ready:
            state["llm"] = judge_mod.LLM(
                c.judge_url, c.judge_model, c.judge_api_key, c.judge_ca or True, c.judge_timeout, c.judge_no_think,
                judge_transport,
            )  # fmt: skip
        state["runner"] = Runner(store, c, state["chatbot"], state["llm"])
        yield
        await state["runner"].shutdown()
        for k in ("chatbot", "llm"):
            if state[k] is not None:
                await state[k].aclose()

    app = FastAPI(title="testing-dash", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.store, app.state.tdash = store, state

    if cfg.dev_identity:
        log.warning("DEV_IDENTITY=%s: every request is this user. Loopback only.", cfg.dev_identity)

        @app.middleware("http")
        async def loopback_only(req: Request, call_next):
            if (req.client.host if req.client else "") not in LOOPBACK:
                return JSONResponse({"error": "DEV_IDENTITY is loopback-only"}, 403)
            return await call_next(req)

    def admin(req: Request) -> dict:
        # the gate already refused non-admins; this holds if a route or the gate ever widens
        user = identity(req, state["cfg"])
        if not user or user["role"] != "admin":
            raise HTTPException(403, "Admins only.")
        return user

    r = APIRouter(prefix=base, dependencies=[Depends(admin)])
    v = int(max(p.stat().st_mtime for p in (HERE / "static").rglob("*") if p.is_file()))  # cache-bust
    page = (
        (HERE / "static" / "index.html").read_text(encoding="utf-8").replace("{{base}}", base).replace("{{v}}", str(v))
    )

    def runner() -> Runner:
        if state["runner"] is None:
            raise HTTPException(503, "starting up")
        return state["runner"]

    def logins() -> set[str]:
        return {p["USERLOGIN"] for p in store.personas()}

    # ------------------------------------------------------------------ page + state
    @r.get("/", response_class=HTMLResponse)
    def index():
        return page

    @r.get("/api/state")
    def api_state(user: Annotated[dict, Depends(admin)]):
        c, run = state["cfg"], store.active_run()
        return {
            "user": user,
            "chatbot": {"url": c.chatbot_url, "ready": state["chatbot"] is not None, "history": c.chatbot_history},
            "judge": {"model": c.judge_model, "ready": state["llm"] is not None, "prompt": judge_mod.PROMPT_VERSION},
            "default_threshold": c.default_threshold,
            "default_concurrency": c.default_concurrency,
            "max_concurrency": c.max_concurrency,
            "test_set_version": store.test_set_version(),
            "active_run": run["id"] if run else None,
            "dev": bool(c.dev_identity),
            "regions": regions.country_map(),
        }

    # ------------------------------------------------------------------ test set
    @r.get("/api/cases")
    def api_cases():
        return {"cases": store.cases(), "version": store.test_set_version()}

    @r.get("/api/personas")
    def api_personas():
        return {"personas": store.personas(), "columns": store.persona_columns() or workbook.DEFAULT_PERSONA_COLUMNS}

    def _persona(body: dict, user: dict, login: str | None) -> dict:
        have = {p["USERLOGIN"]: p for p in store.personas()}
        new = str(body.get("USERLOGIN") or "").strip()
        if login is None and new in have:
            raise HTTPException(409, f"{new} already exists")
        if login is not None:
            if login not in have:
                raise HTTPException(404, f"no persona {login}")
            if new and new != login:
                raise HTTPException(400, "a persona's login can't be changed; add a new one")
            body = {**have[login], **body, "USERLOGIN": login}
        cols = store.persona_columns() or workbook.DEFAULT_PERSONA_COLUMNS
        try:
            p = workbook.normalize_persona(body, cols, set(have))
        except ValueError as e:
            raise HTTPException(400, str(e)) from None
        if login is not None and all(have[login].get(k, "") == v for k, v in p.items()):
            return p  # unchanged: not an edit, no version
        store.save_persona(p, cols, user["username"], workbook.validate_case)
        return p

    @r.post("/api/personas")
    def api_add_persona(body: dict, user: Annotated[dict, Depends(admin)]):
        return _persona(body, user, None)

    @r.put("/api/personas/{login}")
    def api_edit_persona(login: str, body: dict, user: Annotated[dict, Depends(admin)]):
        return _persona(body, user, login)

    @r.delete("/api/personas/{login}")
    def api_delete_persona(login: str, user: Annotated[dict, Depends(admin)]):
        users = [c["id"] for c in store.cases() if c.get("persona") == login]
        if users:  # deleting it would quietly stop those cases running
            raise HTTPException(409, f"{len(users)} case(s) ask as {login}: {', '.join(users[:10])}")
        refs = [p["USERLOGIN"] for p in store.personas() if login in (p.get(k) for k in workbook.LOGIN_REFS)]
        if refs:
            raise HTTPException(409, f"{', '.join(refs)} report(s) to {login}")
        if store.delete_persona(login, user["username"], workbook.validate_case) is None:
            raise HTTPException(404, f"no persona {login}")
        return {"ok": True}

    def _save(body: dict, user: dict, case_id: str | None) -> dict:
        existing = {c["id"] for c in store.cases()}
        cid = (case_id or str(body.get("id") or "")).strip() or workbook.next_id(existing)
        if case_id is None and not workbook.ID_OK.match(cid):
            raise HTTPException(400, "an id may use letters, digits, . _ - only (no spaces or slashes)")
        if case_id is None and cid in existing:
            raise HTTPException(409, f"{cid} already exists")
        if case_id is not None and case_id not in existing:
            raise HTTPException(404, f"no case {case_id}")
        rv = body.get("review")
        if rv is not None and (not isinstance(rv, dict) or rv.get("kind") not in ("add", "check")):
            rv = None
        raw = {**body, "id": cid, "review": rv}
        old = store.case(case_id) if case_id is not None else None
        if old is not None:  # keep columns the app doesn't edit
            raw.setdefault("extra", old.get("extra"))
        case = workbook.normalize_case(raw, logins())
        same = old is not None and all(case.get(k) == old.get(k) for k in case)
        if not same:  # an unchanged save is not an edit: no version, and nothing for an import to "undo"
            store.save_case(case, user["username"])
        return store.case(cid)

    @r.post("/api/cases")
    def api_add(body: dict, user: Annotated[dict, Depends(admin)]):
        return _save(body, user, None)

    @r.put("/api/cases/{case_id}")
    def api_edit(case_id: str, body: dict, user: Annotated[dict, Depends(admin)]):
        if str(body.get("id") or case_id) != case_id:
            raise HTTPException(400, "a case's id can't be changed")
        return _save(body, user, case_id)

    @r.delete("/api/cases/{case_id}")
    def api_delete(case_id: str, user: Annotated[dict, Depends(admin)]):
        if store.delete_case(case_id, user["username"]) is None:
            raise HTTPException(404, f"no case {case_id}")
        return {"ok": True}

    @r.get("/api/versions")
    def api_versions():
        return {"versions": store.versions(), "current": store.test_set_version()}

    @r.post("/api/versions/{vid}/rollback")
    def api_rollback(vid: int, user: Annotated[dict, Depends(admin)]):
        if runner().busy:
            raise HTTPException(409, "a run is in progress; roll back after it finishes")
        new = store.rollback(vid, user["username"])
        if new is None:
            raise HTTPException(404, f"no version {vid}")
        return {"version": new}

    # ------------------------------------------------------------------ import / export
    @r.post("/api/import/preview")
    async def api_preview(file: Annotated[UploadFile, File()], user: Annotated[dict, Depends(admin)]):
        data = await file.read(MAX_UPLOAD + 1)
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "the file is over 10 MB")
        try:
            parsed = workbook.parse(data)
        except workbook.WorkbookError as e:
            raise HTTPException(422, str(e)) from None
        now = time.time()
        for k in [k for k, p in list(pending.items()) if now - p["at"] > PENDING_TTL]:
            pending.pop(k, None)
        token = pysecrets.token_urlsafe(16)
        pending[token] = {"parsed": parsed, "at": now, "by": user["username"], "name": file.filename or "upload.xlsx"}
        return {
            "token": token,
            "file": file.filename,
            "cases": len(parsed["cases"]),
            "personas": len(parsed["personas"]),
            "diff": workbook.diff(store.snapshot(), parsed),
        }

    @r.post("/api/import/apply")
    def api_apply(body: dict, user: Annotated[dict, Depends(admin)]):
        token = str(body.get("token") or "")
        p = pending.get(token)
        if p is None or time.time() - p["at"] > PENDING_TTL:
            pending.pop(token, None)
            raise HTTPException(410, "that preview expired; upload the file again")
        if p["by"] != user["username"]:  # checked before consuming it, so nobody else can burn it
            raise HTTPException(403, "that preview belongs to someone else")
        if runner().busy:
            raise HTTPException(409, "a run is in progress; import after it finishes")
        if pending.pop(token, None) is None:  # a double-click already applied it
            raise HTTPException(410, "that preview was already applied")
        d = p["parsed"]
        vid = store.replace_set(
            d["cases"], d["personas"], d["persona_columns"], d["case_extra_columns"], user["username"], "import",
            f"imported {p['name']}",
        )  # fmt: skip
        return {"version": vid, "cases": len(d["cases"])}

    def _download(content: bytes | str, name: str, kind: str) -> Response:
        return Response(content, media_type=kind, headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @r.get("/api/export/test-set")
    def api_export():
        snap = store.snapshot()
        data = workbook.export(snap["cases"], snap["personas"], snap["persona_columns"], snap["case_extra_columns"])
        return _download(data, f"hr-assist-test-set-v{store.test_set_version()}.xlsx", XLSX)

    @r.get("/api/export/test-roster.csv")
    def api_roster(resolve_dates: bool = False):
        text = workbook.roster_csv(store.personas(), store.persona_columns(), resolve_dates)
        return _download(text, "test-roster.csv", "text/csv; charset=utf-8")

    # ------------------------------------------------------------------ runs
    @r.get("/api/runs")
    def api_runs():
        return {"runs": store.runs()}

    @r.post("/api/runs")
    async def api_start(body: dict, user: Annotated[dict, Depends(admin)]):
        # async on purpose: start() schedules the run on the event loop, and a sync endpoint
        # would run in a worker thread that has none (every run would crash)
        try:
            run_id = runner().start(body, user["username"])
        except Busy as e:
            raise HTTPException(409, str(e)) from None
        except (ValueError, TypeError) as e:
            raise HTTPException(400, str(e)) from None
        return store.run(run_id)

    @r.get("/api/runs/{run_id}")
    def api_run(run_id: int):
        run = store.run(run_id)
        if run is None:
            raise HTTPException(404, f"no run {run_id}")
        results = store.results(run_id)
        prev_id = (run.get("audit") or {}).get("baseline_run") or store.previous_judged_run(run_id)
        prev = store.results(prev_id) if prev_id else None
        run["overview"] = stats.overview(results, prev)
        run["baseline_run"] = prev_id
        run["baseline_pass_rate"] = stats.overview(prev)["pass_rate"] if prev else None
        return run

    @r.get("/api/runs/{run_id}/results")
    def api_results(run_id: int):
        if store.run(run_id) is None:
            raise HTTPException(404, f"no run {run_id}")
        return {"results": store.results(run_id)}

    @r.post("/api/runs/{run_id}/cancel")
    async def api_cancel(run_id: int):
        if not runner().cancel(run_id):
            raise HTTPException(409, "that run isn't in progress")
        return {"ok": True}

    @r.get("/api/runs/{run_id}/reruns")
    def api_reruns(run_id: int):
        if store.run(run_id) is None:
            raise HTTPException(404, f"no run {run_id}")
        out = {}
        for cid, attempts in store.reruns_after(run_id).items():
            # with repeats, a case passes only if every graded attempt did, as in a full run
            graded = [a for a in attempts if a["status"] in ("pass", "fail")]
            out[cid] = {**attempts[-1], "status": stats.case_outcomes(attempts)[cid], "attempts": len(attempts),
                        "passed_attempts": sum(a["status"] == "pass" for a in graded)}  # fmt: skip
        return {"reruns": out}

    @r.post("/api/cases/{case_id}/rerun")
    async def api_rerun(case_id: str, user: Annotated[dict, Depends(admin)]):
        # async for the same reason as api_start
        if store.case(case_id) is None:
            raise HTTPException(404, f"no case {case_id}")
        try:
            run_id = runner().start({"scope": "ids", "ids": [case_id], "concurrency": 1}, user["username"])
        except Busy as e:
            raise HTTPException(409, str(e)) from None
        except (ValueError, TypeError) as e:
            raise HTTPException(400, str(e)) from None
        return store.run(run_id)

    # ------------------------------------------------------------------ playground
    @r.post("/api/playground")
    async def api_playground(body: dict):
        bot = state["chatbot"]
        if bot is None:
            raise HTTPException(503, "the chatbot isn't configured")
        persona = str(body.get("persona") or "")
        text = str(body.get("text") or "").strip()
        if not workbook.is_test_login(persona) or persona not in logins():
            raise HTTPException(400, "pick a test- persona from the Personas sheet")
        if not text:
            raise HTTPException(400, "say something")
        history = body.get("history") or []
        if not isinstance(history, list) or len(history) > MAX_HISTORY:
            raise HTTPException(400, f"history must be a list of at most {MAX_HISTORY} messages")
        clean = []
        for m in history:
            if (
                not isinstance(m, dict)
                or m.get("role") not in ("user", "assistant")
                or not isinstance(m.get("text"), str)
            ):
                raise HTTPException(400, "each history message needs role user|assistant and text")
            clean.append({"role": m["role"], "text": m["text"]})
        try:
            # without work order W3 the chatbot has no history field; never send one it can't take
            out = await bot.query(persona, text, (clean or None) if state["cfg"].chatbot_history else None)
        except ChatbotError as e:
            raise HTTPException(502, str(e)) from None
        return {**out, "history_supported": state["cfg"].chatbot_history}

    @app.get("/healthz")  # touches no file
    def healthz():
        return {"ok": True, "service": "testing-dash", "commit": cfg.git_commit}

    app.include_router(r)
    app.mount(f"{base}/static", StaticFiles(directory=HERE / "static"), name="static")
    return app
