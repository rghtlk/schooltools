"""LaTeX export using the ``exam`` document class, and PDF compilation."""

from __future__ import annotations

import base64
import random
import re
import shutil
import struct
import subprocess
import tempfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote

from .cloze import GAP_RE, best_answer, parse_gap

DEFAULT_SETTINGS = {
    "title": "",               # defaults to the quiz name
    "subtitle": "",            # e.g. class / subject
    "date": "",
    "instructions": "",
    "language": "en",          # en | de
    "show_points": True,       # points per question (right margin) and grade table
    "font_size": "11pt",
    "engine": "pdflatex",      # pdflatex | xelatex | lualatex
    "gradetable": "auto",      # auto | h | v | none
    "name_fields": True,
    "shuffle_choices": True,   # shuffle choices (deterministically per quiz, same order in the key)
    "feedback_in_key": True,   # general feedback as solution in the answer key
    "answerline_width": "6cm",
}

TEXTS = {
    "en": {"true": "True", "false": "False", "name": "Name", "class": "Class", "date": "Date",
           "page": "Page", "of": "of", "options": "Options", "points": ("pt", "pts"),
           "dd_instruction": "Assign the correct terms to the pictures.", "empty": "This quiz has no questions yet.",
           "question": "Question:", "pts": "Points:", "score": "Score:", "total": "Total",
           "unsupported": "This question type cannot be printed."},
    "de": {"true": "Richtig", "false": "Falsch", "name": "Name", "class": "Klasse", "date": "Datum",
           "page": "Seite", "of": "von", "options": "Antwortmöglichkeiten", "points": ("Pkt.", "Pkt."),
           "dd_instruction": "Ordne den Bildern die richtigen Begriffe zu.", "empty": "Dieser Test enthält noch keine Fragen.",
           "question": "Aufgabe:", "pts": "Punkte:", "score": "Erreicht:", "total": "Summe",
           "unsupported": "Dieser Fragetyp kann nicht gedruckt werden."},
}

PRINTABLE_IMAGES = {"png", "jpg", "jpeg", "pdf"}


_SPECIAL = {
    "\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "$": r"\$", "&": r"\&", "#": r"\#",
    "^": r"\textasciicircum{}", "_": r"\_", "~": r"\textasciitilde{}", "%": r"\%",
    "\u00a0": "~", "→": r"$\rightarrow$", "←": r"$\leftarrow$", "↔": r"$\leftrightarrow$",
    "⇒": r"$\Rightarrow$", "≤": r"$\leq$", "≥": r"$\geq$", "≠": r"$\neq$", "≈": r"$\approx$",
    "×": r"$\times$", "÷": r"$\div$", "±": r"$\pm$", "∞": r"$\infty$", "…": r"\dots{}",
    "✓": r"$\checkmark$", "•": r"\textbullet{}", "€": r"\euro{}", "\u200b": "",
}
_SPECIAL_RE = re.compile("|".join(re.escape(k) for k in _SPECIAL))
# Math written for Moodle's MathJax filter is passed through unchanged.
_MATH_RE = re.compile(r"(\\\(.+?\\\)|\\\[.+?\\\]|\$\$.+?\$\$)", re.S)


def escape(text: str) -> str:
    out = []
    for i, part in enumerate(_MATH_RE.split(text or "")):
        if i % 2:
            out.append(part if not part.startswith("$$") else r"\[" + part[2:-2] + r"\]")
        else:
            out.append(_SPECIAL_RE.sub(lambda m: _SPECIAL[m.group(0)], part))
    return "".join(out)


def image_size(data: bytes) -> tuple[int, int] | None:
    """Pixel size of a PNG, JPEG or GIF image (None if unknown)."""
    try:
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", data[16:24])
        if data[:6] in (b"GIF87a", b"GIF89a"):
            return struct.unpack("<HH", data[6:10])
        if data[:2] == b"\xff\xd8":
            i = 2
            while i < len(data):
                if data[i] != 0xFF:
                    i += 1
                    continue
                marker = data[i + 1]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                    i += 2
                    continue
                length = struct.unpack(">H", data[i + 2:i + 4])[0]
                if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return w, h
                i += 2 + length
    except (struct.error, IndexError):
        pass
    return None


def _fmt(x: float) -> str:
    return f"{x:.3f}".rstrip("0").rstrip(".")


def _points(p) -> str:
    p = float(p or 0)
    return str(int(p)) if p == int(p) else _fmt(p)


# --------------------------------------------------------------------- HTML -> LaTeX


class _Node:
    def __init__(self, tag: str, attrs: dict | None = None, parent=None):
        self.tag, self.attrs, self.parent, self.children = tag, attrs or {}, parent, []


class _TreeBuilder(HTMLParser):
    VOID = {"br", "img", "hr", "input", "meta", "link", "wbr"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = self.cur = _Node("root")

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, dict(attrs), self.cur)
        self.cur.children.append(node)
        if tag not in self.VOID:
            self.cur = node

    def handle_startendtag(self, tag, attrs):
        self.cur.children.append(_Node(tag, dict(attrs), self.cur))

    def handle_endtag(self, tag):
        node = self.cur
        while node is not self.root and node.tag != tag:
            node = node.parent
        if node is not self.root:
            self.cur = node.parent

    def handle_data(self, data):
        self.cur.children.append(data)


_NEWLINE_EDGES = re.compile(r"^(\s*\\newline\b\s*)+|(\s*\\newline\b\s*)+$")


class Converter:
    """Converts Moodle HTML into LaTeX. Images are collected in ``self.images``."""

    def __init__(self, files: dict[str, str], images: dict[str, bytes], max_width_cm: float = 15.0):
        self.files = files or {}
        self.images = images  # shared: output file name -> bytes
        self.max_width = max_width_cm

    # images -----------------------------------------------------------
    def add_image(self, name: str, data_b64: str) -> tuple[str, tuple[int, int] | None] | None:
        ext = (name.rsplit(".", 1)[-1] if "." in name else "").lower()
        if ext not in PRINTABLE_IMAGES:
            return None
        data = base64.b64decode(data_b64)
        out = f"img{len(self.images) + 1}.{'jpg' if ext == 'jpeg' else ext}"
        self.images[out] = data
        return out, image_size(data)

    def include(self, name: str, data_b64: str, width_px: int | None = None) -> str:
        added = self.add_image(name, data_b64)
        if not added:
            return f"\\fbox{{[{escape(name)}]}}"
        out, size = added
        px = width_px or (size[0] if size else 400)
        width = min(px * 2.54 / 96, self.max_width)
        return f"\\includegraphics[width={_fmt(width)}cm]{{{out}}}"

    # conversion ---------------------------------------------------------
    def convert(self, markup: str, inline: bool = False) -> str:
        builder = _TreeBuilder()
        builder.feed(markup or "")
        builder.close()
        out = self._children(builder.root, pre=False)
        out = re.sub(r"[ \t]*\n[ \t]*", "\n", out)
        out = re.sub(r"\n{3,}", "\n\n", out).strip()
        # A \newline must end a line of text: LaTeX aborts on one at the start of a paragraph
        # ("There's no line here to end"), so drop those at paragraph edges and merge repeats.
        out = "\n\n".join(_NEWLINE_EDGES.sub("", par).strip() for par in out.split("\n\n"))
        out = re.sub(r"(\\newline\s*){2,}", r"\\newline\n", out)
        if inline:
            out = re.sub(r"\s*\\smallskip\s*", "\n\n", out)  # no vertical space inside a choice
            out = re.sub(r"\n\n+", r" \\newline ", out.strip())
        out = re.sub(r"^\\smallskip\s*|\s*\\smallskip$", "", out.strip())
        return _NEWLINE_EDGES.sub("", out).strip()

    def _children(self, node, pre: bool) -> str:
        return "".join(self._node(c, pre) for c in node.children)

    def _node(self, node, pre: bool) -> str:
        if isinstance(node, str):
            return node if pre else escape(re.sub(r"\s+", " ", node))
        tag, inner = node.tag, (lambda: self._children(node, pre))
        if tag in ("script", "style", "head"):
            return ""
        if tag in ("p", "div", "section", "article"):
            body = _NEWLINE_EDGES.sub("", inner().strip()).strip()
            # An empty paragraph (<p><br></p>, <div><br></div>) is a blank line in the editor: a small gap.
            return "\n\n" + (body or "\\smallskip") + "\n\n"
        if tag == "br":
            return "\\newline\n"
        if tag in ("b", "strong"):
            return f"\\textbf{{{inner()}}}"
        if tag in ("i", "em"):
            return f"\\emph{{{inner()}}}"
        if tag == "u":
            return f"\\underline{{{inner()}}}"
        if tag == "sub":
            return f"\\textsubscript{{{inner()}}}"
        if tag == "sup":
            return f"\\textsuperscript{{{inner()}}}"
        if tag in ("code", "tt", "kbd", "samp"):
            return f"\\texttt{{{inner()}}}"
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            return f"\n\n\\textbf{{{inner().strip()}}}\n\n"
        if tag == "pre":
            text = "".join(self._text(c) for c in node.children)
            return "\n\n\\begin{verbatim}\n" + text.strip("\n") + "\n\\end{verbatim}\n\n"
        if tag == "blockquote":
            return f"\n\n\\begin{{quote}}\n{inner().strip()}\n\\end{{quote}}\n\n"
        if tag in ("ul", "ol"):
            env = "itemize" if tag == "ul" else "enumerate"
            items = [_NEWLINE_EDGES.sub("", self._children(c, pre).strip()).strip()
                     for c in node.children if isinstance(c, _Node) and c.tag == "li"]
            if not items:
                return inner()
            body = "\n".join(f"  \\item {it}" for it in items)
            return f"\n\n\\begin{{{env}}}\n{body}\n\\end{{{env}}}\n\n"
        if tag == "a":
            href = node.attrs.get("href", "")
            text = inner()
            if href.startswith(("http://", "https://", "mailto:")):
                url = href.replace("\\", "/").replace("#", r"\#").replace("%", r"\%")
                return f"\\href{{{url}}}{{{text}}}"
            return text
        if tag == "img":
            return self._img(node)
        if tag == "table":
            return self._table(node)
        if tag == "hr":
            return "\n\n\\noindent\\rule{\\linewidth}{0.4pt}\n\n"
        return inner()

    def _text(self, node) -> str:
        if isinstance(node, str):
            return node
        if node.tag == "br":
            return "\n"
        return "".join(self._text(c) for c in node.children)

    def _img(self, node) -> str:
        src = node.attrs.get("src", "")
        width = node.attrs.get("width")
        m = re.search(r"width:\s*(\d+)px", node.attrs.get("style", ""))
        width_px = int(width) if width and width.isdigit() else (int(m.group(1)) if m else None)
        if src.startswith("@@PLUGINFILE@@/"):
            name = unquote(src.split("/", 1)[1])
            data = self.files.get(name)
            if data:
                return self.include(name, data, width_px)
            return f"\\fbox{{[{escape(name)}]}}"
        m = re.match(r"data:image/(\w+);base64,(.*)", src, re.S)
        if m:
            return self.include(f"inline.{m.group(1)}", m.group(2), width_px)
        return f"\\fbox{{[{escape(node.attrs.get('alt') or 'image')}]}}"

    def _table(self, node) -> str:
        """HTML table -> tabular with a full grid. Small tables keep their natural width;
        otherwise the columns share the line width in proportion to their content.
        Header cells (th / thead) are bold; colspan and rowspan are supported."""
        rows: list[list[dict]] = []
        caption = ""

        def collect(n, head=False):
            nonlocal caption
            for c in n.children:
                if not isinstance(c, _Node):
                    continue
                if c.tag == "caption":
                    caption = self._children(c, False).strip()
                elif c.tag == "tr":
                    cells = []
                    for cell in c.children:
                        if isinstance(cell, _Node) and cell.tag in ("td", "th"):
                            tex = re.sub(r"\s*\n\n+\s*", r" \\newline ", self._children(cell, False).strip())
                            tex = re.sub(r"^(\\newline\s*)+|(\s*\\newline)+$", "", tex)

                            def span(attr):
                                try:
                                    return max(1, int(cell.attrs.get(attr) or 1))
                                except ValueError:
                                    return 1

                            cells.append({
                                "tex": tex, "colspan": span("colspan"), "rowspan": span("rowspan"),
                                "header": head or cell.tag == "th",
                                "length": len("".join(self._text(x) for x in cell.children).strip()),
                            })
                    if cells:
                        rows.append(cells)
                elif c.tag in ("thead", "tbody", "tfoot"):
                    collect(c, head or c.tag == "thead")

        collect(node)
        if not rows:
            return ""

        # Lay the cells out on a grid, honouring rowspan: grid[r][col] = cell | "cont" (covered) | None.
        grid: list[list] = []
        for r, cells in enumerate(rows):
            while len(grid) <= r:
                grid.append([])
            col = 0
            for cell in cells:
                while col < len(grid[r]) and grid[r][col] is not None:
                    col += 1
                for dr in range(cell["rowspan"]):
                    while len(grid) <= r + dr:
                        grid.append([])
                    row = grid[r + dr]
                    while len(row) < col + cell["colspan"]:
                        row.append(None)
                    for dc in range(cell["colspan"]):
                        row[col + dc] = cell if (dr == 0 and dc == 0) else "cont"
                cell["col"], cell["last_row"] = col, r + cell["rowspan"] - 1
                col += cell["colspan"]
        ncols = max(len(r) for r in grid)
        for row in grid:
            row.extend([None] * (ncols - len(row)))

        # Column widths.
        lengths = [4] * ncols
        for row in grid:
            for c, cell in enumerate(row):
                if isinstance(cell, dict) and cell["colspan"] == 1:
                    lengths[c] = max(lengths[c], cell["length"])
        complex_cells = any(
            isinstance(cell, dict) and re.search(r"\\newline|\\begin|\\includegraphics", cell["tex"])
            for row in grid for cell in row
        )
        natural = not complex_cells and sum(lengths) + 3 * ncols <= 75
        weights = [min(n, 40) + 4 for n in lengths]
        fractions = [w / sum(weights) for w in weights]

        def colspec(first: int, count: int) -> str:
            if natural:
                return "l"
            f = sum(fractions[first:first + count])
            return f"p{{\\dimexpr {f:.4f}\\linewidth-2\\tabcolsep-1.5\\arrayrulewidth\\relax}}"

        lines = []
        for r, row in enumerate(grid):
            parts, c = [], 0
            while c < ncols:
                cell = row[c]
                if isinstance(cell, dict):
                    text = f"\\textbf{{{cell['tex']}}}" if cell["header"] and cell["tex"] else cell["tex"]
                    width = cell["colspan"]
                    if width > 1:
                        border = "|" if c == 0 else ""
                        text = f"\\multicolumn{{{width}}}{{{border}{colspec(c, width)}|}}{{{text}}}"
                    parts.append(text)
                    c += width
                elif cell == "cont":
                    # covered by a rowspan from above: keep the column's border, leave it empty
                    owner = next(x for x in (grid[k][c] for k in range(r - 1, -1, -1)) if isinstance(x, dict))
                    width = owner["colspan"]
                    border = "|" if c == 0 else ""
                    parts.append(f"\\multicolumn{{{width}}}{{{border}{colspec(c, width)}|}}{{}}" if width > 1 else "")
                    c += width
                else:
                    parts.append("")
                    c += 1
            # Horizontal rule below this row, except where a rowspan continues.
            continuing = [
                isinstance(grid[r + 1][c], str) if r + 1 < len(grid) else False
                for c in range(ncols)
            ]
            if not any(continuing):
                rule = r"\hline"
            else:
                segments, start = [], None
                for c in range(ncols + 1):
                    if c < ncols and not continuing[c]:
                        start = c if start is None else start
                    elif start is not None:
                        segments.append(f"\\cline{{{start + 1}-{c}}}")
                        start = None
                rule = "".join(segments)
            lines.append(" & ".join(parts) + r" \\" + rule)

        spec = "|" + "|".join(colspec(c, 1) for c in range(ncols)) + "|"
        cap = f"\\textit{{{caption}}}\\par\\nopagebreak\n" if caption else ""
        # [t] + \\firsthline (array package): the first row lines up with the question number
        return f"\n\n{cap}\\noindent\\begin{{tabular}}[t]{{{spec}}}\\firsthline\n" + "\n".join(lines) + "\n\\end{tabular}\n\n"


# --------------------------------------------------------------------- exam document


def _answer_text(pattern: str) -> str:
    return re.sub(r"\s+", " ", pattern.replace("*", " ")).strip()


def _drag_width_px(drag: dict) -> int:
    return 80 if drag.get("image") else int(len(drag.get("text", "")) * 7.5 + 26)


class ExamBuilder:
    def __init__(self, quiz: dict, questions: list[dict], settings: dict):
        self.quiz = quiz
        self.questions = questions
        self.s = {**DEFAULT_SETTINGS, **(settings or {})}
        self.t = TEXTS.get(self.s["language"], TEXTS["en"])
        self.images: dict[str, bytes] = {}
        self.rng = random.Random(quiz.get("id", 0))

    def conv(self, q: dict) -> Converter:
        return Converter(q.get("files") or {}, self.images)

    def build(self) -> str:
        s, t = self.s, self.t
        title = escape(s["title"] or self.quiz.get("name", ""))
        body = self.body() if self.questions else f"\\begin{{center}}\\emph{{{t['empty']}}}\\end{{center}}"
        n = len(self.questions)
        table = s["gradetable"] if s["show_points"] else "none"
        if table == "auto":
            table = "h" if n <= 12 else "none"
        grade = f"\\begin{{center}}\n\\gradetable[{table}][questions]\n\\end{{center}}\n" if table in ("h", "v") and n else ""

        if s["engine"] == "pdflatex":
            fonts = "\\usepackage[utf8]{inputenc}\n\\usepackage[T1]{fontenc}\n\\usepackage{lmodern}\n\\usepackage{textcomp}\n\\usepackage{eurosym}"
        else:
            fonts = "\\usepackage{fontspec}\n\\usepackage{eurosym}"
        babel = "ngerman" if s["language"] == "de" else "english"
        singular, plural = t["points"]

        header_fields = ""
        if s["name_fields"]:
            header_fields = (
                f"\\noindent\\makebox[0.55\\textwidth]{{{t['name']}:\\enspace\\hrulefill}}\\hfill"
                f"\\makebox[0.2\\textwidth]{{{t['class']}:\\enspace\\hrulefill}}\\hfill"
                f"\\makebox[0.2\\textwidth]{{{t['date']}:\\enspace\\hrulefill}}\n\\bigskip\n"
            )
        instructions = ""
        if s["instructions"].strip():
            instructions = "\\noindent " + escape(s["instructions"].strip()).replace("\n\n", "\n\n\\noindent ").replace("\n", "\\newline\n") + "\n\\medskip\n"

        return f"""% Generated by Quizmaster. Compile twice (or with latexmk) so that points and pages are correct.
% Add the option "answers" to \\documentclass to print the answer key.
\\documentclass[{s['font_size']},a4paper,addpoints]{{exam}}
{fonts}
\\usepackage[{babel}]{{babel}}
\\usepackage[left=2cm,right={'2.8cm' if s['show_points'] else '2cm'},top=2cm,bottom=2cm,headheight=14pt]{{geometry}}
\\usepackage{{graphicx,xcolor,amsmath,amssymb,array,tikz,needspace}}
\\usepackage[hidelinks]{{hyperref}}

\\pointpoints{{{singular}}}{{{plural}}}
\\pointsinrightmargin
\\renewcommand{{\\questionshook}}{{\\setlength{{\\itemsep}}{{1.5ex}}}}
\\setlength{{\\rightpointsmargin}}{{0.8cm}}
\\pointformat{{\\textbf{{\\thepoints}}}}
\\hqword{{{t['question']}}}\\hpword{{{t['pts']}}}\\hsword{{{t['score']}}}\\htword{{{t['total']}}}
\\CorrectChoiceEmphasis{{\\color{{red}}\\bfseries}}
\\SolutionEmphasis{{\\color{{red}}}}
\\renewcommand{{\\solutiontitle}}{{}}
\\unframedsolutions
\\checkboxchar{{$\\Box$}}\\checkedchar{{$\\blacksquare$}}
\\setlength{{\\answerlinelength}}{{{escape(s['answerline_width'])}}}
\\newcommand{{\\ans}}[1]{{\\ifprintanswers\\textcolor{{red}}{{#1}}\\else\\phantom{{#1}}\\fi}}
% gap in the text: \\qmgap{{width}}{{answer}}; options: \\qmright / \\qmwrong
\\newcommand{{\\qmgap}}[2]{{\\underline{{\\makebox[#1][c]{{\\strut\\ans{{#2}}}}}}}}
\\newcommand{{\\qmright}}[1]{{\\mbox{{\\ifprintanswers\\textcolor{{red}}{{$\\blacksquare$~\\textbf{{#1}}}}\\else$\\Box$~#1\\fi}}}}
\\newcommand{{\\qmwrong}}[1]{{\\mbox{{$\\Box$~#1}}}}
% section heading between questions (kept together with the next question)
\\newcommand{{\\qmsection}}[1]{{\\par\\Needspace*{{10\\baselineskip}}\\bigskip\\noindent{{\\large\\bfseries #1}}\\par\\nopagebreak\\smallskip}}

\\pagestyle{{headandfoot}}
\\firstpageheader{{}}{{}}{{}}
\\runningheader{{{title}}}{{}}{{{escape(s['subtitle'])}}}
\\runningheadrule
\\footer{{}}{{{t['page']} \\thepage\\ {t['of']} \\numpages}}{{}}

\\begin{{document}}
\\begin{{center}}
  {{\\LARGE\\bfseries {title}\\ifprintanswers\\ -- \\textcolor{{red}}{{{'Lösung' if s['language'] == 'de' else 'Answer key'}}}\\fi}}\\par
  {f"{{\\large {escape(s['subtitle'])}}}\\par" if s['subtitle'] else ""}
  {f"{escape(s['date'])}\\par" if s['date'] else ""}
\\end{{center}}
\\medskip
{header_fields}{instructions}{grade}
{body}
\\end{{document}}
"""

    def entries(self) -> list[tuple[str, dict]]:
        """Questions and visible sections in quiz order: ``[("question"|"section", data)]``."""
        out = [("question", q, (q.get("position", i), q.get("item_id", 0))) for i, q in enumerate(self.questions)]
        for sec in self.quiz.get("sections") or []:
            if sec.get("visible", True) and str(sec.get("name", "")).strip():
                out.append(("section", sec, (sec.get("position", 0), sec.get("item_id", 0))))
        out.sort(key=lambda e: e[2])
        return [(kind, data) for kind, data, _ in out]

    def body(self) -> str:
        """Questions in ``questions`` environments; a section closes the environment, prints its
        heading and opens a new one (the exam class keeps counting the questions)."""
        parts, open_ = [], False
        for kind, data in self.entries():
            if kind == "section":
                if open_:
                    parts.append("\\end{questions}")
                    open_ = False
                parts.append(f"\\qmsection{{{escape(data['name'].strip())}}}")
            else:
                if not open_:
                    parts.append("\\begin{questions}")
                    open_ = True
                parts.append(self.question(data))
        if open_:
            parts.append("\\end{questions}")
        return "\n\n".join(parts)

    def question(self, q: dict) -> str:
        pts = float(q.get("defaultgrade") or 0)
        head = f"\\question[{_points(pts)}]" if pts > 0 and self.s["show_points"] else "\\question"
        prepare = getattr(self, "text_" + q.get("type", ""), None)
        text = prepare(q) if prepare else self.conv(q).convert(q.get("questiontext", ""))
        handler = getattr(self, "q_" + q.get("type", ""), None)
        body = handler(q) if handler else f"\\textit{{({self.t['unsupported']} [{escape(q.get('type', ''))}])}}"
        sol = ""
        if self.s["feedback_in_key"] and (q.get("generalfeedback") or "").strip():
            fb = self.conv(q).convert(q["generalfeedback"])
            if fb:
                sol = f"\n\\begin{{solution}}\n{fb}\n\\end{{solution}}"
        if q.get("type") == "ddimageortext" and (not text or re.search(r"drag|drop|zieh", text, re.I)):
            # "Drag and drop" makes no sense on paper.
            text = escape(self.t["dd_instruction"])
        # Each question is one unbreakable box, so it never runs over a page break.
        return (
            f"% --- {q.get('name', '')}\n{head}%\n\\begin{{minipage}}[t]{{\\linewidth}}\n"
            f"{text}\n{body}{sol}\n\\end{{minipage}}"
        )

    def _maybe_shuffle(self, items: list, q: dict) -> list:
        if self.s["shuffle_choices"] and q.get("shuffleanswers", True):
            items = list(items)
            self.rng.shuffle(items)
        return items

    def q_truefalse(self, q):
        correct = q.get("correct", True)
        c1 = "\\CorrectChoice" if correct else "\\choice"
        c2 = "\\choice" if correct else "\\CorrectChoice"
        return f"\\par\\begin{{oneparchoices}}\n{c1} {self.t['true']}\n{c2} {self.t['false']}\n\\end{{oneparchoices}}"

    def q_multichoice(self, q):
        multiple = q.get("type") == "multichoiceset" or q.get("single") is False
        env = "checkboxes" if multiple else "choices"
        conv = self.conv(q)
        lines = []
        for a in self._maybe_shuffle(q.get("answers", []), q):
            right = float(a.get("fraction") or 0) > 0 if multiple else float(a.get("fraction") or 0) >= 100
            cmd = "\\CorrectChoice" if right else "\\choice"
            lines.append(f"  {cmd} {conv.convert(a.get('text', ''), inline=True)}")
        if q.get("choice_layout") == "inline":  # set per question in the editor
            env = "oneparcheckboxes" if multiple else "oneparchoices"
            return f"\\par\\begin{{{env}}}\n" + "\n".join(lines) + f"\n\\end{{{env}}}"
        return f"\\begin{{{env}}}\n" + "\n".join(lines) + f"\n\\end{{{env}}}"

    q_multichoiceset = q_multichoice

    def q_shortanswer(self, q):
        answers = sorted(q.get("answers", []), key=lambda a: -float(a.get("fraction") or 0))
        best = _answer_text(answers[0]["text"]) if answers else ""
        return f"\n\n\\answerline[{escape(best)}]"

    def q_matching(self, q):
        conv = self.conv(q)
        subs = [s for s in q.get("subquestions", []) if conv.convert(s.get("text", "")).strip()]
        options = list(dict.fromkeys(s["answer"] for s in q.get("subquestions", []) if s.get("answer", "").strip()))
        self.rng.shuffle(options)
        letter = {opt: chr(65 + i) for i, opt in enumerate(options)}
        rows = "\n".join(
            f"  {i}. & {conv.convert(s['text'], inline=True)} & \\fbox{{\\makebox[1.4em]{{\\ans{{{letter.get(s['answer'], '?')}}}}}}} \\\\[4pt]"
            for i, s in enumerate(subs, 1)
        )
        # All options flow in one paragraph; short ones never break, long ones may wrap.
        def option(o):
            item = f"\\textbf{{{letter[o]})}}~{escape(o)}"
            return f"\\mbox{{{item}}}" if len(o) <= 25 else item
        opts = "\\hspace{1.2em plus 0.6em}\n".join(f"  {option(o)}" for o in options)
        return (
            "\n\n\\noindent\\begin{tabular}{@{}r p{0.68\\linewidth} c@{}}\n" + rows + "\n\\end{tabular}\n\n\\smallskip"
            f"{{\\raggedright\\noindent\\textbf{{{self.t['options']}:}}\\enspace\n{opts}\\par}}"
        )


    # -- helpers for gaps and option lists --------------------------------------
    def _options_line(self, texts: list[str], label: str | None = None) -> str:
        opts = "~\\textperiodcentered\\hspace{0.5em plus 0.3em}\n".join(f"\\mbox{{{escape(t)}}}" for t in texts)
        return f"{{\\raggedright\\noindent\\textbf{{{label or self.t['options']}:}} {opts}\\par}}"

    @staticmethod
    def _gap_width(texts) -> str:
        longest = max((len(t) for t in texts), default=6)
        return f"{_fmt(min(10.0, max(2.5, longest * 0.22 + 0.6)))}cm"

    # -- select missing words ([[n]] gaps) ---------------------------------------
    def text_gapselect(self, q):
        options = q.get("options", [])
        text = self.conv(q).convert(q.get("questiontext", ""))

        def gap(m):
            n = int(m.group(1))
            opt = options[n - 1] if 0 < n <= len(options) else None
            group = [o["text"] for o in options if opt and o["group"] == opt["group"]]
            return f"\\qmgap{{{self._gap_width(group)}}}{{{escape(opt['text']) if opt else '?'}}}"

        return re.sub(r"\[\[(\d+)\]\]", gap, text)

    def q_gapselect(self, q):
        groups: dict[int, list[str]] = {}
        for o in q.get("options", []):
            groups.setdefault(o.get("group", 1), [])
            if o["text"] not in groups[o.get("group", 1)]:
                groups[o.get("group", 1)].append(o["text"])
        lines = []
        for i, (g, texts) in enumerate(sorted(groups.items())):
            texts = list(texts)
            self.rng.shuffle(texts)  # the stored order is usually the solution order
            label = self.t["options"] + (f" ({i + 1})" if len(groups) > 1 else "")
            lines.append(self._options_line(texts, label))
        return "\n\n\\smallskip\n" + "\n".join(lines)

    # -- cloze -------------------------------------------------------------------
    def text_cloze(self, q):
        gaps = []

        def token(m):
            gaps.append(parse_gap(*m.groups()))
            return f"QMGAP{len(gaps) - 1}QMEND"

        marked = GAP_RE.sub(token, q.get("questiontext", ""))
        text = self.conv(q).convert(marked)
        return re.sub(r"QMGAP(\d+)QMEND", lambda m: self._cloze_gap(gaps[int(m.group(1))]), text)

    def _cloze_gap(self, g: dict) -> str:
        answers = g["answers"]
        if g["kind"] in ("shortanswer", "numerical"):
            best = best_answer(g)
            shown = best["value"] if g["kind"] == "numerical" and best else _answer_text(best["text"]) if best else "?"
            return f"\\qmgap{{{self._gap_width([_answer_text(a['text']) for a in answers])}}}{{{escape(shown)}}}"
        if g["kind"] == "unknown":
            return "\\qmgap{3cm}{?}"
        multi = g["kind"].startswith("checkbox")
        items = list(answers)
        if g["shuffle"] or self.s["shuffle_choices"]:
            self.rng.shuffle(items)
        parts = [
            (f"\\qmright{{{escape(a['text'])}}}" if (a["fraction"] > 0 if multi else a["fraction"] >= 100) else f"\\qmwrong{{{escape(a['text'])}}}")
            for a in items
        ]
        if g["kind"].endswith("_v"):
            return "\n\n\\begin{tabular}{@{\\hspace{1.5em}}l@{}}\n" + " \\\\\n".join(parts) + "\n\\end{tabular}\n\n"
        return "(" + "\\hspace{0.8em plus 0.3em}".join(parts) + ")"

    def q_cloze(self, q):
        return ""

    # -- essay -------------------------------------------------------------------
    def q_essay(self, q):
        if q.get("responseformat") == "noinline":
            return ""
        height = min(12.0, max(2.0, int(q.get("responsefieldlines") or 10) * 0.8))
        info = self.conv(q).convert(q.get("graderinfo", "")) or "\\mbox{}"
        return f"\n\n\\begin{{solutionorlines}}[{_fmt(height)}cm]\n{info}\n\\end{{solutionorlines}}"

    def q_ddimageortext(self, q):
        conv = self.conv(q)
        drags = {d["no"]: d for d in q.get("drags", [])}
        label = lambda d: escape(d.get("text") or "") or "[image]"
        bg = q.get("background") or {}
        picture = ""
        added = conv.add_image(bg.get("name", "bg.png"), bg["data"]) if bg.get("data") else None
        if added:
            out, size = added
            wpx, hpx = size if size else (600, 400)
            width_cm = min(wpx * 2.54 / 96, 15.0)
            scale = width_cm / wpx  # cm per image pixel
            # Empty boxes to write in: wide enough for the longest term (handwritten), height 0.8cm.
            longest = max((len(d.get("text") or "") for d in drags.values()), default=8)
            want_w = max(2.0, longest * 0.22 + 0.5)
            box_h = 0.8
            boxes = [
                {"x": d.get("xleft", 0) * scale, "y": d.get("ytop", 0) * scale, "w": want_w, "d": drags.get(d.get("choice"))}
                for d in q.get("drops", [])
            ]
            # Shrink boxes that would run into a neighbour on their right or past the text width.
            for b in boxes:
                b["w"] = max(1.5, min(b["w"], 15.2 - b["x"]))
            for b in boxes:
                for o in boxes:
                    if o is not b and o["x"] > b["x"] and abs(o["y"] - b["y"]) < box_h:
                        b["w"] = max(1.5, min(b["w"], o["x"] - b["x"] - 0.15))
            nodes = [
                f"  \\node[draw, thick, fill=white, anchor=north west, inner sep=2pt, "
                f"minimum width={_fmt(b['w'])}cm, minimum height={_fmt(box_h)}cm, align=center, font=\\footnotesize] "
                f"at ({_fmt(b['x'])}cm, {_fmt(-b['y'])}cm) {{\\ans{{{label(b['d']) if b['d'] else '?'}}}}};"
                for b in boxes
            ]
            picture = (
                "\n\n\\begin{center}\n\\begin{tikzpicture}\n"
                f"  \\node[anchor=north west, inner sep=0] at (0,0) {{\\includegraphics[width={_fmt(width_cm)}cm]{{{out}}}}};\n"
                + "\n".join(nodes) + "\n\\end{tikzpicture}\n\\end{center}\n"
            )
        elif bg:
            picture = f"\n\n\\fbox{{[{escape(bg.get('name', 'image'))}]}}\n"
        # Always shuffle the options: the stored order often equals the drop zone order.
        bank = list(drags.values())
        self.rng.shuffle(bank)
        return f"{picture}\n" + self._options_line([d.get("text") or "[image]" for d in bank])


def build_exam(quiz: dict, questions: list[dict], settings: dict | None = None) -> tuple[str, dict[str, bytes]]:
    """Return ``(tex_source, images)`` for the quiz."""
    builder = ExamBuilder(quiz, questions, settings or {})
    return builder.build(), builder.images


def with_answers(tex: str) -> str:
    return re.sub(r"\\documentclass\[([^\]]*)\]\{exam\}", lambda m: f"\\documentclass[{m.group(1)},answers]{{exam}}", tex, count=1)


class LatexError(Exception):
    def __init__(self, message: str, log: str = ""):
        super().__init__(message)
        self.log = log


def available_engines() -> dict:
    return {name: bool(shutil.which(name)) for name in ("latexmk", "pdflatex", "xelatex", "lualatex", "tectonic")}


def compile_pdf(tex: str, images: dict[str, bytes], engine: str = "pdflatex", timeout: int = 180) -> bytes:
    with tempfile.TemporaryDirectory(prefix="quizmaster-") as tmp:
        d = Path(tmp)
        (d / "exam.tex").write_text(tex, encoding="utf-8")
        for name, data in images.items():
            (d / name).write_bytes(data)
        if engine not in ("pdflatex", "xelatex", "lualatex"):
            engine = "pdflatex"
        if shutil.which("latexmk") and shutil.which(engine):
            flag = {"pdflatex": "-pdf", "xelatex": "-pdfxe", "lualatex": "-pdflua"}[engine]
            cmds = [["latexmk", flag, "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "exam.tex"]]
        elif shutil.which(engine):
            cmd = [engine, "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "exam.tex"]
            cmds = [cmd, cmd]
        elif shutil.which("tectonic"):
            cmds = [["tectonic", "--keep-logs", "exam.tex"]]
        else:
            raise LatexError("No LaTeX installation found (need pdflatex/xelatex/lualatex, or tectonic).")
        for cmd in cmds:
            try:
                subprocess.run(cmd, cwd=d, capture_output=True, timeout=timeout, check=False, stdin=subprocess.DEVNULL)
            except subprocess.TimeoutExpired:
                raise LatexError("LaTeX compilation timed out.")
        pdf = d / "exam.pdf"
        log = (d / "exam.log").read_text(encoding="utf-8", errors="replace") if (d / "exam.log").exists() else ""
        if pdf.exists():
            return pdf.read_bytes()
        errors = [line for line in log.splitlines() if line.startswith("!") or re.match(r"^\./exam\.tex:\d+:", line)]
        raise LatexError("LaTeX compilation failed: " + ("; ".join(errors[:5]) or "see log"), log[-4000:])
