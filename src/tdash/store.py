"""The dashboard's own state: one SQLite file on its own volume.

The test set (cases, personas) is the source of truth once imported. Every change to it —
an import, an in-app edit, a rollback — writes a version holding a full snapshot, so any
earlier state can be restored. Runs and their results live beside it; a result is written
the moment it is graded, so a restart loses nothing that finished.
"""

import json
import sqlite3
import threading
from contextlib import closing
from datetime import UTC, datetime

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL,
    edited_in_app INTEGER NOT NULL DEFAULT 0, updated_at TEXT, updated_by TEXT);
CREATE TABLE IF NOT EXISTS personas (login TEXT PRIMARY KEY, pos INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, by TEXT, kind TEXT NOT NULL,
    note TEXT, snapshot TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, created_by TEXT,
    kind TEXT NOT NULL, status TEXT NOT NULL, params TEXT NOT NULL, info TEXT NOT NULL DEFAULT '{}',
    total INTEGER NOT NULL DEFAULT 0, started_at TEXT, finished_at TEXT, audit TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS results (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, case_id TEXT NOT NULL,
    attempt INTEGER NOT NULL, phase INTEGER, status TEXT NOT NULL, score REAL,
    latency_ms INTEGER, in_flight INTEGER, data TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS results_run ON results(run_id);
"""

ACTIVE = ("queued", "running")


def now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


class Store:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()  # one writer at a time; readers use WAL
        with closing(self._db()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
            db.commit()

    def _db(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=10, check_same_thread=False)
        db.row_factory = sqlite3.Row
        return db

    # ------------------------------------------------------------------ meta
    def meta(self, k: str, default=None):
        with closing(self._db()) as db:
            row = db.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
        return json.loads(row["v"]) if row else default

    def _set_meta(self, db: sqlite3.Connection, k: str, v) -> None:
        db.execute(
            "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", (k, json.dumps(v))
        )

    # ------------------------------------------------------------------ test set
    def cases(self) -> list[dict]:
        with closing(self._db()) as db:
            rows = db.execute("SELECT data, edited_in_app, updated_at, updated_by FROM cases ORDER BY pos").fetchall()
        out = []
        for r in rows:
            c = json.loads(r["data"])
            c["_edited"] = bool(r["edited_in_app"])
            c["_updated_at"], c["_updated_by"] = r["updated_at"], r["updated_by"]
            out.append(c)
        return out

    def case(self, case_id: str) -> dict | None:
        return next((c for c in self.cases() if c["id"] == case_id), None)

    def personas(self) -> list[dict]:
        with closing(self._db()) as db:
            return [json.loads(r["data"]) for r in db.execute("SELECT data FROM personas ORDER BY pos")]

    def persona_columns(self) -> list[str]:
        return self.meta("persona_columns", [])

    def case_extra_columns(self) -> list[str]:
        return self.meta("case_extra_columns", [])

    def test_set_version(self) -> int:
        return self.meta("test_set_version", 0)

    def snapshot(self) -> dict:
        strip = lambda c: {k: v for k, v in c.items() if not k.startswith("_")}  # noqa: E731
        return {
            "cases": [strip(c) for c in self.cases()],
            "edited": [c["id"] for c in self.cases() if c["_edited"]],
            "personas": self.personas(),
            "persona_columns": self.persona_columns(),
            "case_extra_columns": self.case_extra_columns(),
        }

    def _version(self, db: sqlite3.Connection, by: str, kind: str, note: str) -> int:
        """Snapshot the committed-to-be state inside the caller's transaction."""
        cases = [
            {**json.loads(r["data"]), "_e": r["edited_in_app"]}
            for r in db.execute("SELECT data, edited_in_app FROM cases ORDER BY pos")
        ]
        snap = {
            "cases": [{k: v for k, v in c.items() if k != "_e"} for c in cases],
            "edited": [c["id"] for c in cases if c["_e"]],
            "personas": [json.loads(r["data"]) for r in db.execute("SELECT data FROM personas ORDER BY pos")],
            "persona_columns": self._meta_in(db, "persona_columns", []),
            "case_extra_columns": self._meta_in(db, "case_extra_columns", []),
        }
        cur = db.execute(
            "INSERT INTO versions (at, by, kind, note, snapshot) VALUES (?, ?, ?, ?, ?)",
            (now(), by, kind, note, json.dumps(snap)),
        )
        vid = cur.lastrowid
        self._set_meta(db, "test_set_version", vid)
        return vid

    @staticmethod
    def _meta_in(db: sqlite3.Connection, k: str, default):
        row = db.execute("SELECT v FROM meta WHERE k = ?", (k,)).fetchone()
        return json.loads(row["v"]) if row else default

    def replace_set(
        self,
        cases: list[dict],
        personas: list[dict],
        persona_columns: list[str],
        case_extra_columns: list[str],
        by: str,
        kind: str,
        note: str = "",
        edited: list[str] | tuple = (),
    ) -> int:
        """Swap the whole test set in one transaction (an import, or a rollback)."""
        edited = set(edited)
        with self.lock, closing(self._db()) as db:
            db.execute("DELETE FROM cases")
            db.execute("DELETE FROM personas")
            stamp = now()
            for i, c in enumerate(cases):
                clean = {k: v for k, v in c.items() if not k.startswith("_")}
                db.execute(
                    "INSERT INTO cases (id, pos, data, edited_in_app, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)",
                    (clean["id"], i, json.dumps(clean), int(clean["id"] in edited), stamp, by),
                )
            for i, p in enumerate(personas):
                db.execute(
                    "INSERT INTO personas (login, pos, data) VALUES (?, ?, ?)", (p["USERLOGIN"], i, json.dumps(p))
                )
            self._set_meta(db, "persona_columns", list(persona_columns))
            self._set_meta(db, "case_extra_columns", list(case_extra_columns))
            vid = self._version(db, by, kind, note)
            db.commit()
        return vid

    def save_case(self, case: dict, by: str, note: str = "") -> int:
        """Insert or update one case from the app. Marks it edited, so a later import can warn."""
        clean = {k: v for k, v in case.items() if not k.startswith("_")}
        with self.lock, closing(self._db()) as db:
            row = db.execute("SELECT pos FROM cases WHERE id = ?", (clean["id"],)).fetchone()
            if row:
                db.execute(
                    "UPDATE cases SET data = ?, edited_in_app = 1, updated_at = ?, updated_by = ? WHERE id = ?",
                    (json.dumps(clean), now(), by, clean["id"]),
                )
            else:
                pos = db.execute("SELECT coalesce(max(pos), -1) + 1 FROM cases").fetchone()[0]
                db.execute(
                    "INSERT INTO cases (id, pos, data, edited_in_app, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?)",
                    (clean["id"], pos, json.dumps(clean), now(), by),
                )
            vid = self._version(db, by, "edit", note or f"{'edited' if row else 'added'} {clean['id']}")
            db.commit()
        return vid

    def delete_case(self, case_id: str, by: str) -> int | None:
        with self.lock, closing(self._db()) as db:
            if not db.execute("DELETE FROM cases WHERE id = ?", (case_id,)).rowcount:
                return None
            vid = self._version(db, by, "edit", f"deleted {case_id}")
            db.commit()
        return vid

    def versions(self, limit: int = 200) -> list[dict]:
        with closing(self._db()) as db:
            rows = db.execute(
                "SELECT id, at, by, kind, note, json_array_length(snapshot, '$.cases') AS n FROM versions ORDER BY id DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [dict(r) for r in rows]

    def version(self, vid: int) -> dict | None:
        with closing(self._db()) as db:
            row = db.execute("SELECT snapshot FROM versions WHERE id = ?", (vid,)).fetchone()
        return json.loads(row["snapshot"]) if row else None

    def rollback(self, vid: int, by: str) -> int | None:
        snap = self.version(vid)
        if snap is None:
            return None
        return self.replace_set(
            snap["cases"],
            snap["personas"],
            snap["persona_columns"],
            snap["case_extra_columns"],
            by,
            "rollback",
            f"restored version {vid}",
            edited=snap.get("edited", []),
        )

    # ------------------------------------------------------------------ runs
    def create_run(self, kind: str, params: dict, info: dict, total: int, by: str) -> int:
        with self.lock, closing(self._db()) as db:
            cur = db.execute(
                "INSERT INTO runs (created_at, created_by, kind, status, params, info, total) VALUES (?, ?, ?, 'queued', ?, ?, ?)",
                (now(), by, kind, json.dumps(params), json.dumps(info), total),
            )
            db.commit()
            return cur.lastrowid

    def update_run(self, run_id: int, **fields) -> None:
        if not fields:
            return
        cols, vals = [], []
        for k, v in fields.items():
            if k not in ("status", "info", "started_at", "finished_at", "audit", "error", "total"):
                raise ValueError(f"not a run field: {k}")
            cols.append(f"{k} = ?")
            vals.append(json.dumps(v) if k in ("info", "audit") else v)
        with self.lock, closing(self._db()) as db:
            db.execute(f"UPDATE runs SET {', '.join(cols)} WHERE id = ?", (*vals, run_id))
            db.commit()

    @staticmethod
    def _run_row(r: sqlite3.Row) -> dict:
        d = dict(r)
        d["params"] = json.loads(d["params"])
        d["info"] = json.loads(d["info"] or "{}")
        d["audit"] = json.loads(d["audit"]) if d["audit"] else None
        return d

    def run(self, run_id: int) -> dict | None:
        with closing(self._db()) as db:
            row = db.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
            if not row:
                return None
            counts = dict(
                db.execute(
                    "SELECT status, count(*) FROM results WHERE run_id = ? GROUP BY status", (run_id,)
                ).fetchall()
            )
        out = self._run_row(row)
        out["counts"] = counts
        out["done"] = sum(counts.values())
        return out

    def runs(self, limit: int = 100) -> list[dict]:
        with closing(self._db()) as db:
            rows = db.execute("SELECT * FROM runs ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
            counts: dict[int, dict] = {}
            for r in db.execute("SELECT run_id, status, count(*) AS n FROM results GROUP BY run_id, status"):
                counts.setdefault(r["run_id"], {})[r["status"]] = r["n"]
        out = []
        for r in rows:
            d = self._run_row(r)
            d["counts"] = counts.get(d["id"], {})
            d["done"] = sum(d["counts"].values())
            d.pop("audit", None)  # the list stays light; GET one run for its audit
            out.append(d)
        return out

    def active_run(self) -> dict | None:
        with closing(self._db()) as db:
            row = db.execute(
                "SELECT id FROM runs WHERE status IN ('queued', 'running') ORDER BY id DESC LIMIT 1"
            ).fetchone()
        return self.run(row["id"]) if row else None

    def previous_judged_run(self, run_id: int) -> int | None:
        """The most recent completed run before this one — the baseline for regressions. A
        cancelled or interrupted run covers only part of the set, so it never serves."""
        with closing(self._db()) as db:
            row = db.execute(
                "SELECT id FROM runs WHERE id < ? AND kind = 'run' AND status = 'done' ORDER BY id DESC LIMIT 1",
                (run_id,),
            ).fetchone()
        return row["id"] if row else None

    def add_result(self, run_id: int, r: dict) -> int:
        with self.lock, closing(self._db()) as db:
            cur = db.execute(
                "INSERT INTO results (run_id, case_id, attempt, phase, status, score, latency_ms, in_flight, data, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_id,
                    r["case_id"],
                    r["attempt"],
                    r.get("phase"),
                    r["status"],
                    r.get("score"),
                    r.get("latency_ms"),
                    r.get("in_flight"),
                    json.dumps(r),
                    now(),
                ),
            )
            db.commit()
            return cur.lastrowid

    def results(self, run_id: int) -> list[dict]:
        with closing(self._db()) as db:
            rows = db.execute("SELECT id, data FROM results WHERE run_id = ? ORDER BY id", (run_id,)).fetchall()
        return [{**json.loads(r["data"]), "result_id": r["id"]} for r in rows]

    def interrupt_active(self) -> list[int]:
        """At startup: a run still 'running' was cut off by a restart. Keep what finished."""
        with self.lock, closing(self._db()) as db:
            ids = [r["id"] for r in db.execute("SELECT id FROM runs WHERE status IN ('queued', 'running')")]
            for i in ids:
                db.execute(
                    "UPDATE runs SET status = 'interrupted', finished_at = ?, error = ? WHERE id = ?",
                    (now(), "the dashboard restarted mid-run; results so far are kept", i),
                )
            db.commit()
        return ids
