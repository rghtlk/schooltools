"""Markdown (+ LaTeX) -> HTML.

``pymdownx.arithmatex`` in generic mode shields math from the Markdown parser
and emits ``\\(...\\)`` / ``\\[...\\]``, which KaTeX's auto-render picks up both
in the browser and in the headless Chromium used for the PDF -- so the preview
and the PDF always agree.
"""
from __future__ import annotations

import markdown
import nh3

_EXTENSIONS = [
    "extra",            # tables, fenced code, footnotes, attr_list, def_list
    "sane_lists",
    "admonition",
    "nl2br",
    "pymdownx.arithmatex",
    "pymdownx.tasklist",
    "pymdownx.tilde",
    "pymdownx.caret",
]

_CONFIG = {
    "pymdownx.arithmatex": {"generic": True},
    "pymdownx.tasklist": {"custom_checkbox": True},
}

_md = markdown.Markdown(extensions=_EXTENSIONS, extension_configs=_CONFIG)


# What notes may contain once rendered. Raw HTML in markdown is allowed, but
# only these tags and attributes survive — no scripts, no event handlers, no
# javascript: links, no iframes. Notes come from imported files too (a
# colleague's planer export), and they are shown inside the app and printed.
_TAGS = {
    "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "u", "s", "del", "ins",
    "sup", "sub", "mark", "small", "code", "pre", "kbd", "blockquote", "ul", "ol", "li", "dl", "dt", "dd",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "a", "img", "span", "div", "label",
    "input", "abbr", "details", "summary", "figure", "figcaption",
}
_ATTRS = {
    "*": {"class", "title", "id"},
    "a": {"href"},
    "img": {"src", "alt", "width", "height"},
    "td": {"align", "colspan", "rowspan"}, "th": {"align", "colspan", "rowspan"},
    "input": {"type", "checked", "disabled"},
    "ol": {"start"},
}


def render_markdown(text: str | None) -> str:
    if not text or not text.strip():
        return ""
    _md.reset()
    html = _md.convert(text)
    return nh3.clean(html, tags=_TAGS, attributes=_ATTRS, url_schemes={"http", "https", "mailto"},
                     link_rel="noopener noreferrer")
