// Planning: school years and free days, a course's weekly rhythm, its teaching
// hours, and the topics placed on them. Records (see app/planning.py):
//
//   years          {name, start, end}
//   holidays       {yearId, label, start, end}
//   courses        {..., yearId, slots: [{weekday, hours, start}], teacher, room, color, notes}
//   cancellations  {courseId, date, reason}
//   extras         {courseId, date, hours, start, reason}
//   topics         {courseId, title, body, anchorDate, anchorHour, position}
//   files          {topicId, courseId, filename, path, type, size}
//
// Teaching hours are derived, never stored — here and in app/planning.py, by
// the same rules, so the board and the printed documents always agree.

import * as db from './db.js';
import { collator, today, shiftDate } from './model.js';

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const WD_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const FORMAT = 1;   // planer's JSON format, which classbook reads and writes

// Rounded half up, exactly as app/planning.py does (_int): the board and the
// printed documents must agree on every hour.
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.floor(Number(v) + 0.5);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
const weekday = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;   // Monday = 0
};
const isISO = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// --- years and free days -----------------------------------------------------

export const years = () => db.all('years').sort((a, b) => (b.start || '').localeCompare(a.start || ''));
// Only free days with a real date: a broken record (from an import, say) is left out
// rather than crashing the calendar or the hours.
export const holidays = (yearId) => db.all('holidays', (x) => x.yearId === yearId && isISO(x.start))
  .map((x) => ({ ...x, end: isISO(x.end) && x.end >= x.start ? x.end : x.start }))
  .sort((a, b) => a.start.localeCompare(b.start));

// The year today falls in — else the most recent one.
export function currentYear() {
  const t = today();
  const list = years();
  return list.find((y) => y.start <= t && t <= y.end) || list[0] || null;
}

export function freeMap(yearId) {
  const map = new Map();
  for (const x of holidays(yearId)) {
    for (let d = x.start; d <= (x.end || x.start); d = shiftDate(d, 1)) map.set(d, x);
  }
  return map;
}

// Click on a day: make it free, or clear it. Inside a longer range the range
// is trimmed or split, so a single click always does the obvious thing.
export function toggleFreeDay(year, date) {
  const hit = holidays(year.id).find((x) => x.start <= date && date <= (x.end || x.start));
  if (!hit) return db.put('holidays', { yearId: year.id, label: '', start: date, end: date });
  const { id, ...d } = hit;
  const end = d.end || d.start;
  if (d.start === end) return db.remove('holidays', id);
  if (date === d.start) return db.put('holidays', { ...d, start: shiftDate(date, 1) }, id);
  if (date === end) return db.put('holidays', { ...d, end: shiftDate(date, -1) }, id);
  return db.write([
    { tbl: 'holidays', id, data: { ...d, end: shiftDate(date, -1) } },
    { tbl: 'holidays', data: { ...d, start: shiftDate(date, 1), end } },
  ]);
}

// A year goes with its free days. Its courses stay (they carry marks) and
// simply have no school year any more.
export function deleteYear(year) {
  return db.write([
    ...holidays(year.id).map((x) => ({ tbl: 'holidays', id: x.id, delete: true })),
    ...db.all('courses', (c) => c.yearId === year.id).map(({ id, ...c }) => ({ tbl: 'courses', id, data: { ...c, yearId: null } })),
    { tbl: 'years', id: year.id, delete: true },
  ]);
}

// --- a course's hours --------------------------------------------------------

export const topicsOf = (courseId) => db.all('topics', (t) => t.courseId === courseId);
export const cancellationsOf = (courseId) => db.all('cancellations', (x) => x.courseId === courseId).sort((a, b) => a.date.localeCompare(b.date));
export const extrasOf = (courseId) => db.all('extras', (x) => x.courseId === courseId).sort((a, b) => a.date.localeCompare(b.date));
export const filesOf = (topicId) => db.all('files', (f) => f.topicId === topicId).sort((a, b) => collator.compare(a.filename, b.filename));
export const slotsOf = (course) => (Array.isArray(course.slots) ? course.slots : []);

// Every teaching hour of the course, in order: {date, start, hour, hoursThatDay, source, note}.
export function units(course) {
  const year = course.yearId ? db.get('years', course.yearId) : null;
  const out = [];
  const slots = slotsOf(course);
  if (year && isISO(year.start) && isISO(year.end) && slots.length) {
    const free = freeMap(year.id);
    const cancelled = new Set(cancellationsOf(course.id).map((x) => x.date));
    const byWeekday = new Map();
    slots.forEach((s, i) => {
      const wd = clampInt(s.weekday, 0, 6, 0);
      if (!byWeekday.has(wd)) byWeekday.set(wd, []);
      byWeekday.get(wd).push([i, s]);
    });
    for (let d = year.start; d <= year.end; d = shiftDate(d, 1)) {
      const todays = byWeekday.get(weekday(d));
      if (!todays || free.has(d) || cancelled.has(d)) continue;
      const ordered = [...todays].sort((a, b) => (a[1].start || '99:99').localeCompare(b[1].start || '99:99') || a[0] - b[0]);
      const total = ordered.reduce((n, [, s]) => n + clampInt(s.hours, 1, 12, 1), 0);
      let n = 0;
      for (const [, s] of ordered) {
        for (let k = 0; k < clampInt(s.hours, 1, 12, 1); k++) {
          out.push({ date: d, start: s.start || '', hour: ++n, hoursThatDay: total, source: 'regular', note: '' });
        }
      }
    }
  }
  // An extra session on a day that already has lessons continues their
  // numbering (hour 3, 4, …): two "hour 1" on one day would share a key.
  // Same order and numbering as app/planning.py.
  const taken = new Map();
  for (const u of out) taken.set(u.date, Math.max(taken.get(u.date) || 0, u.hour));
  const extras = extrasOf(course.id).filter((x) => isISO(x.date))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start || '99:99').localeCompare(b.start || '99:99') || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const x of extras) {
    const hours = clampInt(x.hours, 1, 12, 1);
    const first = taken.get(x.date) || 0;
    for (let k = 0; k < hours; k++) {
      out.push({ date: x.date, start: x.start || '', hour: first + k + 1, hoursThatDay: hours, source: 'extra', note: x.reason || 'extra session' });
    }
    taken.set(x.date, first + hours);
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || (a.start || '99:99').localeCompare(b.start || '99:99') || a.hour - b.hour);
  return out;
}

export const teachingDays = (course) => [...new Set(units(course).map((u) => u.date))];

const byPosition = (a, b) => (a.position || 0) - (b.position || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The board: which topics sit on which hour; the rest is the pool. A topic
// whose hour has gone (a free day added later) lands in the pool, marked.
export function board(course) {
  const us = units(course);
  const at = new Map(us.map((u, i) => [`${u.date}|${u.hour}`, i]));
  const onHour = new Map();
  const pool = [];
  for (const t of topicsOf(course.id).sort(byPosition)) {
    const i = t.anchorDate ? at.get(`${t.anchorDate}|${t.anchorHour}`) : undefined;
    if (i === undefined) pool.push(t);
    else {
      if (!onHour.has(i)) onHour.set(i, []);
      onHour.get(i).push(t);
    }
  }
  const days = [];
  us.forEach((u, i) => {
    if (!days.length || days[days.length - 1].date !== u.date) days.push({ date: u.date, hours: [] });
    days[days.length - 1].hours.push({ ...u, index: i, topics: onHour.get(i) || [] });
  });
  return {
    units: us,
    days,
    pool,
    summary: {
      unitsTotal: us.length,
      unitsPlanned: onHour.size,
      unitsFree: us.length - onHour.size,
      unplaced: pool.length,
      teachingDays: days.length,
      topics: topicsOf(course.id).length,
    },
  };
}

// The topics planned for one date, in hour order (for the marking screen).
export function topicsOn(course, date) {
  const b = board(course);
  const day = b.days.find((d) => d.date === date);
  return day ? day.hours.flatMap((x) => x.topics) : [];
}

// --- topics ------------------------------------------------------------------

const nextPosition = (courseId) => topicsOf(courseId).reduce((n, t) => Math.max(n, t.position || 0), 0) + 1;

export function addTopic(courseId, title = '', anchor = null) {
  return db.put('topics', {
    courseId, title, body: '', anchorDate: anchor?.date || null, anchorHour: anchor?.hour || null, position: nextPosition(courseId),
  });
}

// One topic per line; blank lines skipped, list markers ("-", "1.") stripped.
const LIST_MARKER = /^\s*(?:[-*+•]|\d+[.)])\s+/;
export const topicLines = (text) => (text || '').split(/\r?\n/).map((l) => l.replace(LIST_MARKER, '').trim()).filter(Boolean).map((l) => l.slice(0, 300)).slice(0, 500);

export function addTopics(courseId, titles) {
  let pos = nextPosition(courseId);
  return db.write(titles.map((title) => ({
    tbl: 'topics', data: { courseId, title, body: '', anchorDate: null, anchorHour: null, position: pos++ },
  })));
}

// From the topic as it is now: a card drawn a moment ago may already be stale.
const topicOp = (t, fields) => {
  const { id, ...data } = db.get('topics', t.id) || t;
  return { tbl: 'topics', id, data: { ...data, ...fields } };
};

// Onto an hour, after whatever is there already — nothing is ever displaced.
export const place = (t, date, hour) => db.write([topicOp(t, { anchorDate: date, anchorHour: hour, position: nextPosition(t.courseId) })]);
export const unplace = (t) => db.write([topicOp(t, { anchorDate: null, anchorHour: null })]);
export const patchTopic = (t, fields) => db.write([topicOp(t, fields)]);

export function deleteTopics(topics) {
  return db.write(topics.flatMap((t) => [
    ...filesOf(t.id).map((f) => ({ tbl: 'files', id: f.id, delete: true })),
    { tbl: 'topics', id: t.id, delete: true },
  ]));
}

// Everything planning hangs off a course (used when the course is deleted).
export function planTombstones(courseId) {
  const dead = (tbl, rows) => rows.map((r) => ({ tbl, id: r.id, delete: true }));
  return [
    ...dead('topics', topicsOf(courseId)),
    ...dead('files', db.all('files', (f) => f.courseId === courseId)),
    ...dead('cancellations', cancellationsOf(courseId)),
    ...dead('extras', extrasOf(courseId)),
  ];
}

// A copy of the plan — rhythm, topics, where they sit — never the marks.
export async function duplicateCourse(course) {
  const { id, ...data } = course;
  const [copyId] = await db.write([{ tbl: 'courses', data: { ...data, name: `${course.name} (copy)` } }]);
  await db.write([
    ...topicsOf(id).map(({ id: _, ...t }) => ({ tbl: 'topics', data: { ...t, courseId: copyId } })),
    ...cancellationsOf(id).map(({ id: _, ...x }) => ({ tbl: 'cancellations', data: { ...x, courseId: copyId } })),
    ...extrasOf(id).map(({ id: _, ...x }) => ({ tbl: 'extras', data: { ...x, courseId: copyId } })),
  ]);
  return copyId;
}

// --- planer's JSON documents -------------------------------------------------
//
// Three kinds, as in planer — and planer's own exports can be imported:
//   calendar  a year and its free days, no courses
//   course    the rhythm, topics and where they sit, cancellations, extras
//   topics    titles and notes only, for reuse in another course

const envelope = (kind, rest) => ({ planer: FORMAT, kind, exported: today(), ...rest });

export function exportCalendar(year) {
  return envelope('calendar', {
    year: {
      name: year.name, start_date: year.start, end_date: year.end,
      holidays: holidays(year.id).map((x) => ({ label: x.label || '', start_date: x.start, end_date: x.end || x.start })),
    },
  });
}

function readingOrder(course) {
  const b = board(course);
  return [...b.days.flatMap((d) => d.hours.flatMap((x) => x.topics)), ...b.pool];
}

export function exportCourse(course) {
  const cls = db.get('classes', course.classId);
  const year = course.yearId ? db.get('years', course.yearId) : null;
  return envelope('course', {
    from_year: year?.name || '',
    course: {
      name: course.name, class_name: cls?.name || '', teacher: course.teacher || '', room: course.room || '',
      color: course.color || '#2a4b9b', notes: course.notes || '',
      slots: slotsOf(course).map((s) => ({ weekday: s.weekday, hours: s.hours, start_time: s.start || '' })),
      topics: readingOrder(course).map((t) => ({ title: t.title || '', body: t.body || '', anchor_date: t.anchorDate || null, anchor_hour: t.anchorHour || null })),
      cancellations: cancellationsOf(course.id).map((x) => ({ date: x.date, reason: x.reason || '' })),
      extras: extrasOf(course.id).map((x) => ({ date: x.date, hours: x.hours, start_time: x.start || '', reason: x.reason || '' })),
    },
  });
}

export function exportTopics(course) {
  const year = course.yearId ? db.get('years', course.yearId) : null;
  return envelope('topics', {
    from_course: course.name, from_year: year?.name || '',
    topics: readingOrder(course).map((t) => ({ title: t.title || '', body: t.body || '' })),
  });
}

const LABEL = { calendar: 'a calendar export', course: 'a course export', topics: 'a topic-list export' };
const SECTION = { calendar: 'year', course: 'course', topics: 'topics' };

// Returns [kind, payload] or throws an Error with a message for the user.
export function checkDoc(doc, ...kinds) {
  if (!doc || typeof doc !== 'object' || !('planer' in doc)) throw new Error('This is not a planer / classbook export.');
  if (Number(doc.planer) > FORMAT) throw new Error(`This file uses format ${doc.planer}; this version reads up to ${FORMAT}.`);
  if (!kinds.includes(doc.kind)) {
    throw new Error(`This looks like ${LABEL[doc.kind] || 'an unknown document'}, but ${kinds.map((k) => LABEL[k]).join(' or ')} is expected here.`);
  }
  const payload = doc[SECTION[doc.kind]];
  if (!payload) throw new Error(`The file has no “${SECTION[doc.kind]}” section.`);
  return [doc.kind, payload];
}

const str = (v, max = 100000) => (typeof v === 'string' ? v.slice(0, max) : '');
const hhmm = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : '');

function cleanHolidays(list) {
  return (Array.isArray(list) ? list : [])
    .filter((x) => isISO(x?.start_date))
    .map((x) => ({ label: str(x.label, 200), start: x.start_date, end: isISO(x.end_date) && x.end_date >= x.start_date ? x.end_date : x.start_date }));
}

export async function importCalendarAsYear(doc) {
  const [, y] = checkDoc(doc, 'calendar');
  if (!isISO(y.start_date) || !isISO(y.end_date)) throw new Error('The calendar has no valid start and end date.');
  const [yearId] = await db.write([{ tbl: 'years', data: { name: str(y.name, 120) || 'Imported year', start: y.start_date, end: y.end_date } }]);
  const list = cleanHolidays(y.holidays);
  await db.write(list.map((x) => ({ tbl: 'holidays', data: { yearId, ...x } })));
  return { yearId, holidays: list.length };
}

// Only the free days, into an existing year: outside it skipped, across its edge clipped.
export async function importHolidays(year, doc, replace) {
  const [, y] = checkDoc(doc, 'calendar');
  const ops = replace ? holidays(year.id).map((x) => ({ tbl: 'holidays', id: x.id, delete: true })) : [];
  let added = 0;
  let skipped = 0;
  for (const x of cleanHolidays(y.holidays)) {
    if (x.end < year.start || x.start > year.end) { skipped++; continue; }
    ops.push({ tbl: 'holidays', data: { yearId: year.id, label: x.label, start: x.start < year.start ? year.start : x.start, end: x.end > year.end ? year.end : x.end } });
    added++;
  }
  await db.write(ops);
  return { added, skipped };
}

// A course export becomes a new course of this class, in this school year.
// Topic pins are dates: those that do not meet an hour here land in the pool.
export async function importCourse(doc, classId, yearId, keepDates = true) {
  const [, c] = checkDoc(doc, 'course');
  const slots = (Array.isArray(c.slots) ? c.slots : []).map((s) => ({
    weekday: clampInt(s?.weekday, 0, 6, 0), hours: clampInt(s?.hours, 1, 12, 1), start: hhmm(s?.start_time),
  }));
  const [courseId] = await db.write([{
    tbl: 'courses',
    data: {
      classId, yearId: yearId || null, name: str(c.name, 200) || 'Imported course', slots,
      teacher: str(c.teacher, 120), room: str(c.room, 120), color: /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#2a4b9b', notes: str(c.notes),
    },
  }]);
  const topics = (Array.isArray(c.topics) ? c.topics : []).slice(0, 2000);
  await db.write([
    ...topics.map((t, i) => ({
      tbl: 'topics',
      data: {
        courseId, title: str(t?.title, 300), body: str(t?.body), position: i + 1,
        anchorDate: keepDates && isISO(t?.anchor_date) ? t.anchor_date : null,
        anchorHour: keepDates && isISO(t?.anchor_date) ? clampInt(t?.anchor_hour, 1, 24, 1) : null,
      },
    })),
    ...(Array.isArray(c.cancellations) ? c.cancellations : []).filter((x) => isISO(x?.date))
      .map((x) => ({ tbl: 'cancellations', data: { courseId, date: x.date, reason: str(x.reason, 200) } })),
    ...(Array.isArray(c.extras) ? c.extras : []).filter((x) => isISO(x?.date))
      .map((x) => ({ tbl: 'extras', data: { courseId, date: x.date, hours: clampInt(x.hours, 1, 12, 1), start: hhmm(x.start_time), reason: str(x.reason, 200) } })),
  ]);
  const course = db.get('courses', courseId);
  const s = board(course).summary;
  return { courseId, topics: topics.length, placed: s.topics - s.unplaced, pooled: s.unplaced };
}

// A topic list — or a whole course export, whose dates are dropped — appended to the pool.
export async function importTopics(course, doc) {
  const [kind, payload] = checkDoc(doc, 'topics', 'course');
  const list = (kind === 'topics' ? payload : payload.topics) || [];
  if (!Array.isArray(list) || !list.length) throw new Error('The file contains no topics.');
  let pos = nextPosition(course.id);
  await db.write(list.slice(0, 2000).map((t) => ({
    tbl: 'topics', data: { courseId: course.id, title: str(t?.title, 300), body: str(t?.body), anchorDate: null, anchorHour: null, position: pos++ },
  })));
  return { imported: Math.min(list.length, 2000), kind };
}
