"""FastAPI application: JSON API + static single-page frontend."""

from __future__ import annotations

import io
import ipaddress
import re
import zipfile
from pathlib import Path
from urllib.parse import quote

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import db
from .latex import DEFAULT_SETTINGS, LatexError, available_engines, build_exam, compile_pdf, with_answers
from .moodle_xml import (
    SUPPORTED_TYPES,
    export_moodle_sections,
    join_category_path,
    new_question,
    parse_moodle_xml,
    split_category_path,
)

STATIC = Path(__file__).parent / "static"
LOCAL_HOSTNAMES = {"localhost", "127.0.0.1", "[::1]", "::1"}

app = FastAPI(title="Quizmaster")


# ---------------------------------------------------------------------- local-only guard


def _is_loopback(host: str | None) -> bool:
    try:
        return ipaddress.ip_address(host or "").is_loopback
    except ValueError:
        return False


@app.middleware("http")
async def local_only(request: Request, call_next):
    """Serve only this machine: loopback clients, and a localhost Host header
    (the latter protects against DNS-rebinding attacks from web pages)."""
    host_header = request.headers.get("host", "")
    hostname = re.sub(r":\d+$", "", host_header).lower()
    if not _is_loopback(request.client.host if request.client else None) or hostname not in LOCAL_HOSTNAMES:
        return JSONResponse({"detail": "Quizmaster only accepts local connections"}, status_code=403)
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        # Always revalidate (cheap 304 via ETag): a stale cached module next to an updated one
        # breaks the app's imports and leaves an empty page.
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(db.NotFound)
async def not_found(_request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=404)


@app.exception_handler(db.Invalid)
async def invalid(_request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=400)


def _attachment(content: bytes, filename: str, media_type: str, inline: bool = False) -> Response:
    ascii_name = filename.encode("ascii", "replace").decode().replace("?", "_")
    disposition = "inline" if inline else "attachment"
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"},
    )


def _safe(name: str) -> str:
    return re.sub(r"[^\w\- .]+", "_", name).strip() or "quiz"


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/types")
def types():
    return [{"type": t, "label": label} for t, label in SUPPORTED_TYPES.items()]


@app.get("/api/types/{qtype}/new")
def new_question_template(qtype: str):
    try:
        return new_question(qtype)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ------------------------------------------------------------------------- categories


@app.get("/api/categories")
def list_categories():
    return db.list_categories()


@app.post("/api/categories")
def create_category(payload: dict = Body(...)):
    name = (payload.get("name") or "").strip()
    if not name:
        raise HTTPException(400, "Name required")
    cid = db.create_category(name, payload.get("parent_id"), payload.get("info", ""))
    return {"id": cid}


@app.put("/api/categories/{cat_id}")
def update_category(cat_id: int, payload: dict = Body(...)):
    if "name" in payload and not str(payload["name"]).strip():
        raise HTTPException(400, "Name required")
    db.update_category(cat_id, payload)
    return {"ok": True}


@app.delete("/api/categories/{cat_id}")
def delete_category(cat_id: int):
    db.delete_category(cat_id)
    return {"ok": True}


# -------------------------------------------------------------------------- questions


@app.get("/api/questions")
def list_questions():
    return db.list_question_summaries()


@app.post("/api/questions/full")
def full_questions(payload: dict = Body(...)):
    return db.get_questions([int(i) for i in payload.get("ids", [])])


@app.get("/api/questions/{qid}")
def get_question(qid: int):
    return db.get_question(qid)


@app.post("/api/questions")
def create_question(payload: dict = Body(...)):
    """Create a catalog question; with ``quiz_id`` it is also added to that quiz."""
    category_id = payload.get("category_id")
    if not category_id:
        raise HTTPException(400, "Choose a category")
    quiz_id = payload.pop("quiz_id", None)
    after = payload.pop("after_position", None)
    before = payload.pop("before_item_id", None)
    (qid,) = db.create_questions(int(category_id), [payload])
    if quiz_id:
        db.add_items(int(quiz_id), [qid], after_position=after, before_item_id=int(before) if before else None)
    return db.get_question(qid)


@app.put("/api/questions/{qid}")
def update_question(qid: int, payload: dict = Body(...)):
    db.update_question(qid, payload)
    return db.get_question(qid)


@app.post("/api/questions/{qid}/duplicate")
def duplicate_question(qid: int):
    q = db.get_question(qid)
    q["name"] = (q.get("name") or "") + " (copy)"
    (new_id,) = db.create_questions(q["category_id"], [q])
    return db.get_question(new_id)


@app.post("/api/questions/bulk")
def bulk_questions(payload: dict = Body(...)):
    ids = [int(i) for i in payload.get("ids", [])]
    action = payload.get("action")
    if action == "move":
        db.move_questions(ids, int(payload["category_id"]))
    elif action == "delete":
        db.delete_questions(ids)
    else:
        raise HTTPException(400, "Unknown action")
    return {"ok": True}


@app.get("/api/export.xml")
def export_catalog(category_id: int | None = None, ids: str | None = None):
    """Moodle XML of the catalog (or a category subtree / selected questions), keeping the hierarchy."""
    wanted = {int(i) for i in ids.split(",") if i.strip()} if ids else None
    sections = []
    for path, info, questions in db.questions_by_category([category_id] if category_id else None):
        if wanted is not None:
            questions = [q for q in questions if q["id"] in wanted]
        if questions:
            sections.append({"category": join_category_path(path), "info": info, "questions": questions})
    name = "catalog"
    if category_id:
        name = db.category_path(category_id)[-1]
    return _attachment(export_moodle_sections(sections).encode(), f"questions-{_safe(name)}.xml", "application/xml")


@app.post("/api/import")
async def import_xml(
    files: list[UploadFile] = File(...),
    parent_id: int | None = Form(None),
    quiz_id: int | None = Form(None),
    create_quiz: bool = Form(False),
):
    """Import Moodle XML into the catalog. Moodle categories become (sub)categories below
    ``parent_id``. The questions can also be added to ``quiz_id`` or to a new quiz per file."""
    total, created_quizzes = 0, []
    for upload in files:
        content = await upload.read()
        try:
            groups = parse_moodle_xml(content)
        except Exception as e:  # noqa: BLE001 - any parse error goes back to the user
            raise HTTPException(400, f"{upload.filename}: could not parse Moodle XML ({e})")
        stem = re.sub(r"\.xml$", "", upload.filename or "Imported", flags=re.I)
        ids, quiz_name = [], None
        for group in groups:
            names = split_category_path(group["category"]) or [stem]
            quiz_name = quiz_name or names[-1]
            cat_id = db.ensure_path(names, parent_id, group.get("info", ""))
            ids += db.create_questions(cat_id, group["questions"])
        total += len(ids)
        if quiz_id:
            db.add_items(quiz_id, ids)
        elif create_quiz and ids:
            new_quiz = db.create_quiz(quiz_name or stem)
            db.add_items(new_quiz, ids)
            created_quizzes.append(new_quiz)
    return {"questions": total, "quizzes": created_quizzes}


# ---------------------------------------------------------------------------- quizzes


@app.get("/api/quizzes")
def list_quizzes():
    return db.list_quizzes()


@app.post("/api/quizzes")
def create_quiz(payload: dict = Body(...)):
    name = (payload.get("name") or "").strip() or "Untitled quiz"
    quiz_id = db.create_quiz(name, payload.get("description", ""))
    if payload.get("question_ids"):
        db.add_items(quiz_id, [int(i) for i in payload["question_ids"]])
    return db.get_quiz(quiz_id)


@app.get("/api/quizzes/{quiz_id}")
def get_quiz(quiz_id: int):
    return db.get_quiz(quiz_id)


@app.put("/api/quizzes/{quiz_id}")
def update_quiz(quiz_id: int, payload: dict = Body(...)):
    db.update_quiz(quiz_id, payload)
    return db.get_quiz(quiz_id)


@app.post("/api/quizzes/{quiz_id}/archive")
def archive_quiz(quiz_id: int, payload: dict = Body(...)):
    """``{"archived": true}`` hides the quiz from the quiz list; ``false`` restores it."""
    db.set_archived(quiz_id, bool(payload.get("archived", True)))
    return db.get_quiz(quiz_id)


@app.delete("/api/quizzes/{quiz_id}")
def delete_quiz(quiz_id: int):
    db.delete_quiz(quiz_id)
    return {"ok": True}


@app.post("/api/quizzes/{quiz_id}/duplicate")
def duplicate_quiz(quiz_id: int):
    return db.get_quiz(db.duplicate_quiz(quiz_id))


@app.get("/api/quizzes/{quiz_id}/questions")
def quiz_questions(quiz_id: int):
    return db.quiz_questions(quiz_id)


@app.post("/api/quizzes/{quiz_id}/items")
def add_items(quiz_id: int, payload: dict = Body(...)):
    before = payload.get("before_item_id")
    added = db.add_items(quiz_id, [int(i) for i in payload.get("question_ids", [])], payload.get("after_position"),
                         int(before) if before else None)
    return {"added": added, "quiz": db.get_quiz(quiz_id)}


@app.post("/api/quizzes/{quiz_id}/sections")
def add_section(quiz_id: int, payload: dict = Body(...)):
    """Insert a section heading: ``{name, visible, before_item_id}`` (no ``before_item_id`` = at the end)."""
    before = payload.get("before_item_id")
    item_id = db.add_section(quiz_id, payload.get("name", ""), payload.get("visible", True), int(before) if before else None)
    return {"item_id": item_id, "quiz": db.get_quiz(quiz_id)}


@app.put("/api/quizzes/{quiz_id}/items/{item_id}")
def update_item(quiz_id: int, item_id: int, payload: dict = Body(...)):
    db.update_item(quiz_id, item_id, payload)
    return db.get_quiz(quiz_id)


@app.post("/api/quizzes/{quiz_id}/items/remove")
def remove_items(quiz_id: int, payload: dict = Body(...)):
    db.remove_items(quiz_id, [int(i) for i in payload.get("item_ids", [])])
    return db.get_quiz(quiz_id)


@app.post("/api/quizzes/{quiz_id}/reorder")
def reorder(quiz_id: int, payload: dict = Body(...)):
    db.reorder_items(quiz_id, [int(i) for i in payload.get("item_ids", [])])
    return db.get_quiz(quiz_id)


@app.get("/api/quizzes/{quiz_id}/export.xml")
def export_quiz(quiz_id: int, mode: str = "quiz"):
    """``mode=quiz``: all questions in one Moodle category named after the quiz.
    ``mode=catalog``: each question in its catalog category."""
    quiz = db.get_quiz(quiz_id)
    questions = db.quiz_questions(quiz_id)
    if mode == "catalog":
        paths = {c["id"]: c for c in db.list_categories()}
        sections: list[dict] = []
        for q in questions:
            path = join_category_path(db.category_path(q["category_id"])) if q["category_id"] in paths else ""
            if not sections or sections[-1]["category"] != path:
                sections.append({"category": path, "questions": []})
            sections[-1]["questions"].append(q)
    else:
        sections = [{"category": join_category_path([quiz["name"]]), "info": quiz["description"], "questions": questions}]
    return _attachment(export_moodle_sections(sections).encode(), f"quiz-{_safe(quiz['name'])}.xml", "application/xml")


# ----------------------------------------------------------------------------- LaTeX


@app.get("/api/latex/info")
def latex_info():
    return {"defaults": DEFAULT_SETTINGS, "engines": available_engines()}


def _exam(quiz_id: int, language: str | None = None, show_points: bool | None = None):
    """Build the exam; ``language``/``show_points`` override the quiz's saved PDF settings."""
    quiz = db.get_quiz(quiz_id)
    settings = {**DEFAULT_SETTINGS, **quiz["settings"].get("latex", {})}
    if language in ("en", "de"):
        settings["language"] = language
    if show_points is not None:
        settings["show_points"] = show_points
    tex, images = build_exam(quiz, db.quiz_questions(quiz_id), settings)
    return quiz, settings, tex, images


@app.get("/api/quizzes/{quiz_id}/exam.pdf")
def exam_pdf(quiz_id: int, answers: bool = False, download: bool = False,
             language: str | None = None, show_points: bool | None = None):
    quiz, settings, tex, images = _exam(quiz_id, language, show_points)
    if answers:
        tex = with_answers(tex)
    try:
        pdf = compile_pdf(tex, images, settings["engine"])
    except LatexError as e:
        return JSONResponse({"detail": str(e), "log": e.log}, status_code=500)
    suffix = "-answers" if answers else ""
    return _attachment(pdf, f"{_safe(quiz['name'])}{suffix}.pdf", "application/pdf", inline=not download)


@app.get("/api/quizzes/{quiz_id}/exam.zip")
def exam_zip(quiz_id: int, language: str | None = None, show_points: bool | None = None):
    quiz, _settings, tex, images = _exam(quiz_id, language, show_points)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("exam.tex", tex)
        z.writestr("exam-answers.tex", with_answers(tex))
        for name, data in images.items():
            z.writestr(name, data)
    return _attachment(buf.getvalue(), f"{_safe(quiz['name'])}-latex.zip", "application/zip")


# --------------------------------------------------------------------------- frontend


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})
