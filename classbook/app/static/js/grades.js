// Grading: categories (exam, homework, …) with a weight, submissions with a
// maximum of points, points per student, a CSV import — and from all of it,
// together with participation, a final percentage and grade.
//
//   categories   {courseId, name, weight, position, kind?}   kind "participation": built in,
//                                                          id = course|participation
//   submissions  {courseId, categoryId, name, maxPoints, date, position}
//   scores       {courseId, submissionId, studentId, points, absent?, missing?}  id = submission|student
//
// A student without points for a submission is not graded on it: it does not
// count (enter 0 for zero points). Two such cases are told apart, and do not
// count either — the averages are over the submissions a student has points for:
//   absent   points null, absent true    not there (or not in the imported file)
//   missing  points null, missing true   in the imported file, but without points
//
//   participation %  = (● + ★) / (● + ★ + ✕), over the whole course
//   submission %     = 100 · points / max points
//   category %       = Σ points / Σ max points, over the submissions graded
//   final %          = Σ weight · category % / Σ weight, over the categories with a value
//   grade            = from the course's scale (default 87.5 / 75 / 62.5 / 50 % for 1–4)
//
//   #/course/:id/grades            categories, weights, submissions, scale, CSV import
//   #/course/:id/grades/:subId     points of one submission

import * as db from './db.js';
import * as m from './model.js';
import { h, toast, field, page, link, go, hooks } from './ui.js';
import { courseTabs } from './planviews.js';
import { teachingDays } from './plan.js';

export const DEFAULT_SCALE = [87.5, 75, 62.5, 50];
const partId = (courseId) => `${courseId}|participation`;
export const scoreId = (submissionId, studentId) => `${submissionId}|${studentId}`;
const byPosition = (a, b) => (a.position || 0) - (b.position || 0) || m.collator.compare(a.name || '', b.name || '');
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const fmt = (v, digits = 1) => (v == null ? '–' : `${v.toFixed(digits).replace(/\.0+$/, '')}`);

// --- the model ---------------------------------------------------------------

export function categories(course) {
  const part = db.get('categories', partId(course.id))
    || { id: partId(course.id), courseId: course.id, kind: 'participation', name: 'Participation', weight: 1, position: 0 };
  const rest = db.all('categories', (c) => c.courseId === course.id && c.kind !== 'participation').sort(byPosition);
  return [part, ...rest];
}

export const submissions = (categoryId) => db.all('submissions', (s) => s.categoryId === categoryId)
  .sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || byPosition(a, b));

export const scoreOf = (submissionId, studentId) => num(db.get('scores', scoreId(submissionId, studentId))?.points);
export const absentFrom = (submissionId, studentId) => !!db.get('scores', scoreId(submissionId, studentId))?.absent;
export const missingFrom = (submissionId, studentId) => !!db.get('scores', scoreId(submissionId, studentId))?.missing;

export function setScore(sub, studentId, points) {
  const id = scoreId(sub.id, studentId);
  if (points == null) return db.get('scores', id) ? db.remove('scores', id) : Promise.resolve();
  return db.put('scores', { courseId: sub.courseId, submissionId: sub.id, studentId, points }, id);
}

// Absent replaces any points; present again means not graded (empty).
export function setAbsentFrom(sub, studentId, on) {
  const id = scoreId(sub.id, studentId);
  if (!on) return db.get('scores', id) ? db.remove('scores', id) : Promise.resolve();
  return db.put('scores', { courseId: sub.courseId, submissionId: sub.id, studentId, points: null, absent: true }, id);
}

export function setWeight(course, cat, weight) {
  if (cat.kind === 'participation') {
    return db.put('categories', { courseId: course.id, kind: 'participation', name: 'Participation', weight, position: 0 }, partId(course.id));
  }
  return db.patch('categories', cat.id, { weight });
}

export const scaleOf = (course) => (Array.isArray(course.gradeScale) && course.gradeScale.length === 4 ? course.gradeScale.map(Number) : DEFAULT_SCALE);
export function gradeFor(course, pct) {
  if (pct == null) return null;
  const scale = scaleOf(course);
  for (let g = 0; g < 4; g++) if (pct >= scale[g]) return g + 1;
  return 5;
}

export function participationPct(course, studentId) {
  let good = 0;
  let bad = 0;
  for (const e of m.entries(course.id, (x) => x.studentId === studentId)) {
    if (e.kind === 'plus' || e.kind === 'star') good++;
    else if (e.kind === 'minus') bad++;
  }
  return good + bad ? (100 * good) / (good + bad) : null;
}

// Every student's percentages: per submission, per category, final, grade.
export function computeGrades(course) {
  const cats = categories(course);
  const subs = new Map(cats.map((c) => [c.id, c.kind === 'participation' ? [] : submissions(c.id)]));
  const rows = m.students(course.classId).map((s) => {
    const perSub = {};
    const perCat = {};
    const absent = new Set();   // submission ids
    const missing = new Set();
    let acc = 0;
    let wsum = 0;
    for (const c of cats) {
      let pct = null;
      if (c.kind === 'participation') pct = participationPct(course, s.id);
      else {
        let got = 0;
        let max = 0;
        for (const sub of subs.get(c.id)) {
          const p = scoreOf(sub.id, s.id);
          const mx = num(sub.maxPoints);
          if (absentFrom(sub.id, s.id)) absent.add(sub.id);
          if (missingFrom(sub.id, s.id)) missing.add(sub.id);
          if (p == null || !mx) { perSub[sub.id] = null; continue; }
          perSub[sub.id] = (100 * p) / mx;
          got += p;
          max += mx;
        }
        pct = max ? (100 * got) / max : null;
      }
      perCat[c.id] = pct;
      const w = num(c.weight) ?? 0;
      if (pct != null && w > 0) { acc += w * pct; wsum += w; }
    }
    // Rounded once, as it is shown: the grade follows the number on screen.
    const final = wsum ? Math.round((acc / wsum) * 10) / 10 : null;
    return { student: s, perSub, perCat, absent, missing, final, grade: gradeFor(course, final) };
  });
  return { cats, subs, rows };
}

// Removing things together with what hangs off them.
export function gradeTombstones(courseId) {
  const dead = (tbl, pred) => db.all(tbl, pred).map((r) => ({ tbl, id: r.id, delete: true }));
  return [
    ...dead('scores', (x) => x.courseId === courseId),
    ...dead('submissions', (x) => x.courseId === courseId),
    ...dead('categories', (x) => x.courseId === courseId),
  ];
}
export const studentScoreTombstones = (studentId) => db.all('scores', (x) => x.studentId === studentId).map((r) => ({ tbl: 'scores', id: r.id, delete: true }));

function deleteSubmission(sub) {
  return db.write([
    ...db.all('scores', (x) => x.submissionId === sub.id).map((r) => ({ tbl: 'scores', id: r.id, delete: true })),
    { tbl: 'submissions', id: sub.id, delete: true },
  ]);
}

function deleteCategory(cat) {
  const subs = submissions(cat.id);
  const ids = new Set(subs.map((s) => s.id));
  return db.write([
    ...db.all('scores', (x) => ids.has(x.submissionId)).map((r) => ({ tbl: 'scores', id: r.id, delete: true })),
    ...subs.map((s) => ({ tbl: 'submissions', id: s.id, delete: true })),
    { tbl: 'categories', id: cat.id, delete: true },
  ]);
}

// --- CSV ---------------------------------------------------------------------

// RFC 4180, with the separator guessed from the header line (, ; or tab).
export function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  // Excel sometimes writes the separator into a first line of its own: "sep=;".
  let forced = null;
  const sep = text.match(/^sep=(.)\r?\n/i);
  if (sep) { forced = sep[1]; text = text.slice(sep[0].length); }
  // The separator: whichever of , ; tab occurs most in the header line —
  // counted outside quotes, so a quoted title with commas does not mislead.
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => { let n = 0; let q = false; for (const c of firstLine) { if (c === '"') q = !q; else if (!q && c === ch) n++; } return n; };
  const delim = forced || [';', '\t', ','].sort((a, b) => count(b) - count(a))[0];
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let atStart = true;   // a quote only opens a quoted field at its very start
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && atStart) { quoted = true; atStart = false; }
    else if (ch === delim) { row.push(cell); cell = ''; atStart = true; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = ''; atStart = true;
    } else { cell += ch; atStart = false; }
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const kept = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (kept.length < 2) throw new Error('The file has no rows below its header.');
  const header = kept[0].map((c) => c.replace(/ /g, ' ').trim());
  return { delim, header, rows: kept.slice(1) };
}

// "", "-" → no points; "9.5" / "9,5" → 9.5; anything else → NaN (an error).
export function parsePoints(v) {
  const s = String(v ?? '').replace(/ /g, ' ').trim();
  if (!s || /^[-–—]$/.test(s)) return null;
  const plain = s.replace(/\s/g, '');
  // Only plain numbers: "0x10" or "1e3" are not points someone typed.
  if (!/^[-+]?\d+(?:[.,]\d+)?$/.test(plain)) return NaN;
  return Number(plain.replace(',', '.'));
}

// "Aufgabe: NSCSU01: Labor … (Punkte)" → "NSCSU01: Labor …"
export const columnTitle = (header) => header.replace(/^(Aufgabe|Test|Assignment|Quiz|Forum|Workshop)\s*:\s*/i, '').replace(/\s*\((Punkte|Points|Real|Prozentsatz|Percentage)\)\s*$/i, '').trim();

const FIRST = /^(vorname|first ?name|given ?name|firstname)$/i;
const LAST = /^(nachname|surname|last ?name|lastname|family ?name|familienname)$/i;
export const guessNameColumns = (header) => ({ first: header.findIndex((x) => FIRST.test(x)), last: header.findIndex((x) => LAST.test(x)) });

// A line that is not a student: Moodle's "Overall average" at the end, a total,
// or no name at all. Only offered for ignoring — never dropped unasked.
const SUMMARY = /average|durchschnitt|mittelwert|^(overall|total|summe?|gesamt|mean|median)\b/i;
export const looksLikeSummary = (p) => { const name = `${p.firstName} ${p.lastName}`.trim(); return !name || SUMMARY.test(name); };

// --- matching names ----------------------------------------------------------
//
// Robust against accents and spelling variants (ä / ae / a, ß / ss), hyphens,
// extra first names ("Erika Maria" ↔ "Erika"), small typos (edit distance), and
// first and last name swapped. Each name is used at most once.

// Lenient, for finding each other: also "ue" = "u", so Müster / Muester / Muster meet.
export const normName = (s) => strictName(s).replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u');
// Strict, for "exact": only accents, ß and punctuation are ignored — Beispiel ≠ Beispil.
function strictName(s) {
  return (s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}
// An umlaut written out (ä → ae) is the same name too.
const spelledOut = (s) => strictName((s || '').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
  .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue'));
const sameName = (a, b) => strictName(a) === strictName(b) || spelledOut(a) === spelledOut(b);

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length || !b.length) return a.length + b.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const sim = (a, b) => (!a && !b ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length));
// Whole names, or the best pair of single words (one of several first names).
// Name particles and initials say nothing about who someone is: "Al Muster" and
// "Al Probe", "van Test" and "van Probe" must not meet on them.
const PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'du', 'la', 'le', 'al', 'el', 'bin', 'ibn', 'ten', 'ter', 'zu', 'mc', 'mac']);
const telling = (w) => w.length > 2 && !PARTICLES.has(w);
const nameSim = (a, b) => {
  const wa = a.split(' ').filter(telling);
  const wb = b.split(' ').filter(telling);
  let best = sim(a, b);
  for (const x of wa) for (const y of wb) best = Math.max(best, 0.97 * sim(x, y));
  return best;
};

const ACCEPT = 0.8;      // overall, to count as the same person
const SURNAME = 0.75;    // the surname alone has to be at least this close
// Anything short of the same name (sameName, both parts) is shown as "please check".

export function matchNames(students, people) {
  const S = students.map((s) => ({ s, first: normName(s.firstName), last: normName(s.lastName), raw: s }));
  const P = people.map((p, i) => ({ i, first: normName(p.firstName), last: normName(p.lastName), raw: p }));
  const pairs = [];
  for (const a of S) {
    for (const b of P) {
      const direct = { last: nameSim(a.last, b.last), first: nameSim(a.first, b.first) };
      const swapped = { last: nameSim(a.last, b.first), first: nameSim(a.first, b.last) };
      for (const [cand, factor] of [[direct, 1], [swapped, 0.95]]) {
        const score = factor * (0.6 * cand.last + 0.4 * cand.first);
        if (cand.last < SURNAME || score < ACCEPT) continue;
        // The closer spelling wins a tie (a Beispiel and a Beispil in one class).
        const exact = factor === 1 && sameName(a.raw.lastName, b.raw.lastName) && sameName(a.raw.firstName, b.raw.firstName);
        const tie = 0.001 * sim(strictName(`${a.raw.lastName} ${a.raw.firstName}`), strictName(`${b.raw.lastName} ${b.raw.firstName}`));
        pairs.push({ student: a.s, row: b.i, score, exact, rank: score + tie + (exact ? 0.01 : 0) });
      }
    }
  }
  pairs.sort((x, y) => y.rank - x.rank);
  const usedS = new Set();
  const usedP = new Set();
  const matches = [];
  for (const p of pairs) {
    if (usedS.has(p.student.id) || usedP.has(p.row)) continue;
    usedS.add(p.student.id);
    usedP.add(p.row);
    matches.push({ student: p.student, row: p.row, score: p.score, sure: p.exact });
  }
  // The same name twice (in the class, or in the file): the pairing between
  // them is a guess — said, and those matches are marked to check.
  const dupKey = (p) => `${normName(p.lastName)}|${normName(p.firstName)}`;
  const twice = (list) => {
    const seen = new Map();
    for (const p of list) seen.set(dupKey(p), (seen.get(dupKey(p)) || 0) + 1);
    return new Set([...seen].filter(([, n]) => n > 1).map(([k]) => k));
  };
  const dupS = twice(students);
  const dupP = twice(people);
  for (const x of matches) if (dupS.has(dupKey(x.student)) || dupP.has(dupKey(people[x.row]))) x.sure = false;
  return {
    matches,
    missingInFile: students.filter((s) => !usedS.has(s.id)),
    missingInClass: people.filter((_, i) => !usedP.has(i)),
    duplicates: [...new Set([...dupS, ...dupP])].map((k) => k.split('|').reverse().join(' ')),
  };
}

// --- screens -----------------------------------------------------------------

const imp = { courseId: null, data: null };   // the CSV being imported (in memory only)

export function gradesScreen(course) {
  const cls = db.get('classes', course.classId);
  const cats = categories(course);
  const weights = cats.map((c) => num(c.weight) ?? 0);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const studs = m.students(course.classId);

  const weightInput = (c) => h('input', {
    type: 'number', min: 0, step: 'any', value: num(c.weight) ?? 0, class: 'weight-input', 'aria-label': `Weight of ${c.name}`,
    dataset: { focusKey: `w-${c.id}` },
    onchange: (e) => { const w = Math.max(0, num(e.target.value) ?? 0); setWeight(course, c, w); },
  });

  const catRow = (c, i) => h('tr', {},
    h('td', c.kind === 'participation'
      ? [h('strong', 'Participation'), h('div', { class: 'muted small' }, `${m.symbols().plus} and ${m.symbols().star} against ${m.symbols().minus}: (${m.symbols().plus}+${m.symbols().star}) / all marks`)]
      : h('input', { value: c.name, 'aria-label': 'Category name', dataset: { focusKey: `n-${c.id}` }, onchange: (e) => e.target.value.trim() && db.patch('categories', c.id, { name: e.target.value.trim() }) })),
    h('td', { class: 'num' }, weightInput(c)),
    h('td', { class: 'num muted' }, wsum ? `${fmt((100 * weights[i]) / wsum, 1)} %` : '–'),
    h('td', { class: 'num muted' }, c.kind === 'participation' ? '' : `${submissions(c.id).length} submissions`),
    h('td', c.kind === 'participation' ? null : h('button', {
      class: 'mini danger',
      onclick: () => {
        const n = submissions(c.id).length;
        if (confirm(`Delete the category “${c.name}”${n ? ` with its ${n} submissions and all their points` : ''}?`)) deleteCategory(c);
      },
    }, 'Delete')));

  const newCat = h('input', { placeholder: 'e.g. Exams', required: true });
  const newWeight = h('input', { type: 'number', min: 0, step: 'any', value: 1, class: 'weight-input' });

  const subsCard = (c) => {
    const subs = submissions(c.id);
    const name = h('input', { placeholder: 'e.g. Test 1', required: true });
    const max = h('input', { type: 'number', min: 0, step: 'any', placeholder: 'max points', required: true, class: 'weight-input' });
    const date = h('input', { type: 'date' });
    return h('div', { class: 'card' },
      h('h2', c.name, h('span', { class: 'muted small' }, `  · weight ${fmt(num(c.weight) ?? 0, 2)}`)),
      subs.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'summary' },
        h('thead', h('tr', h('th', 'Submission'), h('th', 'Date'), h('th', { class: 'num' }, 'Max'), h('th', { class: 'num' }, 'Graded'), h('th', { class: 'num' }, 'Average'))),
        h('tbody', subs.map((s) => {
          const pts = studs.map((st) => scoreOf(s.id, st.id)).filter((p) => p != null);
          const away = studs.filter((st) => absentFrom(s.id, st.id)).length;
          const lacking = studs.filter((st) => missingFrom(s.id, st.id)).length;
          const avg = pts.length && num(s.maxPoints) ? (100 * pts.reduce((a, b) => a + b, 0)) / (pts.length * num(s.maxPoints)) : null;
          return h('tr', { class: 'clickable', onclick: () => go(`/course/${course.id}/grades/${s.id}`) },
            h('td', link(`/course/${course.id}/grades/${s.id}`, s.name)),
            h('td', { class: 'muted' }, s.date ? m.formatDate(s.date, { day: 'numeric', month: 'short', year: 'numeric' }) : ''),
            h('td', { class: 'num' }, fmt(num(s.maxPoints), 2)),
            h('td', { class: 'num' }, `${pts.length} / ${studs.length}`, away ? h('span', { class: 'away small' }, ` · ${away} absent`) : null,
              lacking ? h('span', { class: 'missing small' }, ` · ${lacking} missing`) : null),
            h('td', { class: 'num' }, avg == null ? '–' : `${fmt(avg)} %`));
        })))) : h('p', { class: 'muted' }, 'No submissions yet.'),
      h('form', {
        class: 'inline-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const mx = num(max.value);
          if (!mx || mx <= 0) return toast('Enter the maximum points.');
          const pos = subs.reduce((a, s) => Math.max(a, s.position || 0), 0) + 1;
          const id = await db.put('submissions', { courseId: course.id, categoryId: c.id, name: name.value.trim(), maxPoints: mx, date: date.value || '', position: pos });
          go(`/course/${course.id}/grades/${id}`);
        },
      }, name, max, date, h('button', { class: 'primary' }, 'Add submission')));
  };

  const scale = scaleOf(course);
  const scaleInput = (i) => h('input', {
    type: 'number', min: 0, max: 100, step: 'any', value: scale[i], class: 'weight-input', 'aria-label': `Lowest % for grade ${i + 1}`,
    dataset: { focusKey: `s-${i}` },
    onchange: (e) => {
      const next = [...scale];
      next[i] = num(e.target.value) ?? scale[i];
      if (next.some((v, k) => k && v > next[k - 1])) { toast('Each grade needs a lower threshold than the one before.'); e.target.value = scale[i]; e.target.blur(); return; }
      db.patch('courses', course.id, { gradeScale: next });
    },
  });

  return page(course.name, { href: `/class/${cls.id}/courses`, label: cls.name },
    courseTabs(course, 'grades'),
    h('div', { class: 'card' },
      h('h2', 'Categories and weights'),
      h('p', { class: 'hint' }, 'The final grade is the weighted average of the categories a student has results in. A weight of 0 leaves a category out.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'summary' },
        h('thead', h('tr', h('th', 'Category'), h('th', { class: 'num' }, 'Weight'), h('th', { class: 'num' }, 'Share'), h('th', ''), h('th', ''))),
        h('tbody', cats.map(catRow)))),
      h('form', {
        class: 'inline-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const pos = cats.reduce((a, c) => Math.max(a, c.position || 0), 0) + 1;
          await db.put('categories', { courseId: course.id, name: newCat.value.trim(), weight: Math.max(0, num(newWeight.value) ?? 1), position: pos });
          newCat.value = '';
        },
      }, newCat, newWeight, h('button', { class: 'primary' }, 'Add category'))),
    cats.filter((c) => c.kind !== 'participation').map(subsCard),
    importCard(course, cats.filter((c) => c.kind !== 'participation')),
    h('div', { class: 'card' },
      h('h2', 'Grade scale'),
      h('p', { class: 'hint' }, 'The lowest final percentage for each grade; below the last one it is a 5.'),
      h('div', { class: 'row-buttons' }, [0, 1, 2, 3].map((i) => h('label', { class: 'size' }, `${i + 1}  from`, scaleInput(i), '%'))),
      h('button', { class: 'mini ghost', onclick: () => db.patch('courses', course.id, { gradeScale: DEFAULT_SCALE }) }, `Back to ${DEFAULT_SCALE.join(' / ')}`)),
    h('div', { class: 'row-buttons' }, link(`/course/${course.id}/summary?tab=grades`, 'All grades in the summary →')));
}

export function submissionScreen(course, sub) {
  const cls = db.get('classes', course.classId);
  const studs = m.students(course.classId);
  const max = num(sub.maxPoints);
  const cats = categories(course).filter((c) => c.kind !== 'participation');
  const ptsInput = (s, i) => h('input', {
    type: 'text', inputmode: 'decimal', class: 'points-input', value: scoreOf(sub.id, s.id) ?? '', placeholder: '–',
    disabled: absentFrom(sub.id, s.id),
    'aria-label': `Points for ${m.fullName(s)}`, dataset: { focusKey: `p-${s.id}`, row: i },
    onchange: (e) => {
      const v = parsePoints(e.target.value);
      if (Number.isNaN(v)) { toast('Points must be a number (or empty for “not graded”).'); e.target.value = scoreOf(sub.id, s.id) ?? ''; return; }
      if (v != null && max && v > max) toast(`More than the maximum of ${max} — kept as bonus points.`);
      setScore(sub, s.id, v);
    },
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      e.target.blur();
      requestAnimationFrame(() => document.querySelector(`.points-input[data-row="${i + 1}"]`)?.focus());
    },
  });
  const absentBox = (s) => h('input', {
    type: 'checkbox', checked: absentFrom(sub.id, s.id), 'aria-label': `${m.fullName(s)} absent`,
    onchange: (e) => setAbsentFrom(sub, s.id, e.target.checked),
  });
  const pts = studs.map((s) => scoreOf(sub.id, s.id)).filter((p) => p != null);
  const away = studs.filter((s) => absentFrom(sub.id, s.id)).length;
  const lacking = studs.filter((s) => missingFrom(sub.id, s.id)).length;

  return page(sub.name, { href: `/course/${course.id}/grades`, label: `${course.name} · Grades` },
    courseTabs(course, 'grades'),
    h('div', { class: 'toolbar' },
      h('label', { class: 'size' }, 'Name', h('input', { value: sub.name, dataset: { focusKey: 'sub-name' }, onchange: (e) => e.target.value.trim() && db.patch('submissions', sub.id, { name: e.target.value.trim() }) })),
      h('label', { class: 'size' }, 'Category', h('select', { onchange: (e) => db.patch('submissions', sub.id, { categoryId: e.target.value }) },
        cats.map((c) => h('option', { value: c.id, selected: c.id === sub.categoryId }, c.name)))),
      h('label', { class: 'size' }, 'Max points', h('input', {
        type: 'number', min: 0, step: 'any', value: max ?? '', class: 'weight-input', dataset: { focusKey: 'sub-max' },
        onchange: (e) => { const v = num(e.target.value); if (v && v > 0) db.patch('submissions', sub.id, { maxPoints: v }); else { e.target.value = max ?? ''; e.target.blur(); } },
      })),
      h('label', { class: 'size' }, 'Date', h('input', { type: 'date', value: sub.date || '', onchange: (e) => db.patch('submissions', sub.id, { date: e.target.value }) }))),
    h('p', { class: 'hint' }, `${pts.length} of ${studs.length} graded${away ? `, ${away} absent` : ''}${lacking ? `, ${lacking} missing (no points in the imported file)` : ''}. Type the points and press Enter for the next student; empty means not graded (it does not count) — enter 0 for zero points. Absent and missing do not count either.`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'summary points-table' },
      h('thead', h('tr', h('th', 'Student'), h('th', { class: 'num' }, `Points (of ${fmt(max, 2)})`), h('th', { class: 'num' }, '%'), h('th', { class: 'num' }, 'Absent'))),
      h('tbody', studs.map((s, i) => {
        const p = scoreOf(sub.id, s.id);
        const gone = absentFrom(sub.id, s.id);
        const lack = !gone && missingFrom(sub.id, s.id);
        return h('tr', { class: gone ? 'absent' : lack ? 'missing' : '' },
          h('td', s.lastName, ' ', h('span', { class: 'muted' }, s.firstName)),
          h('td', { class: 'num' }, ptsInput(s, i)),
          h('td', { class: 'num' }, gone ? h('span', { class: 'away' }, 'absent') : lack ? h('span', { class: 'missing' }, 'missing') : p == null || !max ? '–' : `${fmt((100 * p) / max)} %`),
          h('td', { class: 'num' }, absentBox(s)));
      })))),
    h('div', { class: 'danger-zone' },
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm(`Delete “${sub.name}” with ${pts.length} points${away ? ` and ${away} absences` : ''}?`)) return;
          await deleteSubmission(sub);
          go(`/course/${course.id}/grades`);
        },
      }, 'Delete submission')));
}

// --- the CSV import ------------------------------------------------------------

function importCard(course, cats) {
  const d = imp.courseId === course.id ? imp.data : null;
  const pick = h('input', {
    type: 'file', accept: '.csv,text/csv,text/plain', class: 'hidden',
    onchange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const parsed = parseCsv(await file.text());
        const names = guessNameColumns(parsed.header);
        imp.courseId = course.id;
        imp.data = { file: file.name, ...parsed, firstCol: names.first, lastCol: names.last, pointsCol: -1, target: '', subName: '', max: '', date: '', missingAbsent: false, allRows: parsed.rows, ignored: [] };
        hooks.render();
      } catch (err) { toast(err.message || 'That file could not be read.'); }
    },
  });
  const card = (...kids) => h('div', { class: 'card import-card' }, h('h2', 'Import points from a CSV file'), ...kids);
  if (!cats.length) return card(h('p', { class: 'muted' }, 'Add a category first (e.g. Exams); the points are imported into one of its submissions.'));
  if (!d) {
    return card(
      h('p', { class: 'hint' }, 'E.g. a grade export from Moodle. You choose the column with the points; the names in the file are matched to the class. Students of the class not in the file can be marked absent, and an empty or “-” value is marked missing; a name in the file that is not in the class stops the import.'),
      pick, h('button', { class: 'primary', onclick: () => pick.click() }, 'Choose a CSV file…'));
  }

  const set = (fields) => { Object.assign(d, fields); hooks.render(); };
  const colSelect = (key, label, filter) => h('label', { class: 'size' }, label, h('select', {
    onchange: (e) => {
      const i = +e.target.value;
      const extra = key === 'pointsCol' && i >= 0 && !d.subName ? { subName: columnTitle(d.header[i]) } : {};
      set({ [key]: i, ...extra });
    },
  },
  h('option', { value: -1, selected: d[key] < 0 }, '— choose —'),
  d.header.map((name, i) => (filter && !filter(i) ? null : h('option', { value: i, selected: d[key] === i }, filter ? `${name} — ${filter(i)} values` : name)))));

  // Columns with numbers that can be points — not student numbers or
  // timestamps (Moodle's "ID-Nummer", "Zuletzt … geladen") — and how many.
  const pointsFilter = (i) => {
    if (i === d.firstCol || i === d.lastCol) return null;
    const vals = d.rows.map((r) => parsePoints(r[i])).filter((v) => v != null && !Number.isNaN(v));
    if (!vals.length) return null;
    if (Math.max(...vals) >= 100000) return null;
    return vals.length;
  };

  const parts = [h('p', { class: 'muted' }, `${d.file} — ${d.rows.length} rows, ${d.header.length} columns.`),
    h('div', { class: 'row-buttons' }, colSelect('lastCol', 'Surname'), colSelect('firstCol', 'First name')),
    h('div', { class: 'row-buttons' }, colSelect('pointsCol', 'Points', pointsFilter))];

  const ready = d.firstCol >= 0 && d.lastCol >= 0 && d.pointsCol >= 0;
  if (ready) {
    const subsAll = cats.flatMap((c) => submissions(c.id).map((s) => ({ s, c })));
    const values = d.rows.map((r) => parsePoints(r[d.pointsCol]));
    const bad = values.filter((v) => Number.isNaN(v)).length;
    const highest = Math.max(0, ...values.filter((v) => v != null && !Number.isNaN(v)));
    parts.push(h('div', { class: 'row-buttons' },
      h('label', { class: 'size' }, 'Into', h('select', { onchange: (e) => set({ target: e.target.value }) },
        h('option', { value: '', selected: !d.target }, 'a new submission…'),
        subsAll.map(({ s, c }) => h('option', { value: s.id, selected: d.target === s.id }, `${c.name}: ${s.name} (max ${fmt(num(s.maxPoints), 2)})`))))));
    if (!d.target) {
      if (!d.categoryId || !cats.some((c) => c.id === d.categoryId)) d.categoryId = cats[0].id;
      parts.push(h('div', { class: 'row-buttons' },
        h('label', { class: 'size' }, 'Category', h('select', { onchange: (e) => set({ categoryId: e.target.value }) }, cats.map((c) => h('option', { value: c.id, selected: c.id === d.categoryId }, c.name)))),
        h('label', { class: 'size' }, 'Name', h('input', { value: d.subName, dataset: { focusKey: 'imp-name' }, oninput: (e) => { d.subName = e.target.value; } })),
        h('label', { class: 'size' }, 'Max points', h('input', { type: 'number', min: 0, step: 'any', value: d.max, placeholder: `≥ ${fmt(highest, 2)}`, class: 'weight-input', dataset: { focusKey: 'imp-max' }, oninput: (e) => { d.max = e.target.value; } })),
        h('label', { class: 'size' }, 'Date', h('input', { type: 'date', value: d.date, oninput: (e) => { d.date = e.target.value; } }))),
      h('p', { class: 'hint' }, `The file has no maximum; its highest value in this column is ${fmt(highest, 2)}.`));
    }
    if (bad) parts.push(h('p', { class: 'error' }, `${bad} ${bad === 1 ? 'value is' : 'values are'} not a number in this column — choose another column.`));

    const people = d.rows.map((r) => ({ firstName: (r[d.firstCol] || '').trim(), lastName: (r[d.lastCol] || '').trim() }));
    const res = matchNames(m.students(course.classId), people);
    const nameOf = (p) => `${p.firstName} ${p.lastName}`.trim() || '(no name)';
    // Lines like "Overall average": left out only once confirmed, and the
    // names they stopped are listed, so it is plain what was skipped.
    const summaries = res.missingInClass.filter(looksLikeSummary);
    const ignoreSummaries = () => {
      const names = summaries.map(nameOf);
      const one = names.length === 1;
      if (!confirm(`Ignore ${one ? 'this line' : `these ${names.length} lines`} of the file? ${one ? 'It is' : 'They are'} not a student and will not be imported:\n\n${names.join('\n')}`)) return;
      const drop = new Set(summaries);
      set({ rows: d.rows.filter((_, i) => !drop.has(people[i])), ignored: [...d.ignored, ...names] });
    };
    if (d.ignored.length) {
      parts.push(h('p', { class: 'muted' }, `Ignored ${d.ignored.length === 1 ? 'line' : 'lines'} of the file: ${d.ignored.join(', ')}. `,
        h('button', { class: 'mini ghost', onclick: () => set({ rows: d.allRows, ignored: [] }) }, 'Undo')));
    }
    // Only students of the class can be absent: a name in the file that is not
    // in the class is a misspelling or the wrong file, and always stops it.
    const notInFile = res.missingInFile;
    const absentOk = !res.missingInClass.length && d.missingAbsent;
    if (res.missingInClass.length || (notInFile.length && !absentOk)) {
      parts.push(h('div', { class: 'import-warning' },
        h('strong', 'Not imported: the names do not match on both sides.'),
        notInFile.length ? h('p', `In the class, but not found in the file (${notInFile.length}): `, notInFile.map(m.fullName).join(', ')) : null,
        res.missingInClass.length ? h('p', `In the file, but not found in the class (${res.missingInClass.length}): `, res.missingInClass.map(nameOf).join(', ')) : null,
        summaries.length ? h('p', `${summaries.length === res.missingInClass.length ? '' : 'Of these, '}${summaries.map((p) => `“${nameOf(p)}”`).join(', ')} ${summaries.length === 1 ? 'looks like a summary line' : 'look like summary lines'}, not ${summaries.length === 1 ? 'a student' : 'students'} — ${summaries.length === 1 ? 'it' : 'they'} can be ignored.`) : null,
        h('p', { class: 'muted small' }, res.missingInClass.length
          ? 'Check the spelling in the class (Students tab) or in the file, or choose the right file for this class.'
          : `Check the spelling in the class (Students tab) or in the file — or, if ${notInFile.length === 1 ? 'this student was' : 'these students were'} not there, mark them absent: absent does not count towards the average.`)),
      h('div', { class: 'row-buttons' },
        summaries.length ? h('button', { class: 'primary', onclick: ignoreSummaries }, summaries.length === 1 ? `Ignore “${nameOf(summaries[0])}”…` : `Ignore these ${summaries.length} lines…`) : null,
        res.missingInClass.length ? null : h('button', { class: 'primary', onclick: () => set({ missingAbsent: true }) },
          `Mark ${notInFile.length === 1 ? m.fullName(notInFile[0]) : `these ${notInFile.length}`} absent and continue`),
        h('button', { onclick: () => { imp.data = null; hooks.render(); } }, 'Cancel')));
    } else if (!bad) {
      const unsure = res.matches.filter((x) => !x.sure).length;
      const graded = res.matches.filter((x) => values[x.row] != null).length;
      const target = d.target && db.get('submissions', d.target);
      const replacing = target ? m.students(course.classId).filter((s) => scoreOf(target.id, s.id) != null || absentFrom(target.id, s.id) || missingFrom(target.id, s.id)).length : 0;
      parts.push(
        res.duplicates.length ? h('p', { class: 'away' }, `The same name appears twice (${res.duplicates.join(', ')}) — check that the points went to the right person.`) : null,
        h('p', notInFile.length ? `${res.matches.length} names matched, ${notInFile.length} not in the file — marked absent.` : `All ${res.matches.length} names matched.`,
          ` ${graded} with points`, res.matches.length - graded
            ? h('span', { class: 'missing' }, `, ${res.matches.length - graded} missing (“-” or empty in the file — marked missing, does not count)`)
            : null, '.',
          unsure ? h('span', { class: 'away' }, ` ${unsure} ${unsure === 1 ? 'match is' : 'matches are'} not exact — please check the highlighted ${unsure === 1 ? 'row' : 'rows'}.`) : null),
        h('div', { class: 'table-wrap' }, h('table', { class: 'summary match-table' },
          h('thead', h('tr', h('th', 'In the class'), h('th', 'In the file'), h('th', { class: 'num' }, 'Points'))),
          h('tbody', [...res.matches, ...notInFile.map((s) => ({ student: s, row: -1, sure: true }))].sort((a, b) => m.byName(a.student, b.student)).map((x) => h('tr', { class: x.sure ? '' : 'unsure' },
            h('td', x.student.lastName, ' ', h('span', { class: 'muted' }, x.student.firstName)),
            x.row < 0 ? h('td', { class: 'muted' }, 'not in the file')
              : h('td', people[x.row].lastName, ' ', h('span', { class: 'muted' }, people[x.row].firstName), x.sure ? '' : h('span', { class: 'chip-mini' }, `${Math.round(x.score * 100)} %`)),
            h('td', { class: 'num' }, x.row < 0 ? h('span', { class: 'away' }, 'absent') : values[x.row] == null ? h('span', { class: 'missing' }, 'missing') : fmt(values[x.row], 2))))))),
        h('div', { class: 'row-buttons' },
          h('button', {
            class: 'primary',
            onclick: async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true;   // a double tap imports once
              const stop = (msg) => { btn.disabled = false; if (msg) toast(msg); };
              let sub = target;
              if (!sub) {
                const mx = num(d.max);
                if (!d.subName.trim()) return stop('Give the submission a name.');
                if (!mx || mx <= 0) return stop('Enter the maximum points.');
                if (mx < highest) return stop(`The maximum is below the highest value in the file (${fmt(highest, 2)}).`);
                const pos = submissions(d.categoryId).reduce((a, s) => Math.max(a, s.position || 0), 0) + 1;
                const id = await db.put('submissions', { courseId: course.id, categoryId: d.categoryId, name: d.subName.trim(), maxPoints: mx, date: d.date || '', position: pos });
                sub = db.get('submissions', id);
              } else if (replacing && !confirm(`“${sub.name}” already has points for ${replacing} students. Replace them with the file’s?`)) return stop();
              const ops = res.matches.map((x) => {
                const id = scoreId(sub.id, x.student.id);
                const v = values[x.row];
                return { tbl: 'scores', id, data: v == null
                  ? { courseId: course.id, submissionId: sub.id, studentId: x.student.id, points: null, missing: true }
                  : { courseId: course.id, submissionId: sub.id, studentId: x.student.id, points: v } };
              });
              for (const s of notInFile) ops.push({ tbl: 'scores', id: scoreId(sub.id, s.id), data: { courseId: course.id, submissionId: sub.id, studentId: s.id, points: null, absent: true } });
              await db.write(ops);
              imp.data = null;
              const lacking = res.matches.length - graded;
              toast(`Imported ${graded} points into “${sub.name}”${lacking ? `, ${lacking} missing` : ''}${notInFile.length ? `, ${notInFile.length} absent` : ''}.`);
              go(`/course/${course.id}/grades/${sub.id}`);
            },
          }, target ? `Import into “${target.name}”` : 'Create the submission and import'),
          h('button', { onclick: () => { imp.data = null; hooks.render(); } }, 'Cancel')));
    }
  } else {
    parts.push(h('p', { class: 'hint' }, 'Choose the surname and first-name columns (recognised automatically where possible) and the column with the points.'),
      h('button', { onclick: () => { imp.data = null; hooks.render(); } }, 'Cancel'));
  }
  return card(...parts);
}

// --- the overview: everything as raw data, one row per student ----------------
//
// No calculation at all, only what was recorded:
//   * every date with a mark, comment or absence, and — when the course has a
//     school year and a timetable, and `planned` is on — every date a lesson
//     was or is planned; per date one column per chosen kind (Plus, Star,
//     Minus: the number of marks), Absent (1), Reasons (the texts given for
//     the minus marks) and Comments — several of one day joined by " | ",
//     in the order they were written. A planned date
//     without anything recorded stays empty, so it can be told apart from a
//     day with zero marks;
//   * every chosen submission with its points as given or imported ("absent" /
//     "missing" where so marked).
// Dropped-out students and their marks are left out, as everywhere else.
const MARK_COLUMNS = [['plus', 'Plus'], ['star', 'Star'], ['minus', 'Minus'], ['absent', 'Absent'], ['reasons', 'Reasons'], ['comments', 'Comments']];
const TEXT_COLUMNS = new Set(['reasons', 'comments']);
export const OVERVIEW_DEFAULTS = { plus: true, star: false, minus: true, absent: false, reasons: true, comments: true, planned: true };

const overviewSubs = (course) => categories(course).filter((c) => c.kind !== 'participation')
  .map((c) => ({ cat: c, subs: submissions(c.id) }));

// opts: {plus, star, minus, absent, planned} as in OVERVIEW_DEFAULTS, and
// `submissions`: the ids to include (all when left out).
export function overviewRows(course, opts = {}) {
  const o = { ...OVERVIEW_DEFAULTS, ...opts };
  const cols = MARK_COLUMNS.filter(([k]) => o[k]);
  const studs = m.students(course.classId);
  const inClass = new Set(studs.map((s) => s.id));
  const recorded = new Set(m.recordedDays(course).map((d) => d.date));
  const dates = cols.length ? [...new Set([...recorded, ...(o.planned ? teachingDays(course) : [])])].sort() : [];
  const count = new Map();   // `${studentId}|${date}|${kind}` -> n
  const texts = new Map();   // `${studentId}|${date}|reasons|comments` -> [text…]
  const addText = (k, t) => { if (!texts.has(k)) texts.set(k, []); texts.get(k).push(t); };
  for (const e of m.entries(course.id)) {   // in the order written
    if (!inClass.has(e.studentId)) continue;
    const text = (e.text || '').trim();
    if (e.kind === 'comment') { if (text) addText(`${e.studentId}|${e.date}|comments`, text); continue; }
    if (!['plus', 'star', 'minus'].includes(e.kind)) continue;
    const k = `${e.studentId}|${e.date}|${e.kind}`;
    count.set(k, (count.get(k) || 0) + 1);
    if (e.kind === 'minus' && text) addText(`${e.studentId}|${e.date}|reasons`, text);
  }
  for (const a of m.absences(course.id)) count.set(`${a.studentId}|${a.date}|absent`, 1);
  const chosen = o.submissions ? new Set(o.submissions) : null;
  const subs = overviewSubs(course).flatMap(({ cat, subs: list }) => list
    .filter((s) => !chosen || chosen.has(s.id)).map((sub) => ({ cat, sub })));
  const decimal = (v) => String(v).replace('.', ',');

  const head = ['Surname', 'First name'];
  for (const d of dates) for (const [, label] of cols) head.push(`${d} ${label}`);
  for (const { cat, sub } of subs) {
    const max = num(sub.maxPoints);
    head.push(`${cat.name}: ${sub.name}${sub.date ? ` (${sub.date})` : ''}${max != null ? ` [max ${decimal(max)}]` : ''}`);
  }
  const out = [head];
  for (const s of studs) {
    const line = [s.lastName, s.firstName];
    for (const d of dates) {
      for (const [k] of cols) {
        const n = count.get(`${s.id}|${d}|${k}`);
        line.push(!recorded.has(d) ? '' : TEXT_COLUMNS.has(k) ? (texts.get(`${s.id}|${d}|${k}`) || []).join(' | ')
          : k === 'absent' ? (n ? 1 : '') : n || 0);
      }
    }
    for (const { sub } of subs) {
      const p = scoreOf(sub.id, s.id);
      line.push(absentFrom(sub.id, s.id) ? 'absent' : missingFrom(sub.id, s.id) ? 'missing' : p == null ? '' : decimal(p));
    }
    out.push(line);
  }
  return out;
}

// A short dialog: which columns, then the download. Lives in #modal, outside
// the redraw cycle, so a sync redrawing the page beneath does not reset it.
function openOverviewDialog(course) {
  const root = document.getElementById('modal');
  const cls = db.get('classes', course.classId);
  const groups = overviewSubs(course).filter((g) => g.subs.length);
  const box = (checked, label, extra = {}) => {
    const input = h('input', { type: 'checkbox', checked, ...extra });
    return [input, h('label', { class: 'switch' }, input, h('span', label))];
  };
  const sym = m.symbols();
  const marks = Object.fromEntries(MARK_COLUMNS.map(([k, label]) => [k, box(OVERVIEW_DEFAULTS[k],
    k === 'reasons' ? `Reasons for ${sym.minus}` : sym[k] ? `${label} ${sym[k]}` : label)]));
  const [plannedInput, plannedLabel] = box(OVERVIEW_DEFAULTS.planned, 'Also planned lesson days without records (empty columns)');
  const subBoxes = groups.flatMap(({ cat, subs }) => subs.map((sub) => ({ sub, cat, b: box(true, `${sub.name}${sub.date ? ` · ${m.formatDate(sub.date, { day: 'numeric', month: 'numeric' })}` : ''}`) })));
  const setAll = (on) => subBoxes.forEach(({ b }) => { b[0].checked = on; });

  const close = () => {
    document.removeEventListener('keydown', onKey, true);
    document.body.classList.remove('sheet-open');
    root.replaceChildren();
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  const run = () => {
    const opts = Object.fromEntries(Object.entries(marks).map(([k, [input]]) => [k, input.checked]));
    opts.planned = plannedInput.checked;
    opts.submissions = subBoxes.filter(({ b }) => b[0].checked).map(({ sub }) => sub.id);
    const name = `${cls?.name || ''}-${course.name}-overview`.replace(/[^\p{L}\p{N}-]+/gu, '_');
    m.download(`${name}.csv`, m.csv(overviewRows(course, opts)));
    close();
  };

  document.body.classList.add('sheet-open');
  document.addEventListener('keydown', onKey, true);
  root.replaceChildren(
    h('div', { class: 'backdrop', onclick: close }),
    h('div', { class: 'sheet export-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Export overview' },
      h('div', { class: 'sheet-head' },
        h('strong', { class: 'grow' }, 'Export overview (CSV)'),
        h('button', { class: 'icon close', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('p', { class: 'muted small' }, 'One row per student, raw data only. Per date: the number of marks of each chosen kind; reasons (for −) and comments as text.'),
      h('h3', 'Marks per date'),
      h('div', { class: 'export-options' }, MARK_COLUMNS.filter(([k]) => !TEXT_COLUMNS.has(k)).map(([k]) => marks[k][1])),
      h('div', { class: 'export-options' }, h('span', { class: 'muted small' }, 'Texts:'), marks.reasons[1], marks.comments[1]),
      h('div', { class: 'export-options' }, plannedLabel),
      h('h3', 'Grades'),
      groups.length
        ? [h('div', { class: 'row-buttons tight' },
          h('button', { class: 'mini', type: 'button', onclick: () => setAll(true) }, 'All'),
          h('button', { class: 'mini', type: 'button', onclick: () => setAll(false) }, 'None')),
        groups.map(({ cat }) => h('div', { class: 'export-group' },
          h('div', { class: 'muted small' }, cat.name),
          h('div', { class: 'export-options' }, subBoxes.filter((x) => x.cat === cat).map(({ b }) => b[1]))))]
        : h('p', { class: 'muted small' }, 'No submissions in this course yet.'),
      h('div', { class: 'row-buttons' },
        h('span', { class: 'grow' }),
        h('button', { type: 'button', onclick: close }, 'Cancel'),
        h('button', { type: 'button', class: 'primary', onclick: run }, 'Export'))));
  root.querySelector('.export-dialog .primary')?.focus();
}

export function overviewButton(course) {
  return h('button', {
    title: 'One row per student: marks per day, absences and grades as given — raw data, no calculations. Opens in LibreOffice or Excel.',
    onclick: () => openOverviewDialog(course),
  }, 'Export overview (CSV)…');
}

// --- in the summary ----------------------------------------------------------

export function gradesTable(course) {
  const { cats, subs, rows } = computeGrades(course);
  const sorted = [...rows].sort((a, b) => m.byName(a.student, b.student));
  const weights = cats.map((c) => num(c.weight) ?? 0);
  const wsum = weights.reduce((a, b) => a + b, 0);
  const share = (i) => (wsum ? `${fmt((100 * weights[i]) / wsum, 0)} %` : '–');
  const pctCell = (v, cls = '') => h('td', { class: `num ${cls}` }, v == null ? '–' : fmt(v, 0));

  const exportCsv = () => {
    const head = ['Surname', 'First name'];
    for (const c of cats) {
      if (c.kind !== 'participation') for (const s of subs.get(c.id)) head.push(`${c.name}: ${s.name} %`);
      head.push(`${c.name} %`);
    }
    head.push('Final %', 'Grade');
    const out = [head];
    for (const r of sorted) {
      const line = [r.student.lastName, r.student.firstName];
      for (const c of cats) {
        if (c.kind !== 'participation') for (const s of subs.get(c.id)) line.push(r.absent.has(s.id) ? 'absent' : r.missing.has(s.id) ? 'missing' : r.perSub[s.id] == null ? '' : r.perSub[s.id].toFixed(1));
        line.push(r.perCat[c.id] == null ? '' : r.perCat[c.id].toFixed(1));
      }
      line.push(r.final == null ? '' : r.final.toFixed(1), r.grade ?? '');
      out.push(line);
    }
    const cls = db.get('classes', course.classId);
    m.download(`${`${cls?.name || ''}-${course.name}`.replace(/[^\p{L}\p{N}-]+/gu, '_')}-grades.csv`, m.csv(out));
  };

  return [
    h('div', { class: 'table-wrap' }, h('table', { class: 'summary grades-table' },
      h('thead',
        h('tr',
          h('th', { rowSpan: 2 }, 'Student'),
          cats.map((c, i) => h('th', { colSpan: (c.kind === 'participation' ? 0 : subs.get(c.id).length) + 1, class: 'cat-head' },
            c.name, h('span', { class: 'muted small' }, ` · ${share(i)}`))),
          h('th', { rowSpan: 2, class: 'num final' }, 'Final %'),
          h('th', { rowSpan: 2, class: 'num final' }, 'Grade')),
        h('tr',
          cats.map((c) => [
            ...(c.kind === 'participation' ? [] : subs.get(c.id).map((s) => h('th', { class: 'num sub-head', title: `${s.name} — max ${s.maxPoints}` }, s.name))),
            h('th', { class: 'num cat-total' }, c.kind === 'participation' ? `% (${m.symbols().plus}${m.symbols().star}/all)` : 'Σ %'),
          ]))),
      h('tbody', sorted.map((r) => h('tr', {},
        h('td', r.student.lastName, ' ', h('span', { class: 'muted' }, r.student.firstName)),
        cats.map((c) => [
          ...(c.kind === 'participation' ? [] : subs.get(c.id).map((s) => (r.absent.has(s.id)
            ? h('td', { class: 'num away', title: 'Absent — does not count' }, 'A')
            : r.missing.has(s.id) ? h('td', { class: 'num missing', title: 'Missing: no points in the imported file — does not count' }, 'M')
              : pctCell(r.perSub[s.id])))),
          pctCell(r.perCat[c.id], 'cat-total'),
        ]),
        h('td', { class: 'num final' }, r.final == null ? '–' : h('strong', fmt(r.final, 1))),
        h('td', { class: `num final grade grade-${r.grade ?? 'none'}` }, r.grade ?? '–')))))),
    h('p', { class: 'hint' }, 'Percentages over the whole course. A = absent, M = missing (no points in the imported file). A submission without points — absent, missing or not graded — does not count; a category without any result is left out of that student’s final grade. Weights, submissions and the scale: the Grades tab of the course.'),
    h('div', { class: 'row-buttons' },
      link(`/course/${course.id}/grades`, 'Categories, weights and points →'),
      h('button', { onclick: exportCsv }, 'Export grades (CSV)'),
      overviewButton(course)),
  ];
}
