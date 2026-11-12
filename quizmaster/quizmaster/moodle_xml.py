"""Import and export of quizzes in the Moodle XML question format.

Questions are represented as plain dicts (JSON-serialisable). Common keys:

    type, name, questiontext, generalfeedback, defaultgrade, penalty, hidden,
    idnumber, tags, files, hints

``files`` maps file names to base64 data for images embedded in HTML fields
(referenced as ``@@PLUGINFILE@@/<name>``). Type-specific keys are documented in
``new_question``. Unsupported question types are kept verbatim in ``raw`` so
they survive an import/export round trip.
"""

from __future__ import annotations

import copy
import json
import re
import xml.etree.ElementTree as ET
from urllib.parse import quote, unquote
from xml.sax.saxutils import escape

from .cloze import total_weight

SUPPORTED_TYPES = {
    "truefalse": "True/False",
    "multichoice": "Multiple choice (single answer)",
    "multichoiceset": "Multiple choice (all-or-nothing)",
    "shortanswer": "Short answer",
    "matching": "Matching",
    "ddimageortext": "Drag and drop onto image",
    "gapselect": "Select missing words",
    "cloze": "Embedded answers (Cloze)",
    "essay": "Essay",
}

ESSAY_FIELDS = {  # name -> default
    "responseformat": "editor", "responserequired": 1, "responsefieldlines": 10,
    "minwordlimit": 0, "maxwordlimit": 0, "attachments": 0, "attachmentsrequired": 0,
    "maxbytes": 0, "filetypeslist": "",
}

DEFAULT_FEEDBACK = {
    "correctfeedback": "<p>Die Antwort ist richtig.</p>",
    "partiallycorrectfeedback": "<p>Die Antwort ist teilweise richtig.</p>",
    "incorrectfeedback": "<p>Die Antwort ist falsch.</p>",
}

FEEDBACK_FIELDS = ("correctfeedback", "partiallycorrectfeedback", "incorrectfeedback")


def new_question(qtype: str) -> dict:
    """Return an empty question of the given type with sensible defaults."""
    q = {
        "type": qtype,
        "name": "",
        "questiontext": "",
        "generalfeedback": "",
        "defaultgrade": 1.0,
        "penalty": 0.3333333,
        "hidden": False,
        "idnumber": "",
        "tags": [],
        "files": {},
        "hints": [],
    }
    if qtype == "truefalse":
        q.update(penalty=1.0, correct=True, feedback_true="", feedback_false="")
    elif qtype in ("multichoice", "multichoiceset"):
        q.update(
            DEFAULT_FEEDBACK,
            shuffleanswers=True,
            answernumbering="abc",
            showstandardinstruction=True,
            shownumcorrect=qtype == "multichoice",
            answers=[
                {"text": "", "fraction": 100.0, "feedback": ""},
                {"text": "", "fraction": 0.0, "feedback": ""},
            ],
        )
        if qtype == "multichoiceset":
            q.pop("partiallycorrectfeedback")
    elif qtype == "shortanswer":
        q.update(usecase=False, answers=[{"text": "", "fraction": 100.0, "feedback": ""}])
    elif qtype == "matching":
        q.update(
            DEFAULT_FEEDBACK,
            shuffleanswers=True,
            shownumcorrect=True,
            subquestions=[{"text": "", "answer": ""}, {"text": "", "answer": ""}],
        )
    elif qtype == "ddimageortext":
        q.update(
            DEFAULT_FEEDBACK,
            shuffleanswers=True,
            shownumcorrect=True,
            background=None,
            drags=[],
            drops=[],
        )
    elif qtype == "gapselect":
        q.update(
            DEFAULT_FEEDBACK,
            shuffleanswers=True,
            shownumcorrect=True,
            options=[{"text": "", "group": 1}, {"text": "", "group": 1}],
        )
    elif qtype == "cloze":
        pass  # everything lives in the question text; the mark is the sum of the gap weights
    elif qtype == "essay":
        q.update(ESSAY_FIELDS, penalty=0.0, graderinfo="", responsetemplate="")
    else:
        raise ValueError(f"Unsupported question type: {qtype}")
    return q


# --------------------------------------------------------------------------- import


def _text(el: ET.Element | None, path: str = "text") -> str:
    if el is None:
        return ""
    node = el.find(path) if path else el
    if node is None or node.text is None:
        return ""
    return node.text


def _float(el: ET.Element, tag: str, default: float) -> float:
    try:
        return float(_text(el, tag) or default)
    except ValueError:
        return default


def _bool_value(el: ET.Element, tag: str, default: bool = False) -> bool:
    node = el.find(tag)
    if node is None:
        return default
    value = (node.text or "").strip().lower()
    if value == "":  # <tag/> means "set"
        return True
    return value in ("1", "true", "yes")


def _present(el: ET.Element, tag: str) -> bool:
    return el.find(tag) is not None


def _collect_files(q: ET.Element) -> dict:
    """Files embedded in HTML fields (not the drag-and-drop background/drag images)."""
    files: dict[str, str] = {}
    skip = {id(q)} | {id(d) for d in q.findall("drag")}
    for el in q.iter():
        if id(el) in skip:
            continue
        for f in el.findall("file"):
            name = f.get("name")
            if name:
                files[name] = re.sub(r"\s+", "", f.text or "")
    return files


def _answers(q: ET.Element) -> list[dict]:
    return [
        {
            "text": _text(a),
            "fraction": float(a.get("fraction", "0") or 0),
            "feedback": _text(a.find("feedback")),
        }
        for a in q.findall("answer")
    ]


def _parse_question(q: ET.Element) -> dict:
    qtype = q.get("type", "")
    data = {
        "type": qtype,
        "name": _text(q.find("name")),
        "questiontext": _text(q.find("questiontext")),
        "generalfeedback": _text(q.find("generalfeedback")),
        "defaultgrade": _float(q, "defaultgrade", 1.0),
        "penalty": _float(q, "penalty", 0.3333333),
        "hidden": _text(q, "hidden").strip() == "1",
        "idnumber": _text(q, "idnumber"),
        "tags": [t for t in (_text(tag) for tag in q.findall("tags/tag")) if t.strip()],
        "files": _collect_files(q),
        "hints": [
            {
                "text": _text(h),
                "shownumcorrect": _present(h, "shownumcorrect"),
                "clearwrong": _present(h, "clearwrong"),
            }
            for h in q.findall("hint")
        ],
    }

    if qtype not in SUPPORTED_TYPES:
        data["raw"] = ET.tostring(q, encoding="unicode")
        return data

    for field in FEEDBACK_FIELDS:
        if q.find(field) is not None:
            data[field] = _text(q.find(field))

    if qtype == "truefalse":
        correct, fb_true, fb_false = True, "", ""
        for a in q.findall("answer"):
            value = _text(a).strip().lower()
            fraction = float(a.get("fraction", "0") or 0)
            if value == "true":
                fb_true = _text(a.find("feedback"))
                correct = fraction > 0
            elif value == "false":
                fb_false = _text(a.find("feedback"))
                if fraction > 0:
                    correct = False
        data.update(correct=correct, feedback_true=fb_true, feedback_false=fb_false)

    elif qtype in ("multichoice", "multichoiceset"):
        data.update(
            shuffleanswers=_bool_value(q, "shuffleanswers", True),
            answernumbering=_text(q, "answernumbering") or "abc",
            showstandardinstruction=_bool_value(q, "showstandardinstruction", True),
            shownumcorrect=_present(q, "shownumcorrect"),
            answers=_answers(q),
        )
        if qtype == "multichoice" and not _bool_value(q, "single", True):
            # Moodle "multichoice" with multiple answers: keep fractions as they are.
            data["single"] = False

    elif qtype == "shortanswer":
        data.update(usecase=_text(q, "usecase").strip() == "1", answers=_answers(q))

    elif qtype == "matching":
        data.update(
            shuffleanswers=_bool_value(q, "shuffleanswers", True),
            shownumcorrect=_present(q, "shownumcorrect"),
            subquestions=[
                {"text": _text(sq), "answer": _text(sq.find("answer"))}
                for sq in q.findall("subquestion")
            ],
        )

    elif qtype == "ddimageortext":
        bg = q.find("file")
        drags = []
        for d in q.findall("drag"):
            drag = {
                "no": int(_text(d, "no") or 0),
                "text": _text(d),
                "draggroup": int(_text(d, "draggroup") or 1),
                "infinite": _present(d, "infinite"),
            }
            f = d.find("file")
            if f is not None and f.get("name"):
                drag["image"] = {"name": f.get("name"), "data": re.sub(r"\s+", "", f.text or "")}
            drags.append(drag)
        data.update(
            shuffleanswers=_present(q, "shuffleanswers"),
            shownumcorrect=_present(q, "shownumcorrect"),
            background=(
                {"name": bg.get("name"), "data": re.sub(r"\s+", "", bg.text or "")}
                if bg is not None
                else None
            ),
            drags=drags,
            drops=[
                {
                    "no": int(_text(d, "no") or 0),
                    "text": _text(d),
                    "choice": int(_text(d, "choice") or 0),
                    "xleft": int(float(_text(d, "xleft") or 0)),
                    "ytop": int(float(_text(d, "ytop") or 0)),
                }
                for d in q.findall("drop")
            ],
        )

    elif qtype == "gapselect":
        data.update(
            shuffleanswers=_bool_value(q, "shuffleanswers", True),
            shownumcorrect=_present(q, "shownumcorrect"),
            options=[
                {"text": _text(o), "group": int(_text(o, "group") or 1)}
                for o in q.findall("selectoption")
            ],
        )

    elif qtype == "cloze":
        # Moodle does not export a default mark for Cloze questions: it is the sum of the gap weights.
        data["defaultgrade"] = total_weight(data["questiontext"])

    elif qtype == "essay":
        for field, default in ESSAY_FIELDS.items():
            value = _text(q, field) if q.find(field) is not None else str(default)
            if isinstance(default, int):
                try:
                    value = int(value or 0)
                except ValueError:
                    value = default
            data[field] = value
        data["graderinfo"] = _text(q.find("graderinfo"))
        data["responsetemplate"] = _text(q.find("responsetemplate"))
    return data


def parse_moodle_xml(content: bytes | str) -> list[dict]:
    """Parse a Moodle XML file.

    Returns a list of groups ``{"category": str, "questions": [dict, ...]}``,
    one per ``<question type="category">`` block (questions before any
    category end up in a group with an empty category).
    """
    root = ET.fromstring(content)
    if root.tag != "quiz":
        raise ValueError("Not a Moodle XML file (root element must be <quiz>)")
    groups: list[dict] = []
    current: dict | None = None
    for q in root.findall("question"):
        if q.get("type") == "category":
            current = {
                "category": _text(q.find("category")).strip(),
                "info": _text(q.find("info")),
                "questions": [],
            }
            groups.append(current)
            continue
        if current is None:
            current = {"category": "", "info": "", "questions": []}
            groups.append(current)
        current["questions"].append(_parse_question(q))
    return [g for g in groups if g["questions"]] or groups[:1]


# --------------------------------------------------------------------------- export


def _cdata(value: str) -> str:
    if not value:
        return "<text></text>"
    return "<text><![CDATA[" + value.replace("]]>", "]]]]><![CDATA[>") + "]]></text>"


def _plain(value: str) -> str:
    return f"<text>{escape(value or '')}</text>"


def _refs(html: str, name: str) -> bool:
    return f"@@PLUGINFILE@@/{name}" in html or f"@@PLUGINFILE@@/{quote(name)}" in html


class _Writer:
    def __init__(self, q: dict):
        self.q = q
        self.lines: list[str] = []
        self.files: dict = q.get("files") or {}
        others = copy.deepcopy(q)
        others.pop("files", None)
        others.pop("questiontext", None)
        self.other_html = unquote(json.dumps(others, ensure_ascii=False))

    def add(self, line: str, indent: int = 2) -> None:
        self.lines.append("  " * indent + line)

    def _file_lines(self, html: str, is_questiontext: bool, indent: int) -> list[str]:
        out = []
        for name, data in self.files.items():
            referenced = _refs(html, name)
            orphan = is_questiontext and not _refs(self.other_html, name)
            if referenced or orphan:
                out.append(
                    "  " * indent
                    + f'<file name="{escape(name, {chr(34): "&quot;"})}" path="/" encoding="base64">{data}</file>'
                )
        return out

    def html(self, tag: str, html: str, indent: int = 2, attrs: str = "") -> None:
        self.add(f'<{tag}{attrs} format="html">', indent)
        self.add(_cdata(html), indent + 1)
        self.lines.extend(self._file_lines(html or "", tag == "questiontext", indent + 1))
        self.add(f"</{tag}>", indent)

    def feedbacks(self, fields=FEEDBACK_FIELDS) -> None:
        for field in fields:
            if field in self.q:
                self.html(field, self.q.get(field) or "")

    def answer(self, text: str, fraction: float, feedback: str, html: bool) -> None:
        fmt = "html" if html else "moodle_auto_format"
        self.add(f'<answer fraction="{_fraction(fraction)}" format="{fmt}">')
        self.add(_cdata(text) if html else _plain(text), 3)
        if html:
            self.lines.extend(self._file_lines(text or "", False, 3))
        self.html("feedback", feedback or "", 3)
        self.add("</answer>")


def _fraction(value) -> str:
    value = float(value or 0)
    return str(int(value)) if value == int(value) else f"{value:.7f}".rstrip("0")


def _num(value, default: float) -> str:
    try:
        return f"{float(value):.7f}"
    except (TypeError, ValueError):
        return f"{default:.7f}"


def _question_xml(q: dict) -> str:
    qtype = q.get("type")
    if q.get("raw") and qtype not in SUPPORTED_TYPES:
        return "  " + q["raw"].strip()

    w = _Writer(q)
    w.add(f'<question type="{qtype}">', 1)
    w.add("<name>")
    w.add(_plain(q.get("name", "")), 3)
    w.add("</name>")
    w.html("questiontext", q.get("questiontext", ""))
    w.html("generalfeedback", q.get("generalfeedback", ""))
    if qtype != "cloze":  # Moodle derives the Cloze mark from the gap weights
        w.add(f"<defaultgrade>{_num(q.get('defaultgrade'), 1.0)}</defaultgrade>")
    w.add(f"<penalty>{_num(q.get('penalty'), 0.3333333)}</penalty>")
    w.add(f"<hidden>{1 if q.get('hidden') else 0}</hidden>")
    w.add(f"<idnumber>{escape(q.get('idnumber') or '')}</idnumber>")

    if qtype == "truefalse":
        correct = bool(q.get("correct", True))
        w.answer("true", 100 if correct else 0, q.get("feedback_true", ""), html=False)
        w.answer("false", 0 if correct else 100, q.get("feedback_false", ""), html=False)

    elif qtype in ("multichoice", "multichoiceset"):
        if qtype == "multichoice":
            w.add(f"<single>{'false' if q.get('single') is False else 'true'}</single>")
        w.add(f"<shuffleanswers>{'true' if q.get('shuffleanswers', True) else 'false'}</shuffleanswers>")
        w.feedbacks()
        if q.get("shownumcorrect"):
            w.add("<shownumcorrect/>")
        w.add(f"<answernumbering>{escape(q.get('answernumbering') or 'abc')}</answernumbering>")
        w.add(f"<showstandardinstruction>{1 if q.get('showstandardinstruction', True) else 0}</showstandardinstruction>")
        for a in q.get("answers", []):
            fraction = a.get("fraction", 0)
            if qtype == "multichoiceset":
                fraction = 100 if float(fraction or 0) > 0 else 0
            w.answer(a.get("text", ""), fraction, a.get("feedback", ""), html=True)

    elif qtype == "shortanswer":
        w.add(f"<usecase>{1 if q.get('usecase') else 0}</usecase>")
        for a in q.get("answers", []):
            w.answer(a.get("text", ""), a.get("fraction", 0), a.get("feedback", ""), html=False)

    elif qtype == "matching":
        w.add(f"<shuffleanswers>{'true' if q.get('shuffleanswers', True) else 'false'}</shuffleanswers>")
        w.feedbacks()
        if q.get("shownumcorrect"):
            w.add("<shownumcorrect/>")
        for sq in q.get("subquestions", []):
            w.add('<subquestion format="html">')
            w.add(_cdata(sq.get("text", "")), 3)
            w.lines.extend(w._file_lines(sq.get("text", "") or "", False, 3))
            w.add("<answer>", 3)
            w.add(_plain(sq.get("answer", "")), 4)
            w.add("</answer>", 3)
            w.add("</subquestion>")

    elif qtype == "ddimageortext":
        if q.get("shuffleanswers"):
            w.add("<shuffleanswers/>")
        w.feedbacks()
        if q.get("shownumcorrect"):
            w.add("<shownumcorrect/>")
        bg = q.get("background")
        if bg and bg.get("data"):
            w.add(f'<file name="{escape(bg["name"])}" path="/" encoding="base64">{bg["data"]}</file>')
        for d in q.get("drags", []):
            w.add("<drag>")
            w.add(f"<no>{int(d.get('no', 0))}</no>", 3)
            w.add(_plain(d.get("text", "")), 3)
            w.add(f"<draggroup>{int(d.get('draggroup', 1))}</draggroup>", 3)
            if d.get("infinite"):
                w.add("<infinite/>", 3)
            img = d.get("image")
            if img and img.get("data"):
                w.add(f'<file name="{escape(img["name"])}" path="/" encoding="base64">{img["data"]}</file>', 3)
            w.add("</drag>")
        for d in q.get("drops", []):
            w.add("<drop>")
            w.add(_plain(d.get("text", "")), 3)
            w.add(f"<no>{int(d.get('no', 0))}</no>", 3)
            w.add(f"<choice>{int(d.get('choice', 0))}</choice>", 3)
            w.add(f"<xleft>{int(d.get('xleft', 0))}</xleft>", 3)
            w.add(f"<ytop>{int(d.get('ytop', 0))}</ytop>", 3)
            w.add("</drop>")

    elif qtype == "gapselect":
        w.add(f"<shuffleanswers>{1 if q.get('shuffleanswers', True) else 0}</shuffleanswers>")
        w.feedbacks()
        if q.get("shownumcorrect"):
            w.add("<shownumcorrect/>")
        for o in q.get("options", []):
            w.add("<selectoption>")
            w.add(_plain(o.get("text", "")), 3)
            w.add(f"<group>{int(o.get('group', 1))}</group>", 3)
            w.add("</selectoption>")

    elif qtype == "essay":
        for field, default in ESSAY_FIELDS.items():
            w.add(f"<{field}>{escape(str(q.get(field, default)))}</{field}>")
        w.html("graderinfo", q.get("graderinfo", ""))
        w.html("responsetemplate", q.get("responsetemplate", ""))

    for h in q.get("hints", []):
        w.html("hint", h.get("text", ""))
        if h.get("shownumcorrect") or h.get("clearwrong"):
            # Re-open the hint we just closed to add its options.
            w.lines.pop()
            if h.get("shownumcorrect"):
                w.add("<shownumcorrect/>", 3)
            if h.get("clearwrong"):
                w.add("<clearwrong/>", 3)
            w.add("</hint>")

    tags = [t for t in q.get("tags", []) if str(t).strip()]
    if tags:
        w.add("<tags>")
        for t in tags:
            w.add(f"<tag>{_plain(str(t))}</tag>", 3)
        w.add("</tags>")
    w.add("</question>", 1)
    return "\n".join(w.lines)


CONTEXT_TOKENS = {"$course$", "$system$", "$module$", "$coursecategory$", "$cat1$", "$cat2$", "$cat3$", "$cat4$"}


def split_category_path(path: str) -> list[str]:
    """``$course$/top/A/B`` -> ``["A", "B"]`` (Moodle escapes "/" in names as "//")."""
    parts = [p.replace("\x00", "/") for p in path.replace("//", "\x00").split("/")]
    parts = [p.strip() for p in parts if p.strip()]
    while parts and (parts[0] in CONTEXT_TOKENS or parts[0] == "top"):
        parts = parts[1:]
    return parts


def join_category_path(names: list[str]) -> str:
    return "$course$/top/" + "/".join(n.replace("/", "//") for n in names)


def export_moodle_sections(sections: list[dict]) -> str:
    """Export ``[{"category": path, "info": str, "questions": [...]}, ...]``."""
    parts = ['<?xml version="1.0" encoding="UTF-8"?>', "<quiz>"]
    n = 0
    for section in sections:
        if section.get("category"):
            parts += [
                "<!-- question: 0  -->",
                '  <question type="category">',
                "    <category>",
                f"      {_plain(section['category'])}",
                "    </category>",
                '    <info format="moodle_auto_format">',
                f"      {_plain(section.get('info', ''))}",
                "    </info>",
                "    <idnumber></idnumber>",
                "  </question>",
                "",
            ]
        for q in section["questions"]:
            n += 1
            parts.append(f"<!-- question: {n}  -->")
            parts.append(_question_xml(q))
            parts.append("")
    parts.append("</quiz>")
    return "\n".join(parts) + "\n"


def export_moodle_xml(questions: list[dict], category: str = "", info: str = "") -> str:
    return export_moodle_sections([{"category": category, "info": info, "questions": questions}])
