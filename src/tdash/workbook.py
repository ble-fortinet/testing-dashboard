"""The test-set workbook: import, validation, diff, export, and the chatbot's test roster CSV.

Format (PLAN.md § Test-set format): a Cases sheet and a Personas sheet. Review markers live
on cells, not in columns: an orange fill means "add", yellow means "check", and the cell's
comment says what. They round-trip: import reads them into the case, export writes them back.

A row that fails validation is kept and shown, never dropped; it just won't run until fixed.
"""

import csv
import io
import re
from datetime import date, datetime, timedelta

from openpyxl import Workbook, load_workbook
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.comments import Comment
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

CASE_FIELDS = [
    "id",
    "status",
    "category",
    "tests",
    "persona",
    "question",
    "expected",
    "must_not",
    "sources",
    "threshold",
    "notes",
]
REQUIRED = ("id", "question", "persona", "expected")
STATUSES = ("ready", "draft", "off")
SOURCES = ("", "cite", "none")
WIDTHS = {
    "id": 8,
    "status": 8,
    "category": 16,
    "tests": 30,
    "persona": 17,
    "question": 44,
    "expected": 54,
    "must_not": 34,
    "sources": 8,
    "threshold": 9,
    "notes": 30,
}
ORANGE, YELLOW = "F8CBAD", "FFF2CC"
REVIEW_FILL = {"add": ORANGE, "check": YELLOW}
REVIEW_WORD = {"add": "ADD", "check": "CHECK"}
HEAD_FILL = PatternFill("solid", fgColor="1F1F1F")
HEAD_FONT = Font(bold=True, color="FFFFFF")
WRAP = Alignment(wrap_text=True, vertical="top")
THIN = Border(bottom=Side(style="thin", color="DDDDDD"))
TEXT_COLUMNS = {"HIREDATE", "REHIREDATE", "EMPNO"}  # never let Excel turn these into numbers or dates
BULLET = re.compile(r"^\s*(?:[-•*·]|\d{1,2}[.)])\s+")
PREFIX = re.compile(r"^\s*(ADD|CHECK)\s*[—–:-]*\s*", re.I)
RELATIVE = re.compile(r"^-(\d{1,4})d$")
CASE_ID = re.compile(r"^TC-(\d+)$")
# an id is a key and part of a URL: no spaces or slashes
ID_OK = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$")
MAX_CELL = 32000  # Excel holds 32,767 characters a cell; past that the file is reported corrupt


class WorkbookError(ValueError):
    """The file as a whole can't be imported (as opposed to a bad row, which is kept and flagged)."""


# ---------------------------------------------------------------------- cells
def _text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).replace("\r\n", "\n").replace("\r", "\n").strip()


def lines(text: str) -> list[str]:
    """Points, one per line; bullets and numbering a writer added are dropped."""
    return [BULLET.sub("", s).strip() for s in (text or "").split("\n") if BULLET.sub("", s).strip()]


def _threshold(v) -> tuple[float | None, str | None]:
    if v is None or (isinstance(v, str) and not v.strip()):
        return None, None
    try:
        s = str(v).strip()
        f = float(s[:-1]) / 100 if s.endswith("%") else float(s)
    except ValueError:
        return None, f"threshold {v!r} is not a number"
    if not 0 <= f <= 1:
        return None, f"threshold {f} must be between 0 and 1"
    return round(f, 4), None


def _fill_rgb(cell) -> str:
    fill = cell.fill
    if fill is None or fill.fill_type != "solid":
        return ""
    rgb = fill.fgColor.rgb if fill.fgColor is not None else None
    return rgb[-6:].upper() if isinstance(rgb, str) else ""


THREADED = re.compile(r"\[Threaded comment\].*?\nComment:\s*\n(.*?)(?:\nReply:|\Z)", re.S)


def comment_text(cell) -> str:
    """A cell comment's own words.

    Current Excel writes threaded comments; openpyxl sees only their legacy fallback, which
    wraps the text in boilerplate ("[Threaded comment] ... Comment:"). A classic note
    starts with its author's name on a line of its own. Strip both.
    """
    c = cell.comment
    if c is None or not c.text:
        return ""
    text = c.text.replace("\r\n", "\n")
    m = THREADED.search(text)
    if m:
        text = m.group(1)
    rows = text.strip().split("\n")
    if c.author and rows and rows[0].strip().rstrip(":") == c.author.strip() and len(rows) > 1:
        rows = rows[1:]
    return "\n".join(r.strip() for r in rows).strip()


def _review(cells: dict) -> dict | None:
    """The row's review marker: a comment anywhere in the row (expected first), else a bare fill."""
    order = ["expected", *[k for k in cells if k != "expected"]]
    for col in order:
        cell = cells.get(col)
        if cell is None:
            continue
        rgb = _fill_rgb(cell)
        text = comment_text(cell)
        if not text and rgb not in (ORANGE, YELLOW):
            continue
        m = PREFIX.match(text)
        if m:
            kind = m.group(1).lower()
            text = text[m.end() :].strip()
        else:
            kind = "add" if rgb == ORANGE else "check"
        return {"kind": kind, "note": text, "col": col}
    return None


# ---------------------------------------------------------------------- validation
def is_test_login(login: str) -> bool:
    """Real OIM logins are uppercase letters only, so a hyphenated test- login can't be one."""
    return (login or "").strip().lower().startswith("test-")


def validate_case(case: dict, logins: set[str]) -> list[str]:
    issues = list(case.get("_parse_issues", []))
    if not case.get("question"):
        issues.append("question is empty")
    p = case.get("persona", "")
    if not p:
        issues.append("persona is empty")
    elif not is_test_login(p):
        # until the chatbot locks the test token to test- senders (work order W2), a real login
        # here would query as that employee and store their profile in the results
        issues.append(f"persona {p!r} must be a test- login")
    elif p not in logins:
        issues.append(f"persona {p!r} is not on the Personas sheet")
    if case.get("status") not in STATUSES:
        issues.append("status must be ready, draft or off")
    if case.get("sources", "") not in SOURCES:
        issues.append("sources must be cite, none or blank")
    if not (lines(case.get("expected", "")) or lines(case.get("must_not", "")) or case.get("sources")):
        issues.append("nothing to grade: add expected points, a must_not, or a sources check")
    return issues


def runnable(case: dict) -> bool:
    return case.get("status") == "ready" and not case.get("issues")


def normalize_case(raw: dict, logins: set[str]) -> dict:
    """App edits and imports go through the same shape and the same checks."""
    case = dict.fromkeys(CASE_FIELDS, "")
    case["threshold"] = None
    for f in CASE_FIELDS:
        if f in raw and f != "threshold":
            case[f] = _text(raw[f])
    case["status"] = case["status"].lower() or "ready"
    case["sources"] = case["sources"].lower()
    case["expected"] = "\n".join(lines(case["expected"]))
    case["must_not"] = "\n".join(lines(case["must_not"]))
    thr, err = _threshold(raw.get("threshold"))
    case["threshold"] = thr
    case["review"] = raw.get("review") or None
    case["extra"] = dict(raw.get("extra") or {})
    if err:
        case["_parse_issues"] = [err]
    case["issues"] = validate_case(case, logins)
    case.pop("_parse_issues", None)
    return case


def next_id(taken: set[str]) -> str:
    n = max((int(m.group(1)) for t in taken if (m := CASE_ID.match(t))), default=0)
    return f"TC-{n + 1:03d}"


# ---------------------------------------------------------------------- import
def parse(data: bytes) -> dict:
    """Read a workbook into {cases, personas, persona_columns, case_extra_columns, warnings}.

    Raises WorkbookError for problems with the file as a whole; a bad row is kept, with issues.
    """
    try:
        wb = load_workbook(io.BytesIO(data), data_only=True)
    except Exception as e:  # noqa: BLE001 - any unreadable upload is the same answer to the user
        raise WorkbookError(f"not a readable .xlsx file ({type(e).__name__})") from None
    sheets = {ws.title.strip().lower(): ws for ws in wb.worksheets}
    if "cases" not in sheets:
        raise WorkbookError("no 'Cases' sheet")
    if "personas" not in sheets:
        raise WorkbookError("no 'Personas' sheet")
    personas, persona_columns = _parse_personas(sheets["personas"])
    logins = {p["USERLOGIN"] for p in personas}
    cases, extra_cols, warnings = _parse_cases(sheets["cases"], logins)
    return {
        "cases": cases,
        "personas": personas,
        "persona_columns": persona_columns,
        "case_extra_columns": extra_cols,
        "warnings": warnings,
    }


def _header(ws) -> list[str]:
    return [_text(c.value) for c in ws[1]] if ws.max_row >= 1 else []


def _parse_personas(ws) -> tuple[list[dict], list[str]]:
    head = _header(ws)
    cols = [h for h in head if h]
    norm = ["USERLOGIN" if h.lower() == "userlogin" else h for h in head]
    if "USERLOGIN" not in norm:
        raise WorkbookError("the Personas sheet has no USERLOGIN column")
    if len(set(cols)) != len(cols):
        raise WorkbookError("the Personas sheet repeats a column name")
    cols = [c for c in norm if c]
    out, seen, dupes = [], set(), set()
    for row in ws.iter_rows(min_row=2):
        cells = {norm[i]: c for i, c in enumerate(row) if i < len(norm) and norm[i]}
        values = {k: _text(c.value) for k, c in cells.items()}
        if not any(values.values()):
            continue
        login = values.get("USERLOGIN", "")
        if not login:
            raise WorkbookError(f"Personas row {row[0].row} has no USERLOGIN")
        if login in seen:
            dupes.add(login)
        seen.add(login)
        p = {c: values.get(c, "") for c in cols}
        comments = {k: t for k, c in cells.items() if (t := comment_text(c))}
        if comments:
            p["_comments"] = comments
        out.append(p)
    if dupes:
        raise WorkbookError(f"Personas repeats USERLOGIN {', '.join(sorted(dupes))}")
    real = [p["USERLOGIN"] for p in out if not is_test_login(p["USERLOGIN"])]
    if real:
        raise WorkbookError(
            f"Personas must be test- logins; found {', '.join(real[:5])}. "
            "A real login would make the chatbot answer as that employee."
        )
    return out, cols


def _parse_cases(ws, logins: set[str]) -> tuple[list[dict], list[str], list[str]]:
    head = _header(ws)
    keys = [h.lower() if h.lower() in CASE_FIELDS else h for h in head]
    missing = [f for f in REQUIRED if f not in keys]
    if missing:
        raise WorkbookError(f"the Cases sheet is missing column(s): {', '.join(missing)}")
    extra_cols = [k for k in keys if k and k not in CASE_FIELDS]
    raws, warnings = [], []
    for row in ws.iter_rows(min_row=2):
        cells = {keys[i]: c for i, c in enumerate(row) if i < len(keys) and keys[i]}
        values = {k: c.value for k, c in cells.items()}
        if not any(_text(v) for v in values.values()):
            continue
        raw = {f: values.get(f) for f in CASE_FIELDS}
        raw["extra"] = {k: _text(values.get(k)) for k in extra_cols}
        raw["review"] = _review(cells)
        raw["_row"] = row[0].row
        raws.append(raw)
    ids = [_text(r["id"]) for r in raws if _text(r["id"])]
    bad = [i for i in ids if not ID_OK.match(i)]
    if bad:
        raise WorkbookError(
            f"Case ids may use letters, digits, . _ - only (no spaces or slashes): {', '.join(bad[:5])}"
        )
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise WorkbookError(f"Cases repeats id {', '.join(dupes)}")
    taken = set(ids)
    cases = []
    for raw in raws:
        if not _text(raw["id"]):
            raw["id"] = next_id(taken)
            taken.add(raw["id"])
            warnings.append(f"row {raw['_row']} had no id; assigned {raw['id']}")
        if not _text(raw.get("status")) and raw["review"] and raw["review"]["kind"] == "add":
            raw["status"] = "draft"  # a row still waiting for information shouldn't run
        cases.append(normalize_case(raw, logins))
    return cases, extra_cols, warnings


# ---------------------------------------------------------------------- diff
def _case_view(c: dict) -> dict:
    return {**{f: c.get(f) for f in CASE_FIELDS}, "review": c.get("review"), "extra": c.get("extra") or {}}


def diff(current: dict, incoming: dict) -> dict:
    """What applying `incoming` would change, including in-app edits it would undo."""
    old = {c["id"]: _case_view(c) for c in current["cases"]}
    new = {c["id"]: _case_view(c) for c in incoming["cases"]}
    edited = set(current.get("edited", []))
    changed = []
    for i in new.keys() & old.keys():
        fields = [f for f in [*CASE_FIELDS, "review", "extra"] if old[i].get(f) != new[i].get(f)]
        if fields:
            changed.append({"id": i, "fields": fields})
    removed = sorted(old.keys() - new.keys())
    reverts = sorted(i for i in edited if i in removed or any(ch["id"] == i for ch in changed))
    op = {p["USERLOGIN"]: p for p in current["personas"]}
    np = {p["USERLOGIN"]: p for p in incoming["personas"]}
    return {
        "cases": {
            "added": sorted(new.keys() - old.keys()),
            "removed": removed,
            "changed": sorted(changed, key=lambda x: x["id"]),
            "unchanged": len(old.keys() & new.keys()) - len(changed),
            "reverts_in_app_edits": reverts,
        },
        "personas": {
            "added": sorted(np.keys() - op.keys()),
            "removed": sorted(op.keys() - np.keys()),
            "changed": sorted(i for i in np.keys() & op.keys() if np[i] != op[i]),
            "columns_changed": current.get("persona_columns") != incoming.get("persona_columns"),
        },
        "issues": [{"id": c["id"], "issues": c["issues"]} for c in incoming["cases"] if c.get("issues")],
        "warnings": incoming.get("warnings", []),
    }


# ---------------------------------------------------------------------- export
def _head(ws, names: list[str], widths: dict) -> None:
    for i, name in enumerate(names, 1):
        cell = ws.cell(row=1, column=i, value=name)
        cell.fill, cell.font = HEAD_FILL, HEAD_FONT
        cell.alignment = Alignment(vertical="center")
        ws.column_dimensions[get_column_letter(i)].width = widths.get(name, 14)
    ws.freeze_panes = "B2"


def _clean(v):
    """Strings are made safe for a cell: no control characters openpyxl refuses, within
    Excel's length limit."""
    if not isinstance(v, str):
        return v
    v = ILLEGAL_CHARACTERS_RE.sub("", v)
    return v if len(v) <= MAX_CELL else v[:MAX_CELL] + " …[truncated]"


def _put(ws, row: int, col: int, v):
    """Write a value as data, never as a formula. openpyxl turns any string starting with '='
    into a live formula, and answers under test are attacker-influenced (red-team cases)."""
    v = _clean(v)
    cell = ws.cell(row=row, column=col, value=v if v not in ("", None) else None)
    if isinstance(v, str) and v:
        cell.data_type = "s"
    return cell


def _note(cell, text: str) -> None:
    c = Comment(_clean(text), "Test set")
    c.width, c.height = 320, 110
    cell.comment = c


def export(cases: list[dict], personas: list[dict], persona_columns: list[str], extra_columns: list[str]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.title = "Cases"
    cols = [*CASE_FIELDS, *extra_columns]
    _head(ws, cols, WIDTHS)
    for r, case in enumerate(cases, 2):
        for i, col in enumerate(cols, 1):
            v = case.get(col) if col in CASE_FIELDS else (case.get("extra") or {}).get(col)
            cell = _put(ws, r, i, v)
            cell.alignment, cell.border = WRAP, THIN
        ws.cell(row=r, column=cols.index("threshold") + 1).number_format = "0.00"
        rv = case.get("review")
        if rv and rv.get("kind") in REVIEW_FILL:
            col = rv.get("col") if rv.get("col") in cols else "expected"
            cell = ws.cell(row=r, column=cols.index(col) + 1)
            cell.fill = PatternFill("solid", fgColor=REVIEW_FILL[rv["kind"]])
            _note(cell, f"{REVIEW_WORD[rv['kind']]} — {rv.get('note', '')}".rstrip(" —"))
    last = max(len(cases) + 1, 2)
    end = get_column_letter(len(cols))
    ws.auto_filter.ref = f"A1:{end}{last}"
    ws.conditional_formatting.add(
        f"A2:{end}{max(last, 500)}", FormulaRule(formula=['$B2="off"'], font=Font(color="9A9A9A"))
    )

    def dv(sheet, formula: str, rng: str, kind: str = "list", **kw) -> None:
        v = DataValidation(type=kind, formula1=formula, allow_blank=True, **kw)
        sheet.add_data_validation(v)
        v.add(rng)

    L = {c: get_column_letter(cols.index(c) + 1) for c in CASE_FIELDS}
    dv(ws, '"ready,draft,off"', f"{L['status']}2:{L['status']}500")
    dv(ws, '"cite,none"', f"{L['sources']}2:{L['sources']}500")
    dv(ws, "0", f"{L['threshold']}2:{L['threshold']}500", "decimal", operator="between", formula2="1")

    wp = wb.create_sheet("Personas")
    _head(wp, persona_columns, {"USERLOGIN": 19, "purpose": 36, "LOCATION": 23, "BUSINESSTITLE": 26, "EMAIL": 30})
    for r, p in enumerate(personas, 2):
        for i, col in enumerate(persona_columns, 1):
            cell = _put(wp, r, i, p.get(col))
            cell.alignment, cell.border = WRAP, THIN
            if col in TEXT_COLUMNS:
                cell.number_format = "@"
            if (p.get("_comments") or {}).get(col):
                _note(cell, p["_comments"][col])
    plast = max(len(personas) + 1, 2)
    if "USERLOGIN" in persona_columns:
        # a named range, not a direct sheet reference: Excel stores the latter in an extension
        # that openpyxl drops on load, which silently removed this dropdown once
        ul = get_column_letter(persona_columns.index("USERLOGIN") + 1)
        wb.defined_names["PersonaList"] = DefinedName("PersonaList", attr_text=f"Personas!${ul}$2:${ul}${plast + 50}")
        dv(ws, "=PersonaList", f"{L['persona']}2:{L['persona']}500")
    for col, opts in (("in_roster", '"Y,N"'), ("USERTYPE", '"Full-Time,Contractor"')):
        if col in persona_columns:
            c = get_column_letter(persona_columns.index(col) + 1)
            dv(wp, opts, f"{c}2:{c}{plast + 50}")
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


# ---------------------------------------------------------------------- roster CSV
def roster_columns(persona_columns: list[str]) -> list[str]:
    """The roster's own columns are the UPPERCASE ones; lowercase columns are notes."""
    return [c for c in persona_columns if c == c.upper() and any(ch.isalpha() for ch in c)]


def roster_csv(
    personas: list[dict], persona_columns: list[str], resolve_dates: bool = False, today: date | None = None
) -> str:
    cols = roster_columns(persona_columns)
    today = today or date.today()
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(cols)
    for p in personas:
        if str(p.get("in_roster", "Y")).strip().upper() == "N":
            continue
        row = []
        for c in cols:
            v = p.get(c, "") or ""
            if resolve_dates and (m := RELATIVE.match(v)):
                v = (today - timedelta(days=int(m.group(1)))).isoformat()
            row.append(v)
        w.writerow(row)
    return buf.getvalue()


# ---------------------------------------------------------------------- personas in the app
# the roster columns the chatbot reads, for a test set that has never been imported
DEFAULT_PERSONA_COLUMNS = [
    "USERLOGIN", "in_roster", "purpose", "COUNTRY", "STATE", "LOCATION", "DIVISION", "BUSINESSUNIT",
    "DEPARTMENT", "BUSINESSTITLE", "USERTYPE", "FIRSTNAME", "LASTNAME", "PREFERREDNAME", "EMAIL",
    "EMPNO", "HIREDATE", "REHIREDATE", "LOA", "MANAGERLOGIN", "MGRLVL1", "MGRLVL2",
]  # fmt: skip
LOGIN_OK = re.compile(r"^test-[a-z0-9][a-z0-9-]{0,39}$", re.I)
DATE_OK = re.compile(r"^(\d{4}-\d{2}-\d{2}|-\d{1,4}d)$")
LOGIN_REFS = ("MANAGERLOGIN", "MGRLVL1", "MGRLVL2")


def normalize_persona(raw: dict, columns: list[str], logins: set[str]) -> dict:
    """One persona from the app, in the sheet's columns. Raises ValueError with what to fix."""
    p = {c: _text(raw.get(c)) for c in columns}
    login = p.get("USERLOGIN", "")
    if not LOGIN_OK.match(login):
        raise ValueError("the login must start test- and use letters, digits and - only")
    if p.get("in_roster", "Y").upper() not in ("Y", "N", ""):
        raise ValueError("in_roster is Y or N")
    for c in ("HIREDATE", "REHIREDATE"):
        if p.get(c) and not DATE_OK.match(p[c]):
            raise ValueError(f"{c} is a date (2024-03-01) or days ago (-10d)")
    for c in LOGIN_REFS:  # a manager chain may only point at other test personas
        if p.get(c) and p[c] not in logins | {login}:
            raise ValueError(f"{c} {p[c]!r} is not a persona")
    if "_comments" in raw:
        p["_comments"] = raw["_comments"]
    return p
