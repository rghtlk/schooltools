"""The planning side's server work: what needs Python or a real browser.

Everything else about planning happens in the browser, from the synced
records. What is left here:

* rendering notes (markdown + LaTeX) exactly as the documents will show them,
* the documents themselves — the syllabus, the day sheet, the LaTeX script and
  their PDFs (headless Chromium, and the computer's own TeX installation),
* attached files: storing uploads and handing them out again.

The HTML documents open in a new tab, where no ``Authorization`` header can be
sent; for those GET requests the pairing code travels as a cookie instead
(set by the app's own API calls, SameSite=Strict, HttpOnly).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Awaitable, Callable
from urllib.parse import unquote

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, Response
from jinja2 import Environment, FileSystemLoader, select_autoescape

from . import files as filestore
from . import planning, script
from .pdf import html_to_pdf
from .render import render_markdown
from .store import Store

TEMPLATES = Path(__file__).resolve().parent / "templates"
STATIC = Path(__file__).resolve().parent / "static"

jinja = Environment(loader=FileSystemLoader(TEMPLATES), autoescape=select_autoescape(["html"]))

MODES = {   # the syllabus: (detailed, include_free)
    "detailed": (True, False),
    "compact": (False, False),
    "planning": (True, True),
}


def slug(text: str, fallback: str = "course") -> str:
    return filestore.slugify(text, fallback)


def add_routes(app: FastAPI, store: Store, directory: Path,
               authorised: Callable[[Request], Awaitable[None]],
               authorised_read: Callable[[Request], Awaitable[None]]) -> None:
    root = directory / "files"
    root.mkdir(parents=True, exist_ok=True)

    def plan_or_404(course_id: str) -> planning.CoursePlan:
        plan = planning.load(store, course_id)
        if plan is None:
            raise HTTPException(404, "No such course here yet — sync first.")
        return plan

    def year_of(plan: planning.CoursePlan) -> SimpleNamespace:
        return plan.year or SimpleNamespace(name="no school year", start_date=None, end_date=None)

    def localise(html: str) -> str:
        """``/files/...`` -> ``file://`` paths, for the PDF rendered from a temp file."""
        def swap(m: re.Match) -> str:
            path = filestore.resolve(root, unquote(m.group(2)))
            return m.group(1) + path.as_uri() + m.group(3) if path else m.group(0)
        return re.sub(r'(<img\b[^>]*?\bsrc=")/files/([^"]*)(")', swap, html)

    def attachment(content: bytes, media: str, name: str) -> Response:
        return Response(content, media_type=media,
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    def file_stem(plan: planning.CoursePlan) -> str:
        parts = [slug(plan.course.name)]
        if plan.course.class_name.strip():
            parts.append(slug(plan.course.class_name))
        return "-".join(parts)

    # --- notes ------------------------------------------------------------

    @app.post("/api/render")
    async def render(request: Request) -> dict:
        await authorised(request)
        body = await request.json()
        return {"html": render_markdown(str(body.get("text") or ""))}

    # --- files ------------------------------------------------------------

    @app.post("/api/files", status_code=201)
    async def upload(request: Request, topicId: str = Form(...), file: UploadFile = File(...)) -> dict:
        await authorised(request)
        topic = store.get("topics", topicId)
        if topic is None:
            raise HTTPException(409, "This topic has not reached this computer yet — sync, then try again.")
        data = await file.read()
        try:
            return await asyncio.to_thread(filestore.store_file, store, root, topic, file.filename or "", data)
        except filestore.FileError as exc:
            raise HTTPException(400, str(exc)) from exc

    @app.get("/files/{rel:path}")
    async def get_file(rel: str, request: Request) -> FileResponse:
        await authorised_read(request)
        path = filestore.resolve(root, rel)
        if path is None:
            raise HTTPException(404, "No such file.")
        return FileResponse(path, headers={"Cache-Control": "private, no-cache"})   # revalidated by ETag

    # --- the syllabus -----------------------------------------------------

    def syllabus_html(plan: planning.CoursePlan, mode: str, asset_base: str) -> str:
        detailed, include_free = MODES.get(mode, MODES["detailed"])
        rows, free_units, n = [], 0, 0
        for i, unit in enumerate(plan.units):
            here = plan.topics.get(i)
            date_label = unit.date.strftime("%a %d %b %Y")
            if not here:
                free_units += 1
                if include_free:
                    rows.append({"number": "", "date_label": date_label, "time_label": unit.start_time,
                                 "topics": [], "empty": True})
                continue
            n += 1
            rows.append({"number": n, "date_label": date_label, "time_label": unit.start_time,
                         "topics": [{"title": t.get("title") or "(untitled)",
                                     "body_html": render_markdown(t.get("body"))} for t in here],
                         "empty": False})
        return jinja.get_template("syllabus.html").render(
            course=plan.course, year=year_of(plan), rows=rows,
            unscheduled=[{"title": t.get("title") or "(untitled)"} for t in plan.pool],
            free_units=free_units, summary=plan.summary(), detailed=detailed,
            asset_base=asset_base, notes_html=render_markdown(plan.course.notes),
            slots=planning.slot_dicts(plan.slots), generated=dt.date.today().strftime("%d %B %Y"))

    @app.get("/plan/{course_id}/syllabus", response_class=HTMLResponse)
    async def syllabus(course_id: str, request: Request, mode: str = Query("detailed")) -> HTMLResponse:
        await authorised_read(request)
        return HTMLResponse(syllabus_html(plan_or_404(course_id), mode, ""))

    @app.get("/plan/{course_id}/syllabus.pdf")
    async def syllabus_pdf(course_id: str, request: Request, mode: str = Query("detailed")) -> Response:
        await authorised_read(request)
        plan = plan_or_404(course_id)
        pdf = await html_to_pdf(localise(syllabus_html(plan, mode, STATIC.as_uri())))
        return attachment(pdf, "application/pdf", f"{file_stem(plan)}-syllabus.pdf")

    # --- the day sheet ----------------------------------------------------

    def day_html(plan: planning.CoursePlan, day: dt.date, asset_base: str, for_print: bool) -> str:
        hours = [{"hour": u.hour_in_day, "start_time": u.start_time, "source": u.source, "note": u.note,
                  "topics": [{"title": t.get("title") or "(untitled)", "body_html": render_markdown(t.get("body"))}
                             for t in plan.topics.get(i, [])]}
                 for i, u in enumerate(plan.units) if u.date == day]
        if not hours:
            raise HTTPException(404, f"{plan.course.name} has no teaching hour on {day.isoformat()}.")
        dates = sorted({u.date for u in plan.units})
        at = dates.index(day)
        prev_day = dates[at - 1] if at else None
        next_day = dates[at + 1] if at + 1 < len(dates) else None
        return jinja.get_template("day.html").render(
            course=plan.course, year=year_of(plan), day=day.isoformat(),
            day_label=day.strftime("%A %d %B %Y"), hours=hours,
            planned_hours=sum(1 for h in hours if h["topics"]),
            prev_day=prev_day.isoformat() if prev_day else None,
            prev_label=prev_day.strftime("%a %d %b") if prev_day else "",
            next_day=next_day.isoformat() if next_day else None,
            next_label=next_day.strftime("%a %d %b") if next_day else "",
            base_path=f"/plan/{plan.course.id}/day", asset_base=asset_base, for_print=for_print,
            generated=dt.date.today().strftime("%d %B %Y"))

    @app.get("/plan/{course_id}/day/{day}/pdf")
    async def day_pdf(course_id: str, day: dt.date, request: Request) -> Response:
        await authorised_read(request)
        plan = plan_or_404(course_id)
        pdf = await html_to_pdf(localise(day_html(plan, day, STATIC.as_uri(), True)))
        return attachment(pdf, "application/pdf", f"{file_stem(plan)}-{day.isoformat()}.pdf")

    @app.get("/plan/{course_id}/day/{day}", response_class=HTMLResponse)
    async def day_page(course_id: str, day: dt.date, request: Request) -> HTMLResponse:
        await authorised_read(request)
        return HTMLResponse(day_html(plan_or_404(course_id), day, "", False))

    # --- the script -------------------------------------------------------

    @app.get("/plan/{course_id}/script.tex")
    async def script_tex(course_id: str, request: Request) -> Response:
        await authorised_read(request)
        plan = plan_or_404(course_id)
        source, _ = script.build_tex(plan, root)
        return attachment(source.encode(), "application/x-tex", f"{file_stem(plan)}-script.tex")

    @app.get("/plan/{course_id}/script.zip")
    async def script_zip(course_id: str, request: Request) -> Response:
        await authorised_read(request)
        plan = plan_or_404(course_id)
        return attachment(script.build_zip(plan, root), "application/zip", f"{file_stem(plan)}-script.zip")

    @app.get("/plan/{course_id}/script.pdf")
    async def script_pdf(course_id: str, request: Request) -> Response:
        await authorised_read(request)
        plan = plan_or_404(course_id)
        try:
            pdf = await script.build_pdf(plan, root)
        except script.LatexError as exc:
            raise HTTPException(503, str(exc)) from exc
        return attachment(pdf, "application/pdf", f"{file_stem(plan)}-script.pdf")

    @app.get("/api/latex-available")
    async def latex_available(request: Request) -> dict:
        await authorised(request)
        return {"engine": script._find_engine()}
