// Planning screens (from planer): school years and free days, a course's plan
// board, its setup, and the notes editor.
//
//   #/year/:id              calendar: click a day to make it free; ranges; import/export
//   #/course/:id/plan       the board: teaching hours on one side, the topic pool on the other
//   #/course/:id/setup      name, school year, weekly slots, details, cancellations, extras

import * as db from './db.js';
import * as m from './model.js';
import * as p from './plan.js';
import { h, toast, field, page, go, link, hooks, serverLink, pickJson } from './ui.js';

const st = { selected: null, freeOnly: false, bulkOpen: false };
export function resetPlanUi() { st.selected = null; }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmt = (iso, o = { day: 'numeric', month: 'short', year: 'numeric' }) => m.formatDate(iso, o);
const fmtDay = (iso) => m.formatDate(iso, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const saveJson = (name, doc) => m.download(name, JSON.stringify(doc, null, 2), 'application/json');
const slug = (s) => (s || '').normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'export';

// --- course tabs (shared with the marking and summary screens) ---------------

export function courseTabs(course, active) {
  const tabs = [['', 'Marking'], ['plan', 'Plan'], ['grades', 'Grades'], ['summary', 'Summary'], ['setup', 'Setup']];
  return h('nav', { class: 'tabs' }, tabs.map(([key, label]) =>
    h('a', { href: `#/course/${course.id}${key ? `/${key}` : ''}`, class: key === active ? 'active' : '' }, label)));
}

// --- school years on the home screen ----------------------------------------

export function yearsCard() {
  const list = p.years();
  const y = new Date().getFullYear() - (new Date().getMonth() < 7 ? 1 : 0);
  const name = h('input', { placeholder: `${y}/${String(y + 1).slice(2)}`, required: true });
  const start = h('input', { type: 'date', value: `${y}-09-01`, required: true });
  const end = h('input', { type: 'date', value: `${y + 1}-07-31`, required: true });
  return h('div', { class: 'card' },
    h('h2', 'School years'),
    list.length
      ? h('ul', { class: 'plain-list' }, list.map((yr) => h('li',
        link(`/year/${yr.id}`, yr.name), h('span', { class: 'muted' }, ` ${fmt(yr.start)} – ${fmt(yr.end)} · ${p.holidays(yr.id).length} free ranges`))))
      : h('p', { class: 'muted' }, 'A school year holds the free days; a course in it gets its teaching hours from there.'),
    h('details', { class: 'bulk' },
      h('summary', 'New school year'),
      h('form', {
        class: 'row',
        onsubmit: async (e) => {
          e.preventDefault();
          if (end.value < start.value) return toast('The year ends before it starts.');
          const id = await db.put('years', { name: name.value.trim(), start: start.value, end: end.value });
          go(`/year/${id}`);
        },
      }, field('Name', name), field('From', start), field('To', end), h('button', { class: 'primary' }, 'Create')),
      h('button', { class: 'link', onclick: importYear }, 'Import a calendar (planer JSON)…')));
}

async function importYear() {
  const picked = await pickJson();
  if (!picked) return;
  try {
    const r = await p.importCalendarAsYear(picked.doc);
    toast(`Imported, with ${r.holidays} free ranges.`);
    go(`/year/${r.yearId}`);
  } catch (e) { toast(e.message); }
}

// --- the calendar of a year -------------------------------------------------

function monthGrid(year, y, mo, free, todayISO) {
  const first = new Date(y, mo, 1);
  const lead = (first.getDay() + 6) % 7;
  const n = new Date(y, mo + 1, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: n }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return h('div', { class: 'month' },
    h('h4', `${MONTHS[mo]} ${y}`),
    h('div', { class: 'month-grid' },
      ['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d) => h('span', { class: 'wd' }, d)),
      cells.map((d) => {
        if (!d) return h('span');
        const iso = `${y}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const inside = iso >= year.start && iso <= year.end;
        const off = free.get(iso);
        const wd = (new Date(y, mo, d).getDay() + 6) % 7;
        return h('button', {
          class: `day ${inside ? '' : 'out'} ${wd > 4 ? 'weekend' : ''} ${off ? 'free' : ''} ${iso === todayISO ? 'today' : ''}`,
          disabled: !inside, title: off ? (off.label || 'free day') : inside ? 'Click to mark as free' : '',
          onclick: () => p.toggleFreeDay(year, iso),
        }, String(d));
      })));
}

export function yearScreen(year) {
  const free = p.freeMap(year.id);
  const todayISO = m.today();
  const months = [];
  const [sy, sm] = year.start.split('-').map(Number);
  const [ey, em] = year.end.split('-').map(Number);
  for (let y = sy, mo = sm - 1; y < ey || (y === ey && mo <= em - 1); mo === 11 ? (y++, mo = 0) : mo++) {
    months.push(monthGrid(year, y, mo, free, todayISO));
  }
  const list = p.holidays(year.id);
  const label = h('input', { placeholder: 'Christmas break' });
  const from = h('input', { type: 'date', min: year.start, max: year.end });
  const to = h('input', { type: 'date', min: year.start, max: year.end });
  const courses = db.all('courses', (c) => c.yearId === year.id);

  const edit = (key, type = 'text') => h('input', {
    dataset: { focusKey: `year-${key}` },
    type, value: year[key],
    onchange: (e) => {
      const v = e.target.value.trim();
      if (!v) return;
      const next = { ...year, [key]: v };
      if (next.end < next.start) { toast('The year ends before it starts.'); hooks.render(); return; }
      db.patch('years', year.id, { [key]: v });
    },
  });

  return page(year.name, { href: '/', label: 'Classes' },
    h('p', { class: 'muted' }, `${fmt(year.start)} – ${fmt(year.end)} · ${free.size} days marked free · ${courses.length} ${courses.length === 1 ? 'course' : 'courses'}`),
    h('div', { class: 'toolbar' },
      h('label', { class: 'size' }, 'Name', edit('name')),
      h('label', { class: 'size' }, 'From', edit('start', 'date')),
      h('label', { class: 'size' }, 'To', edit('end', 'date'))),
    h('p', { class: 'hint' }, 'Click a day to make it free (no class) — click again to clear it. Weekends need no marking: a course only meets on its own weekdays.'),
    h('div', { class: 'months' }, months),
    h('div', { class: 'two-col' },
      h('div', { class: 'card' },
        h('h2', 'Free days and holidays'),
        list.length ? h('ul', { class: 'list compact' }, list.map((x) => h('li',
          h('span', { class: 'grow' }, x.start === x.end ? fmt(x.start) : `${fmt(x.start)} → ${fmt(x.end)}`,
            ' ', h('span', { class: 'muted' }, x.label || '')),
          h('button', { class: 'icon', 'aria-label': 'Remove', onclick: () => db.remove('holidays', x.id) }, '✕'))))
          : h('p', { class: 'muted' }, 'None yet.')),
      h('div', { class: 'card' },
        h('h2', 'Add a range'),
        h('form', {
          class: 'row',
          onsubmit: async (e) => {
            e.preventDefault();
            if (!from.value) return toast('Pick a start date.');
            const end = to.value && to.value >= from.value ? to.value : from.value;
            await db.put('holidays', { yearId: year.id, label: label.value.trim(), start: from.value, end });
            label.value = ''; from.value = ''; to.value = '';
          },
        }, field('Label', label), field('From', from), field('To (optional)', to), h('button', { class: 'primary' }, 'Add')))),
    h('div', { class: 'row-buttons' },
      h('button', { onclick: () => saveJson(`planer-calendar-${slug(year.name)}.json`, p.exportCalendar(year)) }, 'Export calendar'),
      h('button', {
        onclick: async () => {
          const picked = await pickJson();
          if (!picked) return;
          if (!confirm(`Import the free days from “${picked.name}” into ${year.name}?`)) return;   // Cancel really cancels
          const replace = confirm('Replace this year’s free days with the file’s?\n\nOK = replace them · Cancel = add to the ones already here');
          try {
            const r = await p.importHolidays(year, picked.doc, replace);
            toast(`${r.added} free ranges imported${r.skipped ? `, ${r.skipped} outside this year skipped` : ''}.`);
          } catch (e) { toast(e.message); }
        },
      }, 'Import free days…')),
    h('div', { class: 'danger-zone' },
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm(`Delete ${year.name} and its free days? Its courses stay, without a school year.`)) return;
          await p.deleteYear(year);
          go('/');
        },
      }, 'Delete school year')));
}

// --- the plan board ---------------------------------------------------------

function topicCard(t, placed, course) {
  const files = p.filesOf(t.id).length;
  const hasNotes = (t.body || '').trim() || files;
  const title = h('input', {
    class: 'tcard-title', value: t.title || '', placeholder: 'Topic…', 'aria-label': 'Topic',
    dataset: { topic: t.id },
    onclick: (e) => e.stopPropagation(),
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
    onchange: (e) => p.patchTopic(t, { title: e.target.value.trim() }),
  });
  return h('div', {
    class: `tcard ${st.selected === t.id ? 'selected' : ''}`,
    draggable: true,
    ondragstart: (e) => { e.dataTransfer.setData('text/topic', t.id); e.dataTransfer.effectAllowed = 'move'; },
    onclick: (e) => { e.stopPropagation(); st.selected = st.selected === t.id ? null : t.id; hooks.render(); },
    title: 'Click to pick it up, then click an hour — or drag it',
  },
  h('button', {
    class: 'grip', title: st.selected === t.id ? 'Put it down again' : 'Pick up — then click an hour',
    'aria-label': st.selected === t.id ? 'Put down' : 'Pick up to place',
    onclick: (e) => { e.stopPropagation(); st.selected = st.selected === t.id ? null : t.id; hooks.render(); },
  }, '⋮⋮'),
  title,
  t.anchorDate && !placed ? h('span', { class: 'orphan', title: 'That date is no longer a teaching day' }, `was ${fmt(t.anchorDate, { day: 'numeric', month: 'short' })}`) : null,
  h('span', { class: 'tcard-acts' },
    hasNotes ? h('span', { class: 'dot-note', title: files ? `${files} file(s)` : 'has notes' }) : null,
    h('button', { class: 'mini', onclick: (e) => { e.stopPropagation(); openNotes(t.id); } }, 'Notes'),
    placed ? h('button', { class: 'mini', title: 'Back to the pool', onclick: (e) => { e.stopPropagation(); p.unplace(t); } }, '↩') : null,
    h('button', {
      class: 'mini danger', title: 'Delete',
      onclick: (e) => {
        e.stopPropagation();
        if ((t.body || '').trim() || files ? confirm(`Delete “${t.title || 'untitled'}” with its notes${files ? ' and files' : ''}?`) : true) p.deleteTopics([t]);
      },
    }, '✕')));
}

function dropTarget(onDrop) {
  return {
    ondragover: (e) => { if (e.dataTransfer.types.includes('text/topic')) { e.preventDefault(); e.currentTarget.classList.add('over'); } },
    ondragleave: (e) => e.currentTarget.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault();
      e.currentTarget.classList.remove('over');
      const t = db.get('topics', e.dataTransfer.getData('text/topic'));
      if (t) onDrop(t);
    },
  };
}

export function planScreen(course) {
  const cls = db.get('classes', course.classId);
  const year = course.yearId ? db.get('years', course.yearId) : null;
  const b = p.board(course);
  const s = b.summary;
  const sel = st.selected && db.get('topics', st.selected);
  if (st.selected && !sel) st.selected = null;
  const placeHere = (x) => { if (sel) { p.place(sel, x.date, x.hour); st.selected = null; } };

  const missing = !year ? 'This course has no school year yet.' : !p.slotsOf(course).length ? 'This course has no weekly slots yet.' : '';

  const hourRow = (x) => h('div', {
    class: `hour ${x.topics.length ? 'filled' : ''} ${sel ? 'placeable' : ''}`,
    onclick: () => placeHere(x),
    ...dropTarget((t) => p.place(t, x.date, x.hour)),
  },
  h('span', { class: 'hour-time' }, x.start ? h('b', x.start) : null, ` h${x.hour}`, x.source === 'extra' ? h('span', { class: 'chip-mini' }, x.note || 'extra') : null),
  h('div', { class: 'hour-topics' },
    x.topics.map((t) => topicCard(t, true, course)),
    sel ? h('span', { class: 'hour-empty' }, 'click to add here') : x.topics.length ? null : h('span', { class: 'hour-empty' }, 'free')),
  sel ? null : h('button', {
    class: 'mini ghost', title: 'A new topic on this hour',
    onclick: async (e) => {
      e.stopPropagation();
      const id = await p.addTopic(course.id, '', { date: x.date, hour: x.hour });
      requestAnimationFrame(() => document.querySelector(`input[data-topic="${id}"]`)?.focus());
    },
  }, '+ topic'));

  const days = b.days.map((d) => {
    const hours = st.freeOnly ? d.hours.filter((x) => !x.topics.length) : d.hours;
    if (!hours.length) return null;
    const free = d.hours.filter((x) => !x.topics.length).length;
    return h('div', { class: 'day-block', dataset: { date: d.date } },
      h('div', { class: 'day-head' },
        h('span', { class: 'grow' }, fmtDay(d.date)),
        h('span', { class: `chip-mini ${free ? '' : 'good'}` }, free ? `${free} h free` : 'planned'),
        serverLink(`/plan/${course.id}/day/${d.date}`, 'Page', { class: 'mini ghost' }),
        serverLink(`/plan/${course.id}/day/${d.date}/pdf`, 'PDF', { class: 'mini ghost' })),
      hours.map(hourRow));
  }).filter(Boolean);

  const bulk = h('textarea', { rows: 6, placeholder: 'One topic per line, e.g.\n\nDivisibility rules\nPrime factorisation\nFractions: expanding\n\nA bulleted or numbered list works too.' });
  const bulkCount = h('span', { class: 'muted' }, '0 topics');
  const addBulk = async () => {
    const titles = p.topicLines(bulk.value);
    if (!titles.length) return toast('Put one topic per line.');
    await p.addTopics(course.id, titles);
    st.bulkOpen = false;
    toast(`${titles.length} topics added to the pool.`);
  };
  bulk.addEventListener('input', () => { const n = p.topicLines(bulk.value).length; bulkCount.textContent = `${n} ${n === 1 ? 'topic' : 'topics'}`; });
  bulk.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addBulk(); } });

  const syllabusMode = h('select', { 'aria-label': 'Syllabus layout' },
    h('option', { value: 'detailed' }, 'table + notes'), h('option', { value: 'compact' }, 'compact'), h('option', { value: 'planning' }, 'incl. free hours'));
  const scriptMode = h('select', { 'aria-label': 'Script format' },
    h('option', { value: 'pdf' }, 'PDF'), h('option', { value: 'zip' }, 'LaTeX + figures (.zip)'), h('option', { value: 'tex' }, 'LaTeX source (.tex)'));
  const open = (href) => {
    if (db.status.state === 'offline') return toast('This needs your computer — it is not reachable right now.');
    window.open(href, '_blank', 'noopener');
  };

  const pool = h('aside', { class: 'pool', onclick: () => { if (sel && sel.anchorDate) { p.unplace(sel); st.selected = null; } }, ...dropTarget((t) => p.unplace(t)) },
    h('h3', 'Topic pool ', h('span', { class: 'chip-mini' }, String(b.pool.length))),
    h('div', { class: 'row-buttons tight' },
      h('button', { class: 'primary mini', onclick: async (e) => { e.stopPropagation(); const id = await p.addTopic(course.id); requestAnimationFrame(() => document.querySelector(`input[data-topic="${id}"]`)?.focus()); } }, '+ Add topic'),
      h('button', { class: 'mini', onclick: (e) => { e.stopPropagation(); st.bulkOpen = !st.bulkOpen; hooks.render(); } }, st.bulkOpen ? 'Close list' : 'Add a list…'),
      h('button', {
        class: 'mini ghost',
        onclick: async (e) => {
          e.stopPropagation();
          const picked = await pickJson();
          if (!picked) return;
          try {
            const r = await p.importTopics(course, picked.doc);
            toast(`${r.imported} topics added to the pool${r.kind === 'course' ? ' (from a course export, without its dates)' : ''}.`);
          } catch (err) { toast(err.message); }
        },
      }, 'Import topics…'),
      h('button', { class: 'mini ghost', onclick: (e) => { e.stopPropagation(); saveJson(`planer-topics-${slug(course.name)}.json`, p.exportTopics(course)); } }, 'Export topics')),
    st.bulkOpen ? h('div', { class: 'bulk-box', onclick: (e) => e.stopPropagation() }, bulk,
      h('div', { class: 'row-buttons tight' }, bulkCount, h('span', { class: 'grow' }), h('button', { class: 'primary mini', onclick: addBulk }, 'Add to pool'))) : null,
    b.pool.length ? b.pool.map((t) => topicCard(t, false, course))
      : h('p', { class: 'muted small' }, sel ? 'Click here to take it off the calendar.' : 'Empty — every topic is on the calendar. Drop one here to take it off again.'));

  return page(course.name, { href: `/class/${cls.id}/courses`, label: cls.name },
    courseTabs(course, 'plan'),
    missing ? h('div', { class: 'card notice' }, h('p', missing, ' ', link(`/course/${course.id}/setup`, 'Set it up →'))) : null,
    h('div', { class: 'stats' },
      [[s.unitsTotal, 'hours available'], [s.teachingDays, 'teaching days'], [s.topics, 'topics'], [s.unitsPlanned, 'hours planned'],
        [s.unplaced, 'in pool'], [s.unitsFree, 'hours free']].map(([n, l], i) => h('div', { class: `stat ${i === 4 && n ? 'alert' : ''}` }, h('b', String(n)), h('span', l)))),
    h('div', { class: 'row-buttons' },
      h('span', { class: 'muted' }, 'Syllabus'), syllabusMode,
      h('button', { onclick: () => open(`/plan/${course.id}/syllabus?mode=${syllabusMode.value}`) }, 'Preview'),
      h('button', { onclick: () => open(`/plan/${course.id}/syllabus.pdf?mode=${syllabusMode.value}`) }, 'PDF'),
      h('span', { class: 'muted' }, ' Script'), scriptMode,
      h('button', { class: 'primary', onclick: () => open(`/plan/${course.id}/script.${scriptMode.value}`) }, 'Script')),
    sel ? h('div', { class: 'hintbar' },
      h('span', { class: 'grow' }, 'Placing ', h('b', sel.title || 'untitled topic'), ' — click an hour.'),
      sel.anchorDate ? h('button', { class: 'mini', onclick: () => { p.unplace(sel); st.selected = null; } }, 'Back to pool') : null,
      h('button', { class: 'mini', onclick: () => { st.selected = null; hooks.render(); } }, 'Cancel (Esc)')) : null,
    h('div', { class: 'board' },
      h('div', { class: 'board-hours' },
        h('div', { class: 'row-buttons tight' },
          h('span', { class: 'muted grow' }, 'Hours from the calendar'),
          b.days.length ? h('button', {
            class: 'mini',
            onclick: () => {
              const t = m.today();
              const target = [...document.querySelectorAll('.day-block')].find((el) => el.dataset.date >= t);
              if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
              else toast('No teaching days from today on.');
            },
          }, 'Jump to today') : null,
          h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked: st.freeOnly, onchange: (e) => { st.freeOnly = e.target.checked; hooks.render(); } }), h('span', 'only free hours'))),
        days.length ? days : h('p', { class: 'empty' }, st.freeOnly && b.units.length ? 'Every hour has a topic.' : 'No teaching hours yet.')),
      pool),
    h('div', { class: 'row-buttons' },
      h('button', {
        class: 'ghost danger',
        onclick: () => {
          const empty = p.topicsOf(course.id).filter((t) => !(t.title || '').trim() && !(t.body || '').trim() && !p.filesOf(t.id).length);
          if (!empty.length) return toast('No untitled topics.');
          p.deleteTopics(empty);
          toast(`${empty.length} untitled topics removed.`);
        },
      }, 'Remove untitled topics')));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && st.selected && !document.getElementById('modal').children.length) { st.selected = null; hooks.render(); }
});

// --- the notes editor -------------------------------------------------------
//
// Lives in #modal, outside the redraw cycle: the board may redraw beneath it
// (every save is a local write) without touching what is being typed.

let katex = null;
function loadKatex() {
  if (!katex) {
    katex = new Promise((resolve) => {
      const css = h('link', { rel: 'stylesheet', href: '/vendor/katex/katex.min.css' });
      const js = h('script', { src: '/vendor/katex/katex.min.js' });
      js.onload = () => {
        const auto = h('script', { src: '/vendor/katex/auto-render.min.js' });
        auto.onload = () => resolve(window.renderMathInElement);
        auto.onerror = () => resolve(null);
        document.head.append(auto);
      };
      js.onerror = () => resolve(null);
      document.head.append(css, js);
    });
  }
  return katex;
}

async function typeset(el) {
  const render = await loadKatex();
  try {
    render?.(el, { delimiters: [{ left: '\\[', right: '\\]', display: true }, { left: '\\(', right: '\\)', display: false }], throwOnError: false });
  } catch { /* leave the TeX as text */ }
}

function insertAtCursor(area, text) {
  const start = area.selectionStart ?? area.value.length;
  const end = area.selectionEnd ?? start;
  area.value = area.value.slice(0, start) + text + area.value.slice(end);
  area.setSelectionRange(start + text.length, start + text.length);
  area.focus();
  area.dispatchEvent(new Event('input', { bubbles: true }));
}

export function openNotes(topicId) {
  const root = document.getElementById('modal');
  const t0 = db.get('topics', topicId);
  if (!t0) return;
  const title = h('input', { value: t0.title || '', placeholder: 'What this hour covers…', class: 'notes-title' });
  const area = h('textarea', { value: t0.body || '', spellcheck: false, placeholder: 'Details, derivations, homework…\n\nMarkdown with LaTeX: $…$ inline, $$…$$ display.' });
  const preview = h('div', { class: 'notes-preview' });
  const filesBox = h('div', { class: 'files' });
  const status = h('span', { class: 'muted small' });
  let saveTimer = null;
  let previewTimer = null;
  let lastRendered = null;

  const save = () => {
    clearTimeout(saveTimer);
    const cur = db.get('topics', topicId);
    if (!cur) return;
    if (cur.title === title.value && cur.body === area.value) return;
    p.patchTopic(cur, { title: title.value, body: area.value });
    status.textContent = 'saved';
    setTimeout(() => { if (status.textContent === 'saved') status.textContent = ''; }, 1200);
  };
  const later = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 500); };

  const renderPreview = async () => {
    const text = area.value;
    if (text === lastRendered) return;
    try {
      const r = await db.authFetch('/api/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const { html } = await r.json();
      lastRendered = text;
      preview.innerHTML = html || '<p class="muted">Nothing yet.</p>';   // rendered by the server from your own notes
      typeset(preview);
    } catch {
      lastRendered = null;
      preview.replaceChildren(h('p', { class: 'muted small' }, 'The preview is rendered by your computer, which is not reachable right now. Your text is saved here and syncs later.'),
        h('pre', { class: 'raw' }, text));
    }
  };

  const drawFiles = () => {
    const list = p.filesOf(topicId);
    filesBox.replaceChildren(...(list.length ? list.map((f) => h('div', { class: 'file' },
      f.type.startsWith('image/') ? h('img', { src: `/files/${f.path}`, alt: '' }) : h('span', { class: 'file-ext' }, f.filename.split('.').pop()),
      h('span', { class: 'file-name', title: f.filename }, f.filename),
      h('button', { class: 'mini', onclick: () => insertAtCursor(area, `\n\n![${f.filename}](/files/${f.path})\n\n`) }, 'Insert'),
      h('button', {
        class: 'mini danger',
        onclick: () => { if (confirm(`Delete ${f.filename}? Notes that show it will have a gap.`)) db.remove('files', f.id); },
      }, '✕'))) : [h('p', { class: 'muted small' }, 'No files yet. Add one, or paste or drop an image into the text.')]));
  };

  const upload = async (file) => {
    if (!file) return;
    status.textContent = `uploading ${file.name}…`;
    try {
      save();
      await db.sync();   // the server has to know the topic before it can hold its files
      const form = new FormData();
      form.append('topicId', topicId);
      form.append('file', file);
      const f = await (await db.authFetch('/api/files', { method: 'POST', body: form })).json();
      await db.sync();   // bring the new file's record here
      insertAtCursor(area, `\n\n![${f.filename}](${f.url})\n\n`);
      status.textContent = 'attached';
    } catch (e) {
      status.textContent = '';
      toast(e.status ? e.message : 'Files are kept on your computer, which is not reachable right now.');
    }
  };

  const unsubscribe = db.onChange(() => {
    drawFiles();
    const cur = db.get('topics', topicId);
    if (!cur) close();
  });

  const close = () => {
    save();
    clearTimeout(previewTimer);
    unsubscribe();
    root.replaceChildren();
    document.body.classList.remove('sheet-open');
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };

  title.addEventListener('input', later);
  area.addEventListener('input', () => {
    later();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 300);
  });
  area.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])][0];
    if (file) { e.preventDefault(); upload(file); }
  });
  area.addEventListener('dragover', (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); area.classList.add('over'); } });
  area.addEventListener('dragleave', () => area.classList.remove('over'));
  area.addEventListener('drop', (e) => {
    area.classList.remove('over');
    const file = [...(e.dataTransfer?.files || [])][0];
    if (file) { e.preventDefault(); upload(file); }
  });
  const picker = h('input', {
    type: 'file', class: 'hidden', accept: 'image/png,image/jpeg,image/gif,image/webp,application/pdf',
    onchange: (e) => upload(e.target.files[0]),
  });

  document.body.classList.add('sheet-open');
  document.addEventListener('keydown', onKey, true);
  root.replaceChildren(
    h('div', { class: 'backdrop', onclick: close }),
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Topic notes' },
      h('div', { class: 'modal-head' }, title, h('button', { class: 'icon close', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'notes-grid' },
        h('label', { class: 'notes-col' }, h('span', { class: 'muted small' }, 'Notes — markdown with LaTeX ($…$ inline, $$…$$ display)'), area),
        h('div', { class: 'notes-col' }, h('span', { class: 'muted small' }, 'Result'), preview)),
      h('div', { class: 'row-buttons tight' },
        h('strong', 'Files'), h('button', { class: 'mini', onclick: () => picker.click() }, 'Add image or PDF…'), picker,
        h('span', { class: 'grow' }), status),
      filesBox,
      h('div', { class: 'row-buttons' }, h('button', { class: 'primary', onclick: close }, 'Done'))));
  drawFiles();
  renderPreview();
  title.focus();
}

// --- course setup -----------------------------------------------------------

export function setupScreen(course) {
  const cls = db.get('classes', course.classId);
  const slots = p.slotsOf(course);
  const set = (fields) => db.patch('courses', course.id, fields);
  const text = (key, props = {}) => h('input', { value: course[key] || '', dataset: { focusKey: `setup-${key}` }, ...props, onchange: (e) => set({ [key]: e.target.value.trim() }) });
  // Always from the record as it is now, not as it was when the page was
  // drawn — two quick edits in a row must not undo each other.
  const current = () => p.slotsOf(db.get('courses', course.id) || course);
  const setSlot = (i, fields) => set({ slots: current().map((x, j) => (j === i ? { ...x, ...fields } : x)) });

  const slotRow = (s, i) => h('div', { class: 'slot-row' },
    h('select', { 'aria-label': 'Weekday', onchange: (e) => setSlot(i, { weekday: +e.target.value }) },
      p.WEEKDAYS.map((w, k) => h('option', { value: k, selected: Number(s.weekday) === k }, w))),
    h('input', { type: 'number', min: 1, max: 12, value: s.hours || 1, 'aria-label': 'Hours', dataset: { focusKey: `slot-${i}-hours` }, onchange: (e) => setSlot(i, { hours: Math.max(1, Math.min(12, +e.target.value || 1)) }) }),
    h('span', { class: 'muted small' }, 'h, from'),
    h('input', { type: 'time', value: s.start || '', 'aria-label': 'Starts at', dataset: { focusKey: `slot-${i}-start` }, onchange: (e) => setSlot(i, { start: e.target.value }) }),
    h('button', { class: 'icon', 'aria-label': 'Remove', onclick: () => set({ slots: current().filter((_, j) => j !== i) }) }, '✕'));

  const cDate = h('input', { type: 'date' });
  const cReason = h('input', { placeholder: 'Reason (optional)' });
  const xDate = h('input', { type: 'date' });
  const xHours = h('input', { type: 'number', min: 1, max: 12, value: 1 });
  const xTime = h('input', { type: 'time' });
  const xReason = h('input', { placeholder: 'e.g. make-up class' });
  const b = p.board(course).summary;

  return page(course.name, { href: `/class/${cls.id}/courses`, label: cls.name },
    courseTabs(course, 'setup'),
    h('div', { class: 'card' },
      h('h2', 'Course'),
      h('div', { class: 'row' },
        field('Name', text('name', { required: true })),
        field('School year', h('select', { onchange: (e) => set({ yearId: e.target.value || null }) },
          h('option', { value: '' }, '— none —'),
          p.years().map((y) => h('option', { value: y.id, selected: course.yearId === y.id }, y.name))))),
      !p.years().length ? h('p', { class: 'hint' }, 'No school years yet — create one on the start page.') : null,
      h('div', { class: 'row' },
        field('Teacher (optional)', text('teacher')),
        field('Room (optional)', text('room')),
        field('Colour', h('input', { type: 'color', value: course.color || '#2a4b9b', onchange: (e) => set({ color: e.target.value }) })))),
    h('div', { class: 'card' },
      h('h2', 'Weekly slots'),
      h('p', { class: 'hint' }, 'One row per weekday: the number of consecutive teaching hours that day. Tue 2 h + Thu 1 h gives 3 hours a week.'),
      slots.map(slotRow),
      h('button', { onclick: () => set({ slots: [...current(), { weekday: 0, hours: 1, start: '' }] }) }, '+ Add a day'),
      h('p', { class: 'muted' }, `${b.unitsTotal} teaching hours on ${b.teachingDays} days in this school year.`)),
    h('div', { class: 'card' },
      h('h2', 'Description'),
      h('p', { class: 'hint' }, 'Markdown with LaTeX; appears at the top of the syllabus and the script.'),
      h('textarea', { rows: 5, value: course.notes || '', dataset: { focusKey: 'setup-notes' }, onchange: (e) => set({ notes: e.target.value }) })),
    h('div', { class: 'two-col' },
      h('div', { class: 'card' },
        h('h2', 'Cancelled dates'),
        h('p', { class: 'hint' }, 'This course only: an excursion, illness. Topics on that day go back to the pool.'),
        h('ul', { class: 'list compact' }, p.cancellationsOf(course.id).map((x) => h('li',
          h('span', { class: 'grow' }, fmtDay(x.date), ' ', h('span', { class: 'muted' }, x.reason || '')),
          h('button', { class: 'icon', 'aria-label': 'Remove', onclick: () => db.remove('cancellations', x.id) }, '✕')))),
        h('form', {
          class: 'inline-form',
          onsubmit: async (e) => {
            e.preventDefault();
            if (!cDate.value) return toast('Pick a date.');
            if (p.cancellationsOf(course.id).some((x) => x.date === cDate.value)) return toast('That date is already cancelled.');
            await db.put('cancellations', { courseId: course.id, date: cDate.value, reason: cReason.value.trim() });
          },
        }, cDate, cReason, h('button', 'Cancel day'))),
      h('div', { class: 'card' },
        h('h2', 'Extra sessions'),
        h('p', { class: 'hint' }, 'An extra date outside the weekly rhythm; it sorts into the plan by date.'),
        h('ul', { class: 'list compact' }, p.extrasOf(course.id).map((x) => h('li',
          h('span', { class: 'grow' }, fmtDay(x.date), ` · ${x.hours} h${x.start ? ` from ${x.start}` : ''} `, h('span', { class: 'muted' }, x.reason || '')),
          h('button', { class: 'icon', 'aria-label': 'Remove', onclick: () => db.remove('extras', x.id) }, '✕')))),
        h('form', {
          class: 'inline-form',
          onsubmit: async (e) => {
            e.preventDefault();
            if (!xDate.value) return toast('Pick a date.');
            await db.put('extras', { courseId: course.id, date: xDate.value, hours: Math.max(1, Math.min(12, +xHours.value || 1)), start: xTime.value, reason: xReason.value.trim() });
          },
        }, xDate, xHours, xTime, xReason, h('button', 'Add')))),
    h('div', { class: 'row-buttons' },
      h('button', { onclick: () => saveJson(`planer-course-${slug(course.name)}-${slug(cls.name)}.json`, p.exportCourse(course)) }, 'Export course (JSON)'),
      h('button', {
        onclick: async () => {
          const id = await p.duplicateCourse(course);
          toast('Plan copied — marks stay with the original.');
          go(`/course/${id}/setup`);
        },
      }, 'Duplicate plan')),
    h('div', { class: 'danger-zone' },
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm(`Delete ${course.name} with its plan, marks and absences?`)) return;
          await m.deleteCourse(course.id);
          go(`/class/${cls.id}/courses`);
        },
      }, 'Delete course')));
}

// A course export (from planer or classbook) as a new course of this class.
export async function importCourseInto(cls) {
  const picked = await pickJson();
  if (!picked) return;
  const year = p.currentYear();
  try {
    const r = await p.importCourse(picked.doc, cls.id, year?.id || null, true);
    toast(`Imported ${r.topics} topics${year ? ` into ${year.name}: ${r.placed} on the calendar, ${r.pooled} in the pool` : ' (no school year yet — all in the pool)'}.`);
    go(`/course/${r.courseId}/plan`);
  } catch (e) { toast(e.message); }
}

// --- on the marking screen --------------------------------------------------

// ‹ › step through the days the course meets, when it has a plan.
export function stepDay(course, date, dir) {
  const days = p.teachingDays(course);
  if (!days.length) return m.shiftDate(date, dir);
  const next = dir > 0 ? days.find((d) => d > date) : [...days].reverse().find((d) => d < date);
  return next || m.shiftDate(date, dir);
}

export function planLine(course, date) {
  const days = p.teachingDays(course);
  if (!days.length) return null;
  const topics = p.topicsOn(course, date);
  const meets = days.includes(date);
  return h('div', { class: 'plan-line' },
    !meets ? h('span', { class: 'chip-mini' }, 'not a teaching day') : null,
    meets ? h('span', { class: 'muted' }, 'Planned: ') : null,
    meets ? (topics.length ? topics.map((t, i) => [i ? ' · ' : '', h('strong', t.title || 'untitled')]) : h('span', { class: 'muted' }, 'nothing yet')) : null,
    meets ? serverLink(`/plan/${course.id}/day/${date}`, 'Day sheet', { class: 'mini ghost' }) : null,
    link(`/course/${course.id}/plan`, 'Plan →'));
}
