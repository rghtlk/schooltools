"""The course script: a real LaTeX document built from the topics.

Two products from one source -- the ``.tex`` (zipped with its figures so it
compiles anywhere) and a PDF built with the local TeX installation.  Whichever
comes out, the body is the same LaTeX, so the PDF is exactly what the source
produces.
"""
from __future__ import annotations

import asyncio
import io
import re
import shutil
import zipfile
from pathlib import Path

from . import files as filestore
from .latex import Ctx, escape, markdown_to_latex
from .planning import CoursePlan

# pdflatex first: it is by far the quickest here, and the preamble is written
# for it.  The others are fallbacks for installations that lack it.
ENGINES = ("pdflatex", "xelatex", "lualatex")
TIMEOUT_SECONDS = 120

PREAMBLE = r"""\documentclass[11pt,a4paper]{article}
\usepackage[T1]{fontenc}
\usepackage[utf8]{inputenc}
\usepackage[a4paper,margin=25mm]{geometry}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage[export]{adjustbox}
\usepackage{float}
\usepackage{booktabs}
\usepackage[normalem]{ulem}
\usepackage{enumitem}
\usepackage{caption}
\usepackage{microtype}
\usepackage[hidelinks]{hyperref}

\setlength{\parindent}{0pt}
\setlength{\parskip}{0.6em}
\setlist{itemsep=0.15em,topsep=0.35em}
\captionsetup[figure]{font=small,labelformat=empty}
"""


def _find_engine() -> str | None:
    for name in ENGINES:
        if shutil.which(name):
            return name
    return None


def build_tex(plan: CoursePlan, root: Path, figure_dir: str = "figures") -> tuple[str, dict[str, Path]]:
    """Return ``(latex_source, {name_in_document: file_on_disk})``.

    Figures are copied under a flat ``figures/`` name so the document compiles
    from the zip without depending on where the originals live. ``root`` is
    where the attached files are kept (data/files).
    """
    course = plan.course
    figures: dict[str, Path] = {}
    used: set[str] = set()

    def register(image: dict) -> str:
        path = filestore.resolve(root, image.get("path") or "")
        if path is None:
            return ""
        name = image["filename"]
        stem, ext = Path(name).stem, Path(name).suffix
        n = 1
        while name in used and figures.get(name) != path:
            name = f"{stem}-{n}{ext}"
            n += 1
        used.add(name)
        figures[name] = path
        return f"{figure_dir}/{name}"

    def make_ctx(lesson: dict) -> Ctx:
        images = plan.files.get(lesson["id"], [])
        by_url = {f"/files/{im.get('path')}": im for im in images}
        by_file = {im.get("filename"): im for im in images}

        def resolve(src: str) -> str:
            image = by_url.get(src) or by_file.get(Path(src).name)
            return register(image) if image else ""

        return Ctx(image_path=resolve, heading_offset=1)

    parts: list[str] = [PREAMBLE]
    title = escape(course.name)
    subtitle = " \\\\ ".join(
        filter(None, [escape(course.class_name), escape(plan.year.name if plan.year else "")])
    )
    parts.append(
        f"\\title{{{title}\\\\[0.3em]\\large {subtitle}}}\n"
        f"\\author{{{escape(course.teacher)}}}\n"
        f"\\date{{}}\n"
    )
    parts.append("\\begin{document}\n\\maketitle\n")

    if course.notes.strip():
        parts.append("\\section*{About this course}\n")
        parts.append(markdown_to_latex(course.notes, Ctx(heading_offset=1)))

    parts.append("\\tableofcontents\n\\newpage\n")

    n = 0
    for i, unit in enumerate(plan.units):
        here = plan.topics.get(i)
        if not here:
            continue
        n += 1
        heading = " \\textperiodcentered{} ".join(
            escape(l.get("title") or "(untitled)") for l in here
        )
        parts.append(f"\\section{{{heading}}}\n")
        when = escape(unit.date.strftime("%A, %d %B %Y"))
        if unit.start_time:
            when += f" \\textperiodcentered{{}} {escape(unit.start_time)}"
        parts.append(f"\\noindent\\textit{{\\small {when}}}\\par\\medskip\n")
        for lesson in here:
            if len(here) > 1:
                parts.append(f"\\subsection*{{{escape(lesson.get('title') or '(untitled)')}}}\n")
            body = markdown_to_latex(lesson.get("body") or "", make_ctx(lesson))
            parts.append(body if body else "\\textit{\\small (no notes yet)}\n\n")

    if plan.pool:
        parts.append("\\section*{Not scheduled yet}\n\\begin{itemize}\n")
        for lesson in plan.pool:
            parts.append(f"  \\item {escape(lesson.get('title') or '(untitled)')}\n")
        parts.append("\\end{itemize}\n")

    parts.append("\\end{document}\n")
    source = re.sub(r"\n{3,}", "\n\n", "".join(parts))
    return source, figures


def build_zip(plan: CoursePlan, root: Path) -> bytes:
    """The ``.tex`` plus its figures, ready to compile or hand to someone."""
    source, figures = build_tex(plan, root)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("script.tex", source)
        for name, path in figures.items():
            z.write(path, f"figures/{name}")
    return buf.getvalue()


class LatexError(RuntimeError):
    pass


async def build_pdf(plan: CoursePlan, root: Path) -> bytes:
    """Compile the script with the local TeX installation."""
    engine = _find_engine()
    if engine is None:
        raise LatexError(
            "no LaTeX engine found - install TeX Live (or MacTeX), or use "
            "'Download .tex' and compile it elsewhere"
        )

    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        source, figures = build_tex(plan, root)
        (work / "script.tex").write_text(source, encoding="utf-8")
        figdir = work / "figures"
        figdir.mkdir()
        for name, path in figures.items():
            shutil.copyfile(path, figdir / name)

        log = ""
        for _pass in range(2):  # second pass resolves the table of contents
            proc = await asyncio.create_subprocess_exec(
                engine,
                "-interaction=nonstopmode",
                "-halt-on-error",
                "-file-line-error",
                "script.tex",
                cwd=work,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            try:
                out, _ = await asyncio.wait_for(
                    proc.communicate(), timeout=TIMEOUT_SECONDS
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                raise LatexError(
                    f"{engine} did not finish within {TIMEOUT_SECONDS}s - "
                    "use 'Download .tex' and compile it yourself"
                ) from None
            log = out.decode("utf-8", "replace")
            if proc.returncode != 0:
                raise LatexError(_explain(log, engine))

        pdf = work / "script.pdf"
        if not pdf.exists():
            raise LatexError(_explain(log, engine))
        return pdf.read_bytes()


def _explain(log: str, engine: str) -> str:
    """Pull the first real error out of a very noisy log.

    Figure problems are the common case in practice -- a screenshot TeX will
    not read -- so they are named explicitly rather than left as "it failed".
    """
    lines = log.splitlines()
    for i, line in enumerate(lines):
        low = line.lower()
        if "libpng error" in low or "error reading" in low or "unsupported" in low:
            figure = ""
            for candidate in lines[max(0, i - 2): i + 1]:
                m = re.search(r"figures/([\w.\-]+)", candidate)
                if m:
                    figure = m.group(1)
                    break
            detail = line.strip().lstrip("<").strip()
            return (
                f"{engine} could not read "
                + (f"the image '{figure}'" if figure else "one of the images")
                + f" ({detail}). Replace that file and try again."
            )
    for line in lines:
        if re.match(r"^(?:\./)?script\.tex:\d+:", line) or line.startswith("!"):
            return f"{engine} failed: {line.strip()}"
    return f"{engine} failed to build the script"
