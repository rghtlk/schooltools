"""Markdown (with LaTeX maths) -> LaTeX, for the course script.

The notes are already parsed to an element tree by python-markdown, so this
walks that tree instead of re-parsing text.  Maths needs no work at all:
``pymdownx.arithmatex`` in generic mode leaves ``\\(...\\)`` and ``\\[...\\]``
in place, which is exactly what LaTeX wants.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from .render import _EXTENSIONS, _CONFIG
import markdown

# One parser instance, kept separate from the HTML one so resets cannot clash.
_md = markdown.Markdown(extensions=_EXTENSIONS, extension_configs=_CONFIG)

_SPECIALS = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}
_SPECIAL_RE = re.compile("|".join(re.escape(k) for k in _SPECIALS))

# arithmatex generic output, e.g. <span class="arithmatex">\(x^2\)</span>
_MATH_CLASS = "arithmatex"


def escape(text: str) -> str:
    """Make plain text safe to drop into a LaTeX document."""
    return _SPECIAL_RE.sub(lambda m: _SPECIALS[m.group()], text or "")


def _is_math(el: ET.Element) -> bool:
    return _MATH_CLASS in (el.get("class") or "")


def _children(el: ET.Element, ctx: "Ctx") -> str:
    out = []
    for child in el:
        out.append(_node(child, ctx))
        if child.tail:
            out.append(escape(child.tail))
    return "".join(out)


def _content(el: ET.Element, ctx: "Ctx") -> str:
    """Text of an element plus everything under it."""
    return (escape(el.text) if el.text else "") + _children(el, ctx)


class Ctx:
    """Where images live, and how deep the headings should sit."""

    def __init__(self, image_path=None, heading_offset: int = 0):
        self.image_path = image_path or (lambda src: src)
        self.heading_offset = heading_offset


_HEADINGS = ["section", "subsection", "subsubsection", "paragraph", "subparagraph"]


def _node(el: ET.Element, ctx: Ctx) -> str:
    tag = el.tag

    if tag in ("span", "div") and _is_math(el):
        # already LaTeX -- hand it over untouched
        return (el.text or "").strip()

    if tag == "p":
        # nl2br turns a trailing newline into <br>; a \\ with nothing after it
        # is a LaTeX error ("There's no line here to end"), so drop it.
        text = re.sub(r"(?:\\\\\s*)+$", "", _content(el, ctx).strip()).rstrip()
        return text + "\n\n" if text else ""

    if re.fullmatch(r"h[1-6]", tag or ""):
        level = min(int(tag[1]) - 1 + ctx.heading_offset, len(_HEADINGS) - 1)
        return f"\\{_HEADINGS[max(level, 0)]}*{{{_content(el, ctx).strip()}}}\n\n"

    if tag in ("strong", "b"):
        return f"\\textbf{{{_content(el, ctx)}}}"
    if tag in ("em", "i"):
        return f"\\emph{{{_content(el, ctx)}}}"
    if tag == "del":
        return f"\\sout{{{_content(el, ctx)}}}"
    if tag in ("ins", "u"):
        return f"\\underline{{{_content(el, ctx)}}}"
    if tag == "sup":
        return f"\\textsuperscript{{{_content(el, ctx)}}}"
    if tag == "sub":
        return f"\\textsubscript{{{_content(el, ctx)}}}"

    if tag == "code":
        return f"\\texttt{{{escape(''.join(el.itertext()))}}}"

    if tag == "pre":
        code = "".join(el.itertext()).rstrip("\n")
        return "\\begin{verbatim}\n" + code + "\n\\end{verbatim}\n\n"

    if tag in ("ul", "ol"):
        env = "itemize" if tag == "ul" else "enumerate"
        items = "".join(
            f"  \\item {_content(li, ctx).strip()}\n" for li in el.findall("li")
        )
        return f"\\begin{{{env}}}\n{items}\\end{{{env}}}\n\n"

    if tag == "li":  # a nested list reached directly
        return _content(el, ctx)

    if tag == "blockquote":
        return "\\begin{quote}\n" + _children(el, ctx).strip() + "\n\\end{quote}\n\n"

    if tag == "hr":
        return "\\bigskip\\hrule\\bigskip\n\n"

    if tag == "br":
        return "\\\\\n"

    if tag == "img":
        return _image(el, ctx)

    if tag == "a":
        href = el.get("href", "")
        label = _content(el, ctx).strip()
        # Inside \footnote, \url cannot take # or % raw; escaped they still link.
        url = (href or label).replace("\\", "/").replace("%", "\\%").replace("#", "\\#").replace("{", "").replace("}", "")
        if not href or href == label:
            return f"\\url{{{url}}}"
        return f"{label}\\footnote{{\\url{{{url}}}}}"

    if tag == "table":
        return _table(el, ctx)

    if tag in ("thead", "tbody", "tr", "th", "td"):
        return _content(el, ctx)

    # anything unrecognised: keep the words, drop the markup
    return _content(el, ctx)


def _image(el: ET.Element, ctx: Ctx) -> str:
    path = ctx.image_path(el.get("src", ""))
    if not path:
        return ""
    caption = (el.get("alt") or "").strip()
    body = (
        "\\begin{figure}[H]\n\\centering\n"
        # `max width` (adjustbox) bounds a large figure without blowing up a
        # small one to full width, which plain `width=` would do.
        f"\\includegraphics[max width=\\linewidth,"
        f"max totalheight=0.42\\textheight,keepaspectratio]{{{path}}}\n"
    )
    if caption:
        body += f"\\caption*{{{escape(caption)}}}\n"
    return body + "\\end{figure}\n\n"


def _table(el: ET.Element, ctx: Ctx) -> str:
    rows: list[list[str]] = []
    header = 0
    for tr in el.iter("tr"):
        cells = [c for c in tr if c.tag in ("td", "th")]
        if not cells:
            continue
        if all(c.tag == "th" for c in cells) and not rows:
            header = 1
        rows.append([_content(c, ctx).strip() for c in cells])
    if not rows:
        return ""

    width = max(len(r) for r in rows)
    rows = [r + [""] * (width - len(r)) for r in rows]
    spec = "l" * width

    out = ["\\begin{center}", f"\\begin{{tabular}}{{{spec}}}", "\\hline"]
    for i, row in enumerate(rows):
        line = " & ".join(row) + " \\\\"
        if i == 0 and header:
            out.append("\\textbf{" + "} & \\textbf{".join(row) + "} \\\\")
            out.append("\\hline")
        else:
            out.append(line)
    out += ["\\hline", "\\end{tabular}", "\\end{center}", ""]
    return "\n".join(out) + "\n"


def markdown_to_latex(text: str, ctx: Ctx | None = None) -> str:
    """Convert one note body to a LaTeX fragment."""
    if not text or not text.strip():
        return ""
    ctx = ctx or Ctx()
    _md.reset()
    html = _md.convert(text)
    try:
        root = ET.fromstring(f"<root>{html}</root>")
    except ET.ParseError:
        # Malformed HTML from raw tags in the notes: fall back to plain text.
        return escape(re.sub(r"<[^>]+>", "", html)) + "\n\n"

    body = (escape(root.text) if root.text else "") + _children(root, ctx)
    body = re.sub(r"\n{3,}", "\n\n", body)
    # safety net: a line break immediately before an environment is never valid
    body = re.sub(r"\\\\\s*\n(\s*\\begin\{)", r"\n\1", body)
    return body.strip() + "\n"
