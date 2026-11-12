"""Files attached to topics: images and PDFs, kept on the computer running Classbook.

Layout on disk mirrors how a teacher thinks about the material::

    data/files/<year>/<course>-<class>/<topic>/<name>.<ext>

The path is fixed when the file is stored and never recomputed, so renaming a
course or topic later cannot break a link already written into someone's notes.
What the phone learns about a file is its record in the ``files`` table (synced
like everything else); the bytes stay here and are fetched when shown.

A file whose record has been deleted — on any device — is moved to
``data/files/.trash/`` the next time the server tidies up (at start, and after a
sync that touched a file record). Nothing is deleted for good automatically:
after restoring an older database, files uploaded since are still in the trash.
"""
from __future__ import annotations

import re
import threading
import time
import unicodedata
import uuid
from pathlib import Path

from .store import Store

ALLOWED = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",   # vector figures, used as-is by the LaTeX script
}
MAX_BYTES = 20 * 1024 * 1024

# Checked at the door: a file whose bytes do not match its extension would
# otherwise be accepted now and break the LaTeX build much later.
_SIGNATURES = {
    ".png": [b"\x89PNG\r\n\x1a\n"],
    ".jpg": [b"\xff\xd8\xff"],
    ".jpeg": [b"\xff\xd8\xff"],
    ".gif": [b"GIF87a", b"GIF89a"],
    ".webp": [b"RIFF"],
    ".pdf": [b"%PDF-"],
}

SERVER_DEVICE = "mac-server"
_lock = threading.Lock()   # an upload and a tidy-up never interleave


class FileError(ValueError):
    """Something about the upload is not acceptable."""


def slugify(text: str, fallback: str = "untitled") -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    slug = re.sub(r"[^A-Za-z0-9]+", "-", text).strip("-").lower()
    return slug[:60] or fallback


def safe_filename(name: str) -> tuple[str, str]:
    base = Path(name or "").name
    ext = Path(base).suffix.lower()
    if ext not in ALLOWED:
        raise FileError(f"{ext or 'that file type'} is not supported - use " + ", ".join(sorted(ALLOWED)))
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", Path(base).stem).strip("-._")
    return (stem or "image")[:80] + ext, ext


def check(data: bytes, ext: str) -> None:
    if not data:
        raise FileError("the file is empty")
    if len(data) > MAX_BYTES:
        raise FileError(f"the file is larger than {MAX_BYTES // (1024 * 1024)} MB")
    if not any(data.startswith(sig) for sig in _SIGNATURES[ext]):
        raise FileError(f"this file does not look like a valid {ext[1:].upper()}")
    if ext == ".webp" and data[8:12] != b"WEBP":
        raise FileError("this file does not look like a valid WEBP")


def topic_dir(store: Store, topic: dict) -> Path:
    course = store.get("courses", topic.get("courseId") or "") or {}
    cls = store.get("classes", course.get("classId") or "") or {}
    year = store.get("years", course.get("yearId") or "") or {}
    return (Path(slugify(year.get("name", ""), "no-year"))
            / slugify(f"{course.get('name', '')} {cls.get('name', '')}".strip(), "course")
            / slugify(topic.get("title", ""), f"topic-{topic['id'][:8]}"))


def store_file(store: Store, root: Path, topic: dict, filename: str, data: bytes) -> dict:
    """Write the bytes and add the file's record; returns the record."""
    clean, ext = safe_filename(filename)
    check(data, ext)
    with _lock:
        rel_dir = topic_dir(store, topic)
        (root / rel_dir).mkdir(parents=True, exist_ok=True)
        target = root / rel_dir / clean
        n = 1
        # Never a path that was used before — not even one whose file went to the
        # trash: browsers keep showing what they cached under a URL.
        while target.exists() or (root / TRASH / rel_dir / target.name).exists():
            target = root / rel_dir / f"{Path(clean).stem}-{n}{ext}"
            n += 1
        target.write_bytes(data)
        record = {
            "topicId": topic["id"],
            "courseId": topic.get("courseId"),
            "filename": target.name,
            "path": target.relative_to(root).as_posix(),
            "type": ALLOWED[ext],
            "size": len(data),
        }
        rid = uuid.uuid4().hex
        store.sync(0, [{"tbl": "files", "id": rid, "data": record, "device": SERVER_DEVICE,
                        "updated_at": int(time.time() * 1000), "deleted": False}])
    return {"id": rid, **record, "url": f"/files/{record['path']}"}


def resolve(root: Path, rel: str) -> Path | None:
    """The file on disk for ``rel``, or None if it is outside ``root`` or missing."""
    root = root.resolve()
    path = (root / rel).resolve()
    if root not in path.parents or not path.is_file():
        return None
    return path


TRASH = ".trash"


def tidy(store: Store, root: Path) -> int:
    """Move files no live record points at into the trash; drop empty folders.

    A file another program holds open (Windows) is simply left for next time.
    """
    if not root.exists():
        return 0
    with _lock:
        live = {f.get("path") for f in store.records("files")}
        moved = 0
        for path in sorted(root.rglob("*"), reverse=True):   # children before parents
            rel = path.relative_to(root)
            if rel.parts and rel.parts[0] == TRASH:
                continue
            try:
                if path.is_file() and rel.as_posix() not in live:
                    target = root / TRASH / rel
                    n = 1
                    while target.exists():
                        target = root / TRASH / rel.with_name(f"{rel.stem}-{n}{rel.suffix}")
                        n += 1
                    target.parent.mkdir(parents=True, exist_ok=True)
                    path.replace(target)
                    moved += 1
                elif path.is_dir() and not any(path.iterdir()):
                    path.rmdir()
            except OSError:
                continue
        return moved
