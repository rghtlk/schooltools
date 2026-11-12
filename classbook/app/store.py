"""The computer's copy of the data, and the sync that merges the phone's copy into it.

Every record — a class, a student, a course, a mark, an absence — is stored the
same way: which table it belongs to, a UUID, its fields as JSON, when it was
last changed and by which device, and whether it has been deleted.

    records(tbl, id, data, updated_at, device, deleted, rev)

Sync is last-writer-wins per record. A device sends what it changed and gets
back everything that changed since it last asked; when two devices changed the
same record, the later ``(updated_at, device)`` wins, on both sides, so the two
copies always end up identical. Deletions are kept as tombstones
(``deleted = 1``) so that they travel too.

``rev`` is the server's own counter, bumped for every accepted write. A device
remembers the highest ``rev`` it has seen and asks for everything above it,
which means no device ever has to trust another's clock to find out what is new.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import uuid
import datetime as dt
from pathlib import Path
from typing import Any

TABLES = (
    "classes", "students", "courses", "entries", "absences",
    # planning
    "years", "holidays", "cancellations", "extras", "topics", "files",
    "settings",   # shared by all devices, e.g. the symbols for the marks
    # grading
    "categories", "submissions", "scores",
)
MAX_RECORD_BYTES = 600_000   # a resized photo is ~20 kB; this is generous
PAGE_SIZE = 400

SCHEMA = """
CREATE TABLE IF NOT EXISTS records (
    tbl        TEXT    NOT NULL,
    id         TEXT    NOT NULL,
    data       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL,
    device     TEXT    NOT NULL,
    deleted    INTEGER NOT NULL DEFAULT 0,
    rev        INTEGER NOT NULL,
    PRIMARY KEY (tbl, id)
);
CREATE INDEX IF NOT EXISTS records_rev ON records(rev);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
"""


class SyncError(ValueError):
    """A change that cannot be accepted as sent."""


class Store:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()   # reads take it too; sync() reads inside it
        self._db = sqlite3.connect(path, check_same_thread=False)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.executescript(SCHEMA)
        # Names this database. A device that finds a different one here (the
        # file was reset or restored from a backup) sends its whole copy again,
        # since the rev it remembers no longer means anything.
        self._db.execute("INSERT OR IGNORE INTO meta VALUES ('store_id', ?)",
                         (uuid.uuid4().hex,))
        self._db.commit()
        self.store_id = self._db.execute(
            "SELECT value FROM meta WHERE key='store_id'").fetchone()[0]

    def close(self) -> None:
        self._db.close()

    # --- sync ---------------------------------------------------------------

    def current_rev(self) -> int:
        with self._lock:
            row = self._db.execute("SELECT COALESCE(MAX(rev), 0) FROM records").fetchone()
        return row[0]

    def sync(self, since: int, changes: list[dict[str, Any]]) -> dict[str, Any]:
        """Apply ``changes``, then return what changed after ``since``.

        The reply is paged: when ``more`` is true the device asks again with
        ``since = rev`` until it is not.
        """
        # A record that cannot be accepted is turned away on its own: one bad
        # record (too large, say) must not stop a device from syncing at all.
        clean, rejected = [], []
        for c in changes:
            try:
                clean.append(_validate(c))
            except SyncError as exc:
                ident = {k: c.get(k) for k in ("tbl", "id")} if isinstance(c, dict) else {}
                rejected.append({**ident, "reason": str(exc)})
        with self._lock:
            accepted = 0
            with self._db:   # one transaction for the whole push
                rev = self.current_rev()
                for c in clean:
                    row = self._db.execute(
                        "SELECT updated_at, device FROM records WHERE tbl=? AND id=?",
                        (c["tbl"], c["id"]),
                    ).fetchone()
                    if row is not None and (row[0], row[1]) >= (c["updated_at"], c["device"]):
                        continue   # what we have is as new or newer
                    rev += 1
                    accepted += 1
                    self._db.execute(
                        "INSERT INTO records (tbl, id, data, updated_at, device, deleted, rev)"
                        " VALUES (?, ?, ?, ?, ?, ?, ?)"
                        " ON CONFLICT (tbl, id) DO UPDATE SET data=excluded.data,"
                        " updated_at=excluded.updated_at, device=excluded.device,"
                        " deleted=excluded.deleted, rev=excluded.rev",
                        (c["tbl"], c["id"], c["data"], c["updated_at"], c["device"],
                         int(c["deleted"]), rev),
                    )
            rows = self._db.execute(
                "SELECT tbl, id, data, updated_at, device, deleted, rev FROM records"
                " WHERE rev > ? ORDER BY rev LIMIT ?",
                (since, PAGE_SIZE + 1),
            ).fetchall()
            head = self.current_rev()

        more = len(rows) > PAGE_SIZE
        rows = rows[:PAGE_SIZE]
        return {
            "store_id": self.store_id,
            "accepted": accepted,
            "rejected": rejected,
            "changes": [_row_out(r) for r in rows],
            # With more to come, the cursor is where this page stopped, not the head.
            "rev": rows[-1][6] if more else head,
            "more": more,
        }

    # --- export and backup -------------------------------------------------

    def export(self) -> dict[str, list[dict[str, Any]]]:
        """Every live record, grouped by table — the readable backup."""
        out: dict[str, list[dict[str, Any]]] = {t: [] for t in TABLES}
        with self._lock:
            rows = self._db.execute(
                "SELECT tbl, id, data FROM records WHERE deleted = 0 ORDER BY tbl, id").fetchall()
        for tbl, rid, data in rows:
            out.setdefault(tbl, []).append({"id": rid, **json.loads(data)})
        return out

    def records(self, tbl: str) -> list[dict[str, Any]]:
        """The live records of one table, each with its ``id``."""
        with self._lock:
            rows = self._db.execute(
                "SELECT id, data FROM records WHERE tbl = ? AND deleted = 0", (tbl,)
            ).fetchall()
        return [{"id": rid, **json.loads(data)} for rid, data in rows]

    def get(self, tbl: str, rid: str) -> dict[str, Any] | None:
        with self._lock:
            row = self._db.execute(
                "SELECT data FROM records WHERE tbl = ? AND id = ? AND deleted = 0", (tbl, rid)
            ).fetchone()
        return {"id": rid, **json.loads(row[0])} if row else None

    def backup_without_photos(self, directory: Path) -> Path:
        """A copy stamped with date and time, with the student photos left out.

        Made at every start. The photos are most of the database (~12 kB each,
        everything else a few dozen kB), so this copy stays small. It is a
        complete database otherwise — in an emergency it can take the place of
        classbook.db (the photos then have to be added again). Nothing is ever
        deleted automatically: old copies are removed by hand, if at all.
        """
        directory.mkdir(parents=True, exist_ok=True)
        stamp = dt.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
        # Two in the same second: _02, _03, … — sorting after the first.
        same = [p.stem for p in directory.glob(f"classbook-{stamp}*.db")]
        if not same:
            target = directory / f"classbook-{stamp}.db"
        else:
            n = max((int(s.rsplit("_", 1)[1]) for s in same if s.count("_") > 1), default=1) + 1
            target = directory / f"classbook-{stamp}_{n:02d}.db"
        tmp = target.with_suffix(".tmp")
        with self._lock:
            dest = sqlite3.connect(tmp)
            try:
                self._db.backup(dest)
                rows = dest.execute("SELECT id, data FROM records WHERE tbl = 'students'").fetchall()
                with dest:
                    for rid, data in rows:
                        record = json.loads(data)
                        if record.get("photo"):
                            record["photo"] = None
                            dest.execute("UPDATE records SET data = ? WHERE tbl = 'students' AND id = ?",
                                         (json.dumps(record, separators=(",", ":"), ensure_ascii=False), rid))
                with dest:
                    # A database of its own: should it ever replace classbook.db,
                    # every device sees a new store_id and sends its whole copy
                    # again — the photos, and whatever came after this copy.
                    dest.execute("UPDATE meta SET value = ? WHERE key = 'store_id'", (uuid.uuid4().hex,))
                dest.execute("VACUUM")   # give the photos' space back: the file really is small
            finally:
                dest.close()
        tmp.rename(target)
        return target

def _validate(c: Any) -> dict[str, Any]:
    if not isinstance(c, dict):
        raise SyncError("a change must be an object")
    tbl, rid, device = c.get("tbl"), c.get("id"), c.get("device")
    updated_at, deleted, data = c.get("updated_at"), c.get("deleted", False), c.get("data")
    if tbl not in TABLES:
        raise SyncError(f"unknown table: {tbl!r}")
    if not isinstance(rid, str) or not 0 < len(rid) <= 200:
        raise SyncError("id must be a non-empty string")
    if not isinstance(device, str) or not 0 < len(device) <= 100:
        raise SyncError("device must be a non-empty string")
    if not isinstance(updated_at, int) or isinstance(updated_at, bool) or updated_at < 0:
        raise SyncError("updated_at must be a non-negative integer")
    if not isinstance(deleted, bool):
        raise SyncError("deleted must be true or false")
    if not isinstance(data, dict):
        raise SyncError("data must be an object")
    encoded = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    if len(encoded.encode()) > MAX_RECORD_BYTES:
        raise SyncError(f"record {tbl}/{rid} is too large")
    return {"tbl": tbl, "id": rid, "device": device, "updated_at": updated_at,
            "deleted": deleted, "data": encoded}


def _row_out(r: tuple) -> dict[str, Any]:
    tbl, rid, data, updated_at, device, deleted, _rev = r
    return {"tbl": tbl, "id": rid, "data": json.loads(data), "updated_at": updated_at,
            "device": device, "deleted": bool(deleted)}

