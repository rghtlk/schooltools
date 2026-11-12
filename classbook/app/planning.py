"""A course's teaching hours, and which topics sit on them — from the synced records.

Planning records (all synced like everything else)::

    years          {name, start, end}
    holidays       {yearId, label, start, end}              free days, whole school
    courses        {..., yearId, slots: [{weekday, hours, start}], teacher, room, color, notes}
    cancellations  {courseId, date, reason}                 this course only
    extras         {courseId, date, hours, start, reason}   make-up sessions
    topics         {courseId, title, body, anchorDate, anchorHour, position}
    files          {topicId, courseId, filename, path, type, size}   bytes in data/files

Teaching hours are never stored. They follow from the year, its free days and
the course's weekly slots, so a free day added in February makes that hour
disappear and the topics on it fall back into the pool. ``js/plan.js`` computes
exactly the same hours in the browser; the two must stay in step.
"""
from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field
from types import SimpleNamespace

from .store import Store

WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]


@dataclass
class Unit:
    """One teaching hour on a concrete date."""

    date: dt.date
    start_time: str          # "" when unknown
    hour_in_day: int         # 1-based, within this course on this date
    hours_that_day: int
    source: str              # "regular" | "extra"
    note: str = ""


@dataclass
class CoursePlan:
    course: SimpleNamespace          # name, class_name, teacher, room, color, notes, id
    year: SimpleNamespace | None     # name, start_date, end_date
    slots: list[dict]
    units: list[Unit]
    topics: dict[int, list[dict]]    # unit index -> its topics, in order
    pool: list[dict]                 # topics not on the calendar (or whose hour is gone)
    files: dict[str, list[dict]] = field(default_factory=dict)   # topic id -> files

    def summary(self) -> dict:
        planned = len(self.topics)
        return {
            "units_total": len(self.units),
            "units_planned": planned,
            "units_free": len(self.units) - planned,
            "unplaced": len(self.pool),
            "teaching_days": len({u.date for u in self.units}),
            "topics": sum(len(v) for v in self.topics.values()) + len(self.pool),
        }


def _date(value) -> dt.date | None:
    try:
        return dt.date.fromisoformat(value) if value else None
    except (TypeError, ValueError):
        return None


def _int(value, default: int = 1, lo: int = 1, hi: int = 12) -> int:
    """A whole number, rounded half up like JavaScript's Math.round — the
    browser computes the same hours (js/plan.js) and must get the same result."""
    try:
        return max(lo, min(hi, math.floor(float(value) + 0.5)))
    except (TypeError, ValueError, OverflowError):
        return default


def compute_units(year, holidays, slots, cancellations, extras) -> list[Unit]:
    """Every teaching hour a course gets, in chronological order."""
    units: list[Unit] = []
    start, end = _date(year and year.get("start")), _date(year and year.get("end"))
    free = [(a, b) for a, b in ((_date(h.get("start")), _date(h.get("end") or h.get("start")))
                                for h in holidays) if a and b]
    cancelled = {_date(c.get("date")) for c in cancellations}

    by_weekday: dict[int, list[tuple[int, dict]]] = {}
    for i, s in enumerate(slots):
        wd = _int(s.get("weekday"), 0, 0, 6)
        by_weekday.setdefault(wd, []).append((i, s))

    if start and end and by_weekday:
        day = start
        while day <= end:
            todays = by_weekday.get(day.weekday())
            if todays and day not in cancelled and not any(a <= day <= b for a, b in free):
                ordered = sorted(todays, key=lambda t: (t[1].get("start") or "99:99", t[0]))
                total = sum(_int(s.get("hours")) for _, s in ordered)
                n = 0
                for _, s in ordered:
                    for _ in range(_int(s.get("hours"))):
                        n += 1
                        units.append(Unit(day, s.get("start") or "", n, total, "regular"))
            day += dt.timedelta(days=1)

    # An extra session on a day that already has lessons continues their
    # numbering (hour 3, 4, …) — two "hour 1" on one day would be the same key.
    taken: dict[dt.date, int] = {}
    for u in units:
        taken[u.date] = max(taken.get(u.date, 0), u.hour_in_day)
    for x in sorted(extras, key=lambda x: (x.get("date") or "", x.get("start") or "99:99", x.get("id") or "")):
        d = _date(x.get("date"))
        if not d:
            continue
        hours = _int(x.get("hours"))
        first = taken.get(d, 0)
        for i in range(hours):
            units.append(Unit(d, x.get("start") or "", first + i + 1, hours, "extra",
                              x.get("reason") or "extra session"))
        taken[d] = first + hours

    units.sort(key=lambda u: (u.date, u.start_time or "99:99", u.hour_in_day))
    return units


def load(store: Store, course_id: str) -> CoursePlan | None:
    """Everything the exports need about one course, resolved onto its hours."""
    course = store.get("courses", course_id)
    if course is None:
        return None
    cls = store.get("classes", course.get("classId") or "") or {}
    year = store.get("years", course.get("yearId") or "") if course.get("yearId") else None
    holidays = [h for h in store.records("holidays") if year and h.get("yearId") == year["id"]]
    mine = lambda tbl: [r for r in store.records(tbl) if r.get("courseId") == course_id]  # noqa: E731
    slots = [s for s in course.get("slots") or [] if isinstance(s, dict)]
    units = compute_units(year, holidays, slots, mine("cancellations"), mine("extras"))

    index = {(u.date, u.hour_in_day): i for i, u in enumerate(units)}
    topics: dict[int, list[dict]] = {}
    pool: list[dict] = []
    for t in sorted(mine("topics"), key=lambda t: (t.get("position") or 0, t["id"])):
        hour = t.get("anchorHour")
        hour = _int(hour, 0, 0, 99) if hour is not None else None
        at = index.get((_date(t.get("anchorDate")), hour))
        if at is None:
            pool.append(t)
        else:
            topics.setdefault(at, []).append(t)

    files: dict[str, list[dict]] = {}
    for f in store.records("files"):
        if f.get("courseId") == course_id:
            files.setdefault(f.get("topicId"), []).append(f)

    return CoursePlan(
        course=SimpleNamespace(
            id=course_id,
            name=course.get("name") or "",
            class_name=cls.get("name") or "",
            teacher=course.get("teacher") or "",
            room=course.get("room") or "",
            color=course.get("color") or "#2a4b9b",
            notes=course.get("notes") or "",
        ),
        year=SimpleNamespace(
            name=year.get("name") or "",
            start_date=_date(year.get("start")),
            end_date=_date(year.get("end")),
        ) if year else None,
        slots=slots,
        units=units,
        topics=topics,
        pool=pool,
        files=files,
    )


def slot_dicts(slots: list[dict]) -> list[dict]:
    """For the syllabus header: "Tuesday 08:00 (2h)"."""
    out = []
    for s in sorted(slots, key=lambda s: (_int(s.get("weekday"), 0, 0, 6), s.get("start") or "")):
        wd = _int(s.get("weekday"), 0, 0, 6)
        out.append({"weekday": wd, "weekday_name": WEEKDAY_NAMES[wd],
                    "hours": _int(s.get("hours")), "start_time": s.get("start") or ""})
    return out
