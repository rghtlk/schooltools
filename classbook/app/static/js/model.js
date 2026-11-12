// What the records mean: classes, students and their seats, courses, marks, absences.
//
//   classes   {name, rows, cols}
//   students  {classId, firstName, lastName, photo (data URL) | null, seat "row,col" | null}
//   courses   {classId, name}
//   entries   {courseId, studentId, date "YYYY-MM-DD", kind "plus"|"star"|"minus"|"comment", text, at}
//             a star (★) is a super-plus; in the tile colours it counts as a +
//   absences  {courseId, studentId, date}   id = course|student|date
//
// An absence has a fixed id, so the phone and the computer marking the same student
// absent on the same day produce one record, not two. Marks have random ids:
// any number of them per student per day.

import * as db from './db.js';
import { planTombstones } from './plan.js';

export const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
export const byName = (a, b) => collator.compare(a.lastName, b.lastName) || collator.compare(a.firstName, b.firstName);

export const classes = () => db.all('classes').sort((a, b) => collator.compare(a.name, b.name));
// The class as it is now: a student who dropped out is left out everywhere —
// marking, seating plan, lists, summaries, grades, exports. Their records stay,
// so taking them back (droppedStudents → takeBack) restores everything.
export const students = (classId) => db.all('students', (s) => s.classId === classId && !s.droppedOut).sort(byName);
export const droppedStudents = (classId) => db.all('students', (s) => s.classId === classId && s.droppedOut)
  .sort((a, b) => (b.droppedOut || '').localeCompare(a.droppedOut || '') || byName(a, b));

const patchStudent = (s, fields) => {
  const { id, ...data } = db.get('students', s.id) || s;
  return db.write([{ tbl: 'students', id, data: { ...data, ...fields } }]);
};
// Dropped out today: off the class, and the seat is free for someone else.
export const dropOut = (s) => patchStudent(s, { droppedOut: today(), seat: null });
// Back in class — without a seat until one is given ("Not seated").
export const takeBack = (s) => patchStudent(s, { droppedOut: null });
export const courses = (classId) => db.all('courses', (c) => c.classId === classId).sort((a, b) => collator.compare(a.name, b.name));
export const entries = (courseId, pred) => db.all('entries', (e) => e.courseId === courseId && (!pred || pred(e))).sort((a, b) => a.at - b.at);
export const absences = (courseId, pred) => db.all('absences', (a) => a.courseId === courseId && (!pred || pred(a)));

export const fullName = (s) => `${s.firstName} ${s.lastName}`.trim();
export const initials = (s) => (((s.firstName || '')[0] || '') + ((s.lastName || '')[0] || '')).toUpperCase() || '?';

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shiftDate(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function formatDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, opts);
}

// --- marks and absences ------------------------------------------------------

export const absenceId = (courseId, studentId, date) => `${courseId}|${studentId}|${date}`;
export const isAbsent = (courseId, studentId, date) => !!db.get('absences', absenceId(courseId, studentId, date));

export function setAbsent(courseId, studentId, date, on) {
  const id = absenceId(courseId, studentId, date);
  return on ? db.put('absences', { courseId, studentId, date }, id) : db.remove('absences', id);
}

export function addEntry(courseId, studentId, date, kind, text = '') {
  return db.put('entries', { courseId, studentId, date, kind, text, at: Date.now() });
}

// --- deleting, with everything that hangs off it ----------------------------

const tombstones = (tbl, rows) => rows.map((r) => ({ tbl, id: r.id, delete: true }));

// A course's grading: categories, submissions, points.
const gradeTombstones = (pred) => ['scores', 'submissions', 'categories'].flatMap((tbl) => tombstones(tbl, db.all(tbl, pred)));

export function deleteCourse(id) {
  return db.write([
    ...planTombstones(id),
    ...gradeTombstones((x) => x.courseId === id),
    ...tombstones('entries', db.all('entries', (e) => e.courseId === id)),
    ...tombstones('absences', db.all('absences', (a) => a.courseId === id)),
    { tbl: 'courses', id, delete: true },
  ]);
}

export function deleteStudent(id) {
  return db.write([
    ...tombstones('entries', db.all('entries', (e) => e.studentId === id)),
    ...tombstones('absences', db.all('absences', (a) => a.studentId === id)),
    ...tombstones('scores', db.all('scores', (x) => x.studentId === id)),
    { tbl: 'students', id, delete: true },
  ]);
}

export function deleteClass(id) {
  const courseIds = new Set(courses(id).map((c) => c.id));
  return db.write([
    ...[...courseIds].flatMap(planTombstones),
    ...gradeTombstones((x) => courseIds.has(x.courseId)),
    ...tombstones('entries', db.all('entries', (e) => courseIds.has(e.courseId))),
    ...tombstones('absences', db.all('absences', (a) => courseIds.has(a.courseId))),
    ...tombstones('courses', courses(id)),
    ...tombstones('students', db.all('students', (s) => s.classId === id)),   // dropped out too
    { tbl: 'classes', id, delete: true },
  ]);
}

// --- the seating plan --------------------------------------------------------

export const seatKey = (r, c) => `${r},${c}`;

function validSeat(cls, seat) {
  if (typeof seat !== 'string') return false;
  const [r, c] = seat.split(',').map(Number);
  return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < cls.rows && c < cls.cols;
}

// Who sits where. Two students on one seat (possible after two devices moved
// people at once) leaves the second one unseated rather than hidden.
export function seatMap(cls, studs) {
  const grid = new Map();
  const unplaced = [];
  for (const s of studs) {
    if (validSeat(cls, s.seat) && !grid.has(s.seat)) grid.set(s.seat, s);
    else unplaced.push(s);
  }
  return { grid, unplaced };
}

const studentOp = (s, fields) => {
  const { id, ...data } = s;
  return { tbl: 'students', id, data: { ...data, ...fields } };
};

// Move a student to a seat (or off the plan, with seat = null). Whoever sat
// there takes the student's old seat — a swap.
export function moveStudent(cls, studentId, seat) {
  const studs = students(cls.id);
  const { grid } = seatMap(cls, studs);
  const me = studs.find((s) => s.id === studentId);
  if (!me) return Promise.resolve();
  const from = grid.get(me.seat)?.id === me.id ? me.seat : null;
  if (seat === from) return Promise.resolve();
  const ops = [studentOp(me, { seat })];
  const other = seat && grid.get(seat);
  if (other && other.id !== me.id) ops.push(studentOp(other, { seat: from }));
  return db.write(ops);
}

// Which of `n` rows (or columns) to drop to get down to `want`: empty ones
// first — those at the edges before gaps in the middle — and only then
// occupied ones, from the end.
function linesToDrop(n, want, used) {
  const drop = n - want;
  if (drop <= 0) return [];
  const empty = [...Array(n).keys()].filter((i) => !used.has(i));
  const edge = (i) => {
    let fromEnd = true;
    for (let j = i + 1; j < n; j++) if (used.has(j)) fromEnd = false;
    let fromStart = true;
    for (let j = 0; j < i; j++) if (used.has(j)) fromStart = false;
    return fromEnd || fromStart;
  };
  const order = [
    ...empty.filter(edge).sort((a, b) => b - a),
    ...empty.filter((i) => !edge(i)).sort((a, b) => b - a),
    ...[...Array(n).keys()].filter((i) => used.has(i)).sort((a, b) => b - a),
  ];
  return order.slice(0, drop);
}

// Resize the plan without losing anyone who need not be: empty rows and
// columns are removed wherever they are, and the students beyond them move up
// to close the gap. Returns who would lose their seat, and a function that
// does it — so the caller can ask first.
export function resizePlan(cls, rows, cols) {
  const studs = students(cls.id);
  const { grid } = seatMap(cls, studs);
  const at = [...grid].map(([key, s]) => [s, ...key.split(',').map(Number)]);
  const dropRows = linesToDrop(cls.rows, rows, new Set(at.map(([, r]) => r)));
  const dropCols = linesToDrop(cls.cols, cols, new Set(at.map(([, , c]) => c)));
  const shift = (i, dropped) => i - dropped.filter((d) => d < i).length;
  const ops = [];
  const displaced = [];
  for (const [s, r, c] of at) {
    if (dropRows.includes(r) || dropCols.includes(c)) {
      displaced.push(s);
      ops.push(studentOp(s, { seat: null }));
      continue;
    }
    const seat = seatKey(shift(r, dropRows), shift(c, dropCols));
    if (seat !== s.seat) ops.push(studentOp(s, { seat }));
  }
  const { id, ...data } = db.get('classes', cls.id) || cls;
  ops.push({ tbl: 'classes', id, data: { ...data, rows, cols } });
  return { displaced, apply: () => db.write(ops) };
}

// Seat everyone without a seat, alphabetically, row by row.
export function fillSeats(cls) {
  const studs = students(cls.id);
  const { grid, unplaced } = seatMap(cls, studs);
  const ops = [];
  for (let r = 0; r < cls.rows && unplaced.length; r++) {
    for (let c = 0; c < cls.cols && unplaced.length; c++) {
      if (!grid.has(seatKey(r, c))) ops.push(studentOp(unplaced.shift(), { seat: seatKey(r, c) }));
    }
  }
  return db.write(ops);
}

// Mirror the plan: front ↔ back (rows) and/or left ↔ right (cols), over the
// whole grid. Every seated student moves at once, so no two can collide.
export function flipSeats(cls, { rows = false, cols = false }) {
  const { grid, unplaced } = seatMap(cls, students(cls.id));
  const ops = [];
  for (const [key, s] of grid) {
    const [r, c] = key.split(',').map(Number);
    const to = seatKey(rows ? cls.rows - 1 - r : r, cols ? cls.cols - 1 - c : c);
    if (to !== key) ops.push(studentOp(s, { seat: to }));
  }
  // Someone left over from a clash still names a seat; after the flip that seat
  // could be free and they would appear there by accident.
  for (const s of unplaced) if (s.seat) ops.push(studentOp(s, { seat: null }));
  return db.write(ops);
}

export const clearSeats = (cls) => db.write(students(cls.id).filter((s) => s.seat).map((s) => studentOp(s, { seat: null })));

// --- adding students ---------------------------------------------------------

// One per line: "Surname, First name" or "First name Surname" (last word = surname).
export function parseRoster(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, ' ').trim();
    if (!line) continue;
    if (line.includes(',')) {
      const [last, ...first] = line.split(',');
      out.push({ firstName: first.join(',').trim(), lastName: last.trim() });
    } else {
      const parts = line.split(/\s+/);
      const last = parts.length > 1 ? parts.pop() : '';
      out.push({ firstName: parts.join(' '), lastName: last });
    }
  }
  return out;
}

// A square JPEG, cropped a little above centre (where faces are), ~20 kB.
export async function resizePhoto(file, size = 256) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - s) / 2;
    const sy = (img.naturalHeight - s) * 0.3;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    canvas.getContext('2d').drawImage(img, sx, sy, s, s, 0, 0, size, size);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The days with anything recorded for a course, newest first:
// [{date, marks, comments, absent}] — for the date picker on the marking screen.
export function recordedDays(course) {
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { date, marks: 0, comments: 0, absent: 0 });
    return days.get(date);
  };
  // Only the class as it is now: a dropped-out student's marks and absences
  // are both left out, as everywhere else.
  const inClass = new Set(students(course.classId).map((s) => s.id));
  for (const e of entries(course.id)) {
    if (!inClass.has(e.studentId)) continue;
    if (e.kind === 'comment') day(e.date).comments++;
    else day(e.date).marks++;
  }
  for (const a of absences(course.id)) if (inClass.has(a.studentId)) day(a.date).absent++;
  return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

// --- scores as JSON: one day, or the whole course ------------------------------
//
// One day:
//   {classbook: 1, kind: "day-scores", date, exported, class: {id, name}, course: {id, name},
//    students: [{id, lastName, firstName, absent, plus, star, minus,
//                entries: {plus: [uuid…], star: [uuid…], minus: [uuid…]}}]}
//
// The whole course — the same per student, summed over all dates, with
// `absent` as the number of days absent, and a day-by-day breakdown:
//   {classbook: 1, kind: "course-scores", exported, class, course, from, to, dates: [date…],
//    students: [{id, lastName, firstName, absent, plus, star, minus, entries: {…},
//                days: [{date, absent, plus, star, minus, entries: {…}}]}]}
//   (days lists only the dates with a mark or an absence for that student)
//
// Every student of the class is listed, also those without a mark. Kinds are
// named by meaning — plus, star (super-plus), minus — never by symbol.

const MARK_KINDS = ['plus', 'star', 'minus'];

function counted(ents) {
  const ids = Object.fromEntries(MARK_KINDS.map((k) => [k, ents.filter((e) => e.kind === k).map((e) => e.id)]));
  return { plus: ids.plus.length, star: ids.star.length, minus: ids.minus.length, entries: ids };
}

const header = (course, kind) => {
  const cls = db.get('classes', course.classId);
  return {
    classbook: 1,
    kind,
    exported: new Date().toISOString(),
    class: { id: cls?.id || course.classId, name: cls?.name || '' },
    course: { id: course.id, name: course.name },
  };
};

export function dayScores(course, date) {
  const ents = entries(course.id, (e) => e.date === date);
  const away = new Set(absences(course.id, (a) => a.date === date).map((a) => a.studentId));
  const { classbook, kind, exported, ...rest } = header(course, 'day-scores');
  return {
    classbook, kind, date, exported, ...rest,
    students: students(course.classId).map((s) => ({
      id: s.id, lastName: s.lastName, firstName: s.firstName, absent: away.has(s.id),
      ...counted(ents.filter((e) => e.studentId === s.id)),
    })),
  };
}

export function courseScores(course) {
  const ents = entries(course.id, (e) => MARK_KINDS.includes(e.kind));
  const abs = absences(course.id);
  const dates = [...new Set([...ents, ...abs].map((x) => x.date))].sort();
  return {
    ...header(course, 'course-scores'),
    from: dates[0] || null,
    to: dates[dates.length - 1] || null,
    dates,
    students: students(course.classId).map((s) => {
      const mine = ents.filter((e) => e.studentId === s.id);
      const away = new Set(abs.filter((a) => a.studentId === s.id).map((a) => a.date));
      const days = [...new Set([...mine.map((e) => e.date), ...away])].sort().map((date) => ({
        date, absent: away.has(date), ...counted(mine.filter((e) => e.date === date)),
      }));
      return {
        id: s.id, lastName: s.lastName, firstName: s.firstName, absent: away.size,
        ...counted(mine), days,
      };
    }),
  };
}

// --- how the marks look ------------------------------------------------------
//
// What is stored is the meaning — "plus", "star", "minus" — never the symbol,
// so changing the symbols (⚙ Settings, shared by every device) changes how
// the marks look everywhere, and nothing about what they count for.

export const DEFAULT_SYMBOLS = { plus: '●', star: '★', minus: '✕' };
export const MAX_SYMBOL = 3;   // characters as you see them (an emoji counts as one)

export const symbolLength = (s) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s)].length;

export function symbols() {
  const saved = db.get('settings', 'symbols') || {};
  const out = { ...DEFAULT_SYMBOLS };
  for (const k of Object.keys(DEFAULT_SYMBOLS)) {
    const v = typeof saved[k] === 'string' ? saved[k].trim() : '';
    if (v && symbolLength(v) <= MAX_SYMBOL) out[k] = v;
  }
  return out;
}

export const setSymbols = (next) => db.put('settings', { ...symbols(), ...next }, 'symbols');
export const resetSymbols = () => db.put('settings', { ...DEFAULT_SYMBOLS }, 'symbols');

// The preset reasons offered when a minus is given (⚙ Settings, shared by
// every device). A reason is stored as the entry's text.
export const DEFAULT_MINUS_REASONS = ['No homework', 'Not prepared', 'Disturbing', 'No materials', 'Phone', 'Late'];
export function minusReasons() {
  const saved = db.get('settings', 'minusReasons');
  return Array.isArray(saved?.reasons) ? saved.reasons.filter((r) => typeof r === 'string' && r.trim()) : [...DEFAULT_MINUS_REASONS];
}
export const setMinusReasons = (reasons) => db.put('settings', { reasons: reasons.map((r) => r.trim()).filter(Boolean) }, 'minusReasons');

// --- how a student stands --------------------------------------------------

// Each student's net score in the course (every + and ★ minus every −, all dates),
// and how far it is from the class average — in standard deviations, with
// at least one mark counting as one, so a single + in a class that is all
// level does not look like a landslide.
export function standing(course, studs) {
  const net = new Map(studs.map((s) => [s.id, 0]));
  for (const e of entries(course.id)) {
    if (!net.has(e.studentId)) continue;
    if (e.kind === 'plus' || e.kind === 'star') net.set(e.studentId, net.get(e.studentId) + 1);
    else if (e.kind === 'minus') net.set(e.studentId, net.get(e.studentId) - 1);
  }
  return standingOf(net);
}

// The same, from net scores already counted ({studentId → net}) — the summary
// passes those of the date range it shows.
export function standingOf(net) {
  const vals = [...net.values()];
  const n = vals.length || 1;
  const mean = vals.reduce((a, v) => a + v, 0) / n;
  const sd = Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / n);
  const scale = Math.max(sd, 1);
  return { mean, of: new Map([...net].map(([id, v]) => [id, { net: v, z: (v - mean) / scale }])) };
}

// The tile's colour for a z value: nothing near the average, full at 2 SD.
export function tint(z) {
  const strength = Math.max(0, Math.min(1, (Math.abs(z) - 0.25) / 1.75));
  if (!strength) return null;
  return `color-mix(in srgb, var(${z > 0 ? '--plus' : '--minus'}) ${Math.round(strength * 40)}%, var(--surface))`;
}

// --- the summary -------------------------------------------------------------

export function summarise(course, from, to) {
  const inRange = (x) => (!from || x.date >= from) && (!to || x.date <= to);
  const cls = db.get('classes', course.classId);
  const studs = cls ? students(cls.id) : [];
  const ents = entries(course.id, inRange);
  const abs = absences(course.id, inRange);
  const rows = new Map(studs.map((s) => [s.id, {
    student: s, plus: 0, star: 0, minus: 0, comments: 0, absent: new Set(), last: '', byDate: new Map(),
  }]));
  const day = (row, date) => {
    if (!row.byDate.has(date)) row.byDate.set(date, { entries: [], absent: false });
    if (date > row.last) row.last = date;
    return row.byDate.get(date);
  };
  for (const e of ents) {
    const row = rows.get(e.studentId);
    if (!row) continue;
    if (e.kind === 'plus') row.plus++;
    else if (e.kind === 'star') row.star++;
    else if (e.kind === 'minus') row.minus++;
    else row.comments++;
    day(row, e.date).entries.push(e);
  }
  for (const a of abs) {
    const row = rows.get(a.studentId);
    if (!row) continue;
    row.absent.add(a.date);
    day(row, a.date).absent = true;
  }
  const dates = [...new Set([...ents, ...abs].map((x) => x.date))].sort().reverse();
  return { rows: [...rows.values()], dates };
}

// --- restoring a backup ------------------------------------------------------
//
// A backup (⚙ → Download JSON here, or the server's /api/export) holds every live
// record, grouped by table: {students: [{id, ...fields}], ...} — but no dates of
// change and no deletions. So restoring is careful:
//   * a record this device has never seen is added,
//   * one deleted here since is left deleted,
//   * one that exists but differs is kept as it is — unless asked otherwise.

const MAX_RECORD = 600000;   // as the server: a bigger record would stop every sync

export function planRestore(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('This is not a Classbook backup.');
  if ('planer' in doc) throw new Error('This is a planer export — import it under a school year, a class’s courses or a plan instead.');
  const known = db.TABLES.filter((t) => Array.isArray(doc[t]));
  if (!known.length) throw new Error('This is not a Classbook backup: it contains no classes, students or marks.');
  const add = [];
  const differ = [];
  let same = 0;
  let deleted = 0;
  let invalid = 0;
  const counts = {};
  for (const tbl of known) {
    for (const rec of doc[tbl]) {
      if (!rec || typeof rec !== 'object' || typeof rec.id !== 'string' || !rec.id || rec.id.length > 200) { invalid++; continue; }
      const { id, ...data } = rec;
      // bytes, as the server counts them (umlauts and emoji take more than one)
      if (new TextEncoder().encode(JSON.stringify(data)).length > MAX_RECORD) { invalid++; continue; }
      const here = db.peek(tbl, id);
      if (!here) { add.push({ tbl, id, data }); counts[tbl] = (counts[tbl] || 0) + 1; }
      else if (here.deleted) deleted++;
      else if (JSON.stringify(sortKeys(here.data)) === JSON.stringify(sortKeys(data))) same++;
      else differ.push({ tbl, id, data });
    }
  }
  return { add, differ, same, deleted, invalid, counts };
}

const sortKeys = (o) => (o && typeof o === 'object' && !Array.isArray(o)
  ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortKeys(o[k])]))
  : Array.isArray(o) ? o.map(sortKeys) : o);

export async function applyRestore(plan, replaceDiffering) {
  const ops = [...plan.add, ...(replaceDiffering ? plan.differ : [])];
  for (let i = 0; i < ops.length; i += 500) await db.write(ops.slice(i, i + 500));
  return ops.length;
}

// --- files -------------------------------------------------------------------

// Semicolon-separated with a BOM: what Excel in a German locale opens correctly.
export function csv(rows) {
  const cell = (v) => {
    let s = v == null ? '' : String(v);
    // Text that Excel would run as a formula (a comment starting with "=", say)
    // gets a leading apostrophe; numbers like -2 stay numbers.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n');
}

export function download(filename, content, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
