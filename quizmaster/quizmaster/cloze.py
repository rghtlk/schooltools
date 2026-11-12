"""Parser for Moodle's Cloze ("embedded answers") syntax.

A gap looks like ``{weight:TYPE:answer~answer...}``. Each answer is
``[=|%fraction%]text[#feedback]``; ``=`` means 100 %. NUMERICAL answers are
``value:tolerance``. ``\\`` escapes ``}``, ``~``, ``#``, ``/``, ``"`` and ``\\``.
"""

from __future__ import annotations

import html
import re

GAP_RE = re.compile(r"\{(\d*):([A-Za-z_]+):((?:\\.|[^\\}])*)\}", re.S)

# Moodle type name (and abbreviations) -> (kind, case_sensitive, shuffle)
_TYPES: dict[str, tuple[str, bool, bool]] = {}
for names, kind, cs, sh in [
    (("SHORTANSWER", "SA", "MW"), "shortanswer", False, False),
    (("SHORTANSWER_C", "SAC", "MWC"), "shortanswer", True, False),
    (("NUMERICAL", "NM"), "numerical", False, False),
    (("MULTICHOICE", "MC"), "select", False, False),
    (("MULTICHOICE_S", "MCS"), "select", False, True),
    (("MULTICHOICE_V", "MCV"), "radio_v", False, False),
    (("MULTICHOICE_VS", "MCVS"), "radio_v", False, True),
    (("MULTICHOICE_H", "MCH"), "radio_h", False, False),
    (("MULTICHOICE_HS", "MCHS"), "radio_h", False, True),
    (("MULTIRESPONSE", "MR"), "checkbox_v", False, False),
    (("MULTIRESPONSE_S", "MRS"), "checkbox_v", False, True),
    (("MULTIRESPONSE_H", "MRH"), "checkbox_h", False, False),
    (("MULTIRESPONSE_HS", "MRHS"), "checkbox_h", False, True),
]:
    for n in names:
        _TYPES[n] = (kind, cs, sh)


def _split(s: str, sep: str) -> list[str]:
    """Split at unescaped ``sep``."""
    parts, cur, i = [], "", 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s):
            cur += s[i:i + 2]
            i += 2
            continue
        if s[i] == sep:
            parts.append(cur)
            cur = ""
        else:
            cur += s[i]
        i += 1
    parts.append(cur)
    return parts


def _unescape(s: str) -> str:
    return html.unescape(re.sub(r"\\(.)", r"\1", s)).strip()


def parse_gap(weight: str, qtype: str, body: str) -> dict:
    kind, case_sensitive, shuffle = _TYPES.get(qtype.upper(), ("unknown", False, False))
    answers = []
    for raw in _split(body, "~"):
        if not raw.strip():
            continue
        m = re.match(r"\s*(=|%(-?[\d.]+)%)?(.*)", raw, re.S)
        fraction = 100.0 if m.group(1) == "=" else float(m.group(2)) if m.group(2) else 0.0
        text, *fb = _split(m.group(3), "#")
        answer = {"text": _unescape(text), "fraction": fraction, "feedback": _unescape(fb[0]) if fb else ""}
        if kind == "numerical":
            value, _, tol = answer["text"].partition(":")
            answer["value"], answer["tolerance"] = value.strip(), (tol.strip() or "0")
        answers.append(answer)
    return {
        "weight": int(weight) if weight else 1,
        "type": qtype.upper(),
        "kind": kind,
        "case_sensitive": case_sensitive,
        "shuffle": shuffle,
        "answers": answers,
    }


def parse_gaps(text: str) -> list[dict]:
    return [parse_gap(*m.groups()) for m in GAP_RE.finditer(text or "")]


def total_weight(text: str) -> float:
    return float(sum(g["weight"] for g in parse_gaps(text))) or 1.0


def best_answer(gap: dict) -> dict | None:
    return max(gap["answers"], key=lambda a: a["fraction"], default=None)
