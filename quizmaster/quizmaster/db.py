"""SQLite storage.

* ``categories``  – hierarchical question catalog (``parent_id`` NULL = top level)
* ``questions``   – catalog questions (JSON documents) in a category
* ``quizzes``     – named collections of catalog questions (+ print settings)
* ``quiz_items``  – ordered references quiz -> question, with optional points override;
                    rows without a question are section headings (``section`` = JSON {name, visible})
"""

from __future__ import annotations

import html
import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DB = Path(__file__).resolve().parent.parent / "data" / "quizmaster.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id INTEGER REFERENCES categories(id),
    name TEXT NOT NULL,
    info TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id INTEGER NOT NULL REFERENCES categories(id),
    data TEXT NOT NULL,
    summary TEXT NOT NULL,
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_questions_category ON questions(category_id);
CREATE TABLE IF NOT EXISTS quizzes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    settings TEXT NOT NULL DEFAULT '{}',
    created TEXT NOT NULL,
    updated TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quiz_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
    question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    points REAL,
    section TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_quiz ON quiz_items(quiz_id, position);
CREATE INDEX IF NOT EXISTS idx_items_question ON quiz_items(question_id);
"""


class NotFound(Exception):
    pass


class Invalid(Exception):
    pass


def db_path() -> Path:
    return Path(os.environ.get("QUIZMASTER_DB") or DEFAULT_DB)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _init(conn) -> None:
    for statement in SCHEMA.split(";"):
        if statement.strip():
            conn.execute(statement)
    _migrate_sections(conn)


def _migrate_sections(conn) -> None:
    """Older databases: ``quiz_items.question_id`` was NOT NULL and there was no ``section`` column."""
    cols = {r["name"]: r for r in conn.execute("PRAGMA table_info(quiz_items)")}
    if "section" in cols and not cols["question_id"]["notnull"]:
        return
    conn.execute("""CREATE TABLE quiz_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        points REAL,
        section TEXT
    )""")
    section = "section" if "section" in cols else "NULL"
    conn.execute(f"""INSERT INTO quiz_items_new (id, quiz_id, question_id, position, points, section)
                     SELECT id, quiz_id, question_id, position, points, {section} FROM quiz_items""")
    conn.execute("DROP TABLE quiz_items")
    conn.execute("ALTER TABLE quiz_items_new RENAME TO quiz_items")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_items_quiz ON quiz_items(quiz_id, position)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_items_question ON quiz_items(question_id)")
    conn.commit()


@contextmanager
def connect():
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        _init(conn)
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _snippet(markup: str, limit: int = 240) -> str:
    text = re.sub(r"<img[^>]*>", " [image] ", markup or "")
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    text = re.sub(r"\s+", " ", text).strip()
    return text[:limit]


def _summary(data: dict) -> dict:
    return {
        "type": data.get("type"),
        "name": data.get("name", ""),
        "tags": data.get("tags", []),
        "snippet": _snippet(data.get("questiontext", "")),
        "defaultgrade": data.get("defaultgrade", 1),
        "hidden": bool(data.get("hidden")),
    }


def _clean(data: dict) -> dict:
    return {k: v for k, v in data.items() if k not in ("id", "category_id", "quiz_count", "archived_count", "created", "updated", "item_id", "points", "position")}


# ------------------------------------------------------------------ categories


def list_categories() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT c.*, (SELECT COUNT(*) FROM questions q WHERE q.category_id = c.id) AS question_count
               FROM categories c ORDER BY c.position, c.name COLLATE NOCASE"""
        ).fetchall()
        return [dict(r) for r in rows]


def _category(conn, cat_id: int) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone()
    if row is None:
        raise NotFound("Category not found")
    return row


def category_path(cat_id: int) -> list[str]:
    with connect() as conn:
        return _path(conn, cat_id)


def _path(conn, cat_id: int) -> list[str]:
    names = []
    while cat_id is not None:
        row = _category(conn, cat_id)
        names.append(row["name"])
        cat_id = row["parent_id"]
    return names[::-1]


def _descendants(conn, cat_id: int) -> list[int]:
    """The category itself and all categories below it (depth-first, sorted by name)."""
    out = [cat_id]
    for row in conn.execute("SELECT id FROM categories WHERE parent_id = ? ORDER BY position, name COLLATE NOCASE", (cat_id,)).fetchall():
        out += _descendants(conn, row["id"])
    return out


def _ensure_path(conn, names: list[str], parent_id: int | None, info: str = "") -> int:
    """Return the id of the category ``names`` below ``parent_id``, creating it as needed."""
    for i, name in enumerate(names):
        row = conn.execute(
            "SELECT id FROM categories WHERE name = ? AND parent_id IS ?", (name, parent_id)
        ).fetchone()
        if row:
            parent_id = row["id"]
        else:
            cur = conn.execute(
                "INSERT INTO categories (parent_id, name, info) VALUES (?, ?, ?)",
                (parent_id, name, info if i == len(names) - 1 else ""),
            )
            parent_id = cur.lastrowid
    return parent_id


def ensure_path(names: list[str], parent_id: int | None = None, info: str = "") -> int:
    with connect() as conn:
        if parent_id is not None:
            _category(conn, parent_id)
        return _ensure_path(conn, names, parent_id, info)


def create_category(name: str, parent_id: int | None = None, info: str = "") -> int:
    with connect() as conn:
        if parent_id is not None:
            _category(conn, parent_id)
        return conn.execute(
            "INSERT INTO categories (parent_id, name, info) VALUES (?, ?, ?)", (parent_id, name, info)
        ).lastrowid


def update_category(cat_id: int, fields: dict) -> None:
    with connect() as conn:
        _category(conn, cat_id)
        if "parent_id" in fields:
            parent = fields["parent_id"]
            if parent is not None and parent in _descendants(conn, cat_id):
                raise Invalid("A category cannot be moved into itself or one of its subcategories")
            if parent is not None:
                _category(conn, parent)
            conn.execute("UPDATE categories SET parent_id = ? WHERE id = ?", (parent, cat_id))
        for key in ("name", "info"):
            if key in fields:
                conn.execute(f"UPDATE categories SET {key} = ? WHERE id = ?", (fields[key], cat_id))


def delete_category(cat_id: int) -> None:
    """Delete a category; its questions and subcategories move to the parent category."""
    with connect() as conn:
        row = _category(conn, cat_id)
        parent = row["parent_id"]
        has_questions = conn.execute("SELECT 1 FROM questions WHERE category_id = ?", (cat_id,)).fetchone()
        if parent is None and has_questions:
            raise Invalid("This top-level category still contains questions. Move or delete them first.")
        conn.execute("UPDATE questions SET category_id = ? WHERE category_id = ?", (parent, cat_id))
        conn.execute("UPDATE categories SET parent_id = ? WHERE parent_id = ?", (parent, cat_id))
        conn.execute("DELETE FROM categories WHERE id = ?", (cat_id,))


# ------------------------------------------------------------------- questions


def list_question_summaries() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT q.id, q.category_id, q.summary, q.updated,
                      (SELECT COUNT(DISTINCT quiz_id) FROM quiz_items i WHERE i.question_id = q.id) AS quiz_count,
                      (SELECT COUNT(DISTINCT i.quiz_id) FROM quiz_items i JOIN quizzes z ON z.id = i.quiz_id
                        WHERE i.question_id = q.id AND json_extract(z.settings, '$.archived')) AS archived_count
               FROM questions q ORDER BY q.id"""
        ).fetchall()
        return [
            {"id": r["id"], "category_id": r["category_id"], "updated": r["updated"],
             "quiz_count": r["quiz_count"], "archived_count": r["archived_count"], **json.loads(r["summary"])}
            for r in rows
        ]


def _question(row: sqlite3.Row) -> dict:
    return {"id": row["id"], "category_id": row["category_id"], "updated": row["updated"], **json.loads(row["data"])}


def get_question(qid: int) -> dict:
    with connect() as conn:
        row = conn.execute("SELECT * FROM questions WHERE id = ?", (qid,)).fetchone()
        if row is None:
            raise NotFound("Question not found")
        q = _question(row)
        q["quizzes"] = [
            dict(r)
            for r in conn.execute(
                "SELECT DISTINCT z.id, z.name FROM quiz_items i JOIN quizzes z ON z.id = i.quiz_id WHERE i.question_id = ? ORDER BY z.name",
                (qid,),
            )
        ]
        return q


def get_questions(ids: list[int]) -> list[dict]:
    """Full questions in the order of ``ids``."""
    if not ids:
        return []
    with connect() as conn:
        marks = ",".join("?" * len(ids))
        rows = {r["id"]: _question(r) | {"quizzes": []} for r in conn.execute(f"SELECT * FROM questions WHERE id IN ({marks})", ids)}
        for r in conn.execute(
            f"""SELECT DISTINCT i.question_id, z.id, z.name, json_extract(z.settings, '$.archived') AS archived
                FROM quiz_items i JOIN quizzes z ON z.id = i.quiz_id
                WHERE i.question_id IN ({marks}) ORDER BY z.name""",
            ids,
        ):
            rows[r["question_id"]]["quizzes"].append({"id": r["id"], "name": r["name"], "archived": bool(r["archived"])})
        return [rows[i] for i in ids if i in rows]


def questions_by_category(cat_ids: list[int] | None = None) -> list[tuple[list[str], str, list[dict]]]:
    """``[(path, info, [questions])]`` for the given categories and their subcategories
    (all categories if None), in depth-first order."""
    with connect() as conn:
        if cat_ids is None:
            roots = [r["id"] for r in conn.execute("SELECT id FROM categories WHERE parent_id IS NULL ORDER BY position, name COLLATE NOCASE")]
        else:
            roots = cat_ids
        seen, order = set(), []
        for root in roots:
            for cid in _descendants(conn, root):
                if cid not in seen:
                    seen.add(cid)
                    order.append(cid)
        out = []
        for cid in order:
            rows = conn.execute("SELECT * FROM questions WHERE category_id = ? ORDER BY id", (cid,)).fetchall()
            info = _category(conn, cid)["info"]
            out.append((_path(conn, cid), info, [_question(r) for r in rows]))
        return out


def create_questions(category_id: int, questions: list[dict]) -> list[int]:
    now = _now()
    with connect() as conn:
        _category(conn, category_id)
        ids = []
        for q in questions:
            data = _clean(q)
            ids.append(conn.execute(
                "INSERT INTO questions (category_id, data, summary, created, updated) VALUES (?, ?, ?, ?, ?)",
                (category_id, json.dumps(data), json.dumps(_summary(data)), now, now),
            ).lastrowid)
        return ids


def update_question(qid: int, data: dict) -> None:
    with connect() as conn:
        row = conn.execute("SELECT category_id FROM questions WHERE id = ?", (qid,)).fetchone()
        if row is None:
            raise NotFound("Question not found")
        category_id = data.get("category_id") or row["category_id"]
        _category(conn, category_id)
        clean = _clean(data)
        clean.pop("quizzes", None)
        conn.execute(
            "UPDATE questions SET category_id = ?, data = ?, summary = ?, updated = ? WHERE id = ?",
            (category_id, json.dumps(clean), json.dumps(_summary(clean)), _now(), qid),
        )
        for r in conn.execute("SELECT DISTINCT quiz_id FROM quiz_items WHERE question_id = ?", (qid,)).fetchall():
            conn.execute("UPDATE quizzes SET updated = ? WHERE id = ?", (_now(), r["quiz_id"]))


def move_questions(ids: list[int], category_id: int) -> None:
    with connect() as conn:
        _category(conn, category_id)
        conn.executemany("UPDATE questions SET category_id = ? WHERE id = ?", [(category_id, i) for i in ids])


def delete_questions(ids: list[int]) -> None:
    with connect() as conn:
        conn.executemany("DELETE FROM questions WHERE id = ?", [(i,) for i in ids])


# --------------------------------------------------------------------- quizzes


def list_quizzes() -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            """SELECT z.id, z.name, z.description, z.settings, z.created, z.updated,
                      COUNT(i.question_id) AS question_count
               FROM quizzes z LEFT JOIN quiz_items i ON i.quiz_id = z.id
               GROUP BY z.id ORDER BY z.updated DESC"""
        ).fetchall()
        quizzes = [dict(r) for r in rows]
    for quiz in quizzes:
        quiz["archived"] = bool(json.loads(quiz.pop("settings") or "{}").get("archived"))
    summaries = {s["id"]: s for s in list_question_summaries()}
    for quiz in quizzes:
        quiz["points"] = sum(it["points"] for it in _items(quiz["id"], summaries))
    return quizzes


def _items(quiz_id: int, summaries: dict | None = None) -> list[dict]:
    summaries = summaries if summaries is not None else {s["id"]: s for s in list_question_summaries()}
    with connect() as conn:
        rows = conn.execute("SELECT * FROM quiz_items WHERE quiz_id = ? ORDER BY position, id", (quiz_id,)).fetchall()
    items = []
    for r in rows:
        s = summaries.get(r["question_id"])
        if s is None:
            continue
        items.append({
            "item_id": r["id"],
            "position": r["position"],
            "points_override": r["points"],
            "points": r["points"] if r["points"] is not None else float(s.get("defaultgrade") or 0),
            "question": s,
        })
    return items


def get_quiz(quiz_id: int) -> dict:
    with connect() as conn:
        row = conn.execute("SELECT * FROM quizzes WHERE id = ?", (quiz_id,)).fetchone()
        if row is None:
            raise NotFound("Quiz not found")
        quiz = dict(row)
    quiz["settings"] = json.loads(quiz["settings"] or "{}")
    quiz["archived"] = bool(quiz["settings"].get("archived"))
    quiz["items"] = _items(quiz_id)
    quiz["sections"] = _sections(quiz_id)
    return quiz


def _sections(quiz_id: int) -> list[dict]:
    """Section headings of a quiz; they share the position order with the question items."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT * FROM quiz_items WHERE quiz_id = ? AND question_id IS NULL ORDER BY position, id", (quiz_id,)
        ).fetchall()
    out = []
    for r in rows:
        data = json.loads(r["section"] or "{}")
        out.append({"item_id": r["id"], "position": r["position"],
                    "name": data.get("name", ""), "visible": bool(data.get("visible", True))})
    return out


def quiz_questions(quiz_id: int) -> list[dict]:
    """Full questions of a quiz, in order, with ``defaultgrade`` replaced by the quiz points."""
    items = get_quiz(quiz_id)["items"]
    full = {q["id"]: q for q in get_questions([it["question"]["id"] for it in items])}
    out = []
    for it in items:
        q = dict(full[it["question"]["id"]])
        q["defaultgrade"] = it["points"]
        q["item_id"] = it["item_id"]
        q["position"] = it["position"]
        out.append(q)
    return out


def create_quiz(name: str, description: str = "", settings: dict | None = None) -> int:
    now = _now()
    with connect() as conn:
        return conn.execute(
            "INSERT INTO quizzes (name, description, settings, created, updated) VALUES (?, ?, ?, ?, ?)",
            (name, description, json.dumps(settings or {}), now, now),
        ).lastrowid


def update_quiz(quiz_id: int, fields: dict) -> None:
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM quizzes WHERE id = ?", (quiz_id,)).fetchone():
            raise NotFound("Quiz not found")
        for key in ("name", "description"):
            if key in fields:
                conn.execute(f"UPDATE quizzes SET {key} = ? WHERE id = ?", (fields[key], quiz_id))
        if "settings" in fields:
            # The archive flag is only changed through set_archived().
            old = json.loads(conn.execute("SELECT settings FROM quizzes WHERE id = ?", (quiz_id,)).fetchone()[0] or "{}")
            new = {k: v for k, v in (fields["settings"] or {}).items() if k != "archived"}
            if old.get("archived"):
                new["archived"] = True
            conn.execute("UPDATE quizzes SET settings = ? WHERE id = ?", (json.dumps(new), quiz_id))
        conn.execute("UPDATE quizzes SET updated = ? WHERE id = ?", (_now(), quiz_id))


def set_archived(quiz_id: int, archived: bool) -> None:
    """Archive or unarchive a quiz (stored in its settings; does not change ``updated``)."""
    with connect() as conn:
        row = conn.execute("SELECT settings FROM quizzes WHERE id = ?", (quiz_id,)).fetchone()
        if row is None:
            raise NotFound("Quiz not found")
        settings = json.loads(row[0] or "{}")
        if archived:
            settings["archived"] = True
        else:
            settings.pop("archived", None)
        conn.execute("UPDATE quizzes SET settings = ? WHERE id = ?", (json.dumps(settings), quiz_id))


def delete_quiz(quiz_id: int) -> None:
    with connect() as conn:
        conn.execute("DELETE FROM quizzes WHERE id = ?", (quiz_id,))


def duplicate_quiz(quiz_id: int) -> int:
    quiz = get_quiz(quiz_id)
    settings = {k: v for k, v in quiz["settings"].items() if k != "archived"}  # a copy starts out active
    new_id = create_quiz(quiz["name"] + " (copy)", quiz["description"], settings)
    with connect() as conn:
        conn.execute(
            """INSERT INTO quiz_items (quiz_id, question_id, position, points, section)
               SELECT ?, question_id, position, points, section FROM quiz_items WHERE quiz_id = ? ORDER BY position, id""",
            (new_id, quiz_id),
        )
    return new_id


def _section_json(name, visible) -> str:
    return json.dumps({"name": str(name or "").strip(), "visible": bool(visible)})


def add_section(quiz_id: int, name: str, visible: bool = True, before_item_id: int | None = None) -> int:
    """Insert a section heading before ``before_item_id`` (at the end if None)."""
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM quizzes WHERE id = ?", (quiz_id,)).fetchone():
            raise NotFound("Quiz not found")
        ids = [r[0] for r in conn.execute("SELECT id FROM quiz_items WHERE quiz_id = ? ORDER BY position, id", (quiz_id,))]
        new_id = conn.execute(
            "INSERT INTO quiz_items (quiz_id, question_id, position, section) VALUES (?, NULL, 0, ?)",
            (quiz_id, _section_json(name, visible)),
        ).lastrowid
        ids.insert(ids.index(before_item_id) if before_item_id in ids else len(ids), new_id)
        for pos, item_id in enumerate(ids):
            conn.execute("UPDATE quiz_items SET position = ? WHERE id = ?", (pos, item_id))
        conn.execute("UPDATE quizzes SET updated = ? WHERE id = ?", (_now(), quiz_id))
        return new_id


def add_items(quiz_id: int, question_ids: list[int], after_position: int | None = None,
              before_item_id: int | None = None) -> int:
    """Add catalog questions to a quiz (questions already in the quiz are skipped), at the end,
    after ``after_position`` or before the item ``before_item_id`` (question or section)."""
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM quizzes WHERE id = ?", (quiz_id,)).fetchone():
            raise NotFound("Quiz not found")
        present = {r[0] for r in conn.execute("SELECT question_id FROM quiz_items WHERE quiz_id = ?", (quiz_id,))}
        new = []
        for qid in question_ids:
            if qid not in present and conn.execute("SELECT 1 FROM questions WHERE id = ?", (qid,)).fetchone():
                new.append(qid)
                present.add(qid)
        if before_item_id is not None:
            ids = [r[0] for r in conn.execute("SELECT id FROM quiz_items WHERE quiz_id = ? ORDER BY position, id", (quiz_id,))]
            at = ids.index(before_item_id) if before_item_id in ids else len(ids)
            for qid in new:
                ids.insert(at, conn.execute(
                    "INSERT INTO quiz_items (quiz_id, question_id, position) VALUES (?, ?, 0)", (quiz_id, qid)).lastrowid)
                at += 1
            for pos, item_id in enumerate(ids):
                conn.execute("UPDATE quiz_items SET position = ? WHERE id = ?", (pos, item_id))
            conn.execute("UPDATE quizzes SET updated = ? WHERE id = ?", (_now(), quiz_id))
            return len(new)
        if after_position is None:
            start = conn.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM quiz_items WHERE quiz_id = ?", (quiz_id,)).fetchone()[0]
        else:
            start = after_position + 1
            conn.execute("UPDATE quiz_items SET position = position + ? WHERE quiz_id = ? AND position >= ?", (len(new), quiz_id, start))
        for i, qid in enumerate(new):
            conn.execute("INSERT INTO quiz_items (quiz_id, question_id, position) VALUES (?, ?, ?)", (quiz_id, qid, start + i))
        conn.execute("UPDATE quizzes SET updated = ? WHERE id = ?", (_now(), quiz_id))
        return len(new)


def update_item(quiz_id: int, item_id: int, fields: dict) -> None:
    """``points`` for a question item; ``name`` / ``visible`` for a section."""
    with connect() as conn:
        row = conn.execute("SELECT * FROM quiz_items WHERE id = ? AND quiz_id = ?", (item_id, quiz_id)).fetchone()
        if row is None:
            raise NotFound("Quiz item not found")
        if row["question_id"] is None and ("name" in fields or "visible" in fields):
            old = json.loads(row["section"] or "{}")
            conn.execute("UPDATE quiz_items SET section = ? WHERE id = ?", (
                _section_json(fields.get("name", old.get("name")), fields.get("visible", old.get("visible", True))), item_id))
        if "points" in fields:
            pts = fields["points"]
            conn.execute(
                "UPDATE quiz_items SET points = ? WHERE id = ? AND quiz_id = ?",
                (None if pts in (None, "") else float(pts), item_id, quiz_id),
            )
        conn.execute("UPDATE quizzes SET updated = ? WHERE id = ?", (_now(), quiz_id))


def remove_items(quiz_id: int, item_ids: list[int]) -> None:
    with connect() as conn:
        conn.executemany("DELETE FROM quiz_items WHERE id = ? AND quiz_id = ?", [(i, quiz_id) for i in item_ids])
        conn.execute("UPDATE quizzes SET updated = ? WHERE id = ?", (_now(), quiz_id))


def reorder_items(quiz_id: int, item_ids: list[int]) -> None:
    with connect() as conn:
        for pos, item_id in enumerate(item_ids):
            conn.execute("UPDATE quiz_items SET position = ? WHERE id = ? AND quiz_id = ?", (pos, item_id, quiz_id))
        conn.execute("UPDATE quizzes SET updated = ? WHERE id = ?", (_now(), quiz_id))
