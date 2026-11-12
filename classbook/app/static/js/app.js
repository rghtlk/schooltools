// Screens and routing. Every screen is drawn from the local copy (db.js), so
// nothing here waits on the network.
//
//   #/                          classes, with their courses
//   #/class/:id/:tab            courses | seating | students
//   #/course/:id?d=YYYY-MM-DD   marking: +, −, comments, absent
//   #/course/:id/summary        totals and day-by-day, CSV export
//   #/course/:id/plan|setup     planning (planviews.js)
//   #/year/:id                  a school year's calendar and free days (planviews.js)
//   #/settings                  sync, phone setup, display, backup

import * as db from './db.js';
import * as m from './model.js';
import * as p from './plan.js';
import * as pv from './planviews.js';
import * as gr from './grades.js';
import { h, prefs, display, face, toggle, toast, field, page, syncPill, go, link, hooks, pastedImage, readClipboardImage, pickJson } from './ui.js';

const main = document.getElementById('main');
const sheetRoot = document.getElementById('sheet');
const ui = { sheet: null, selected: null, sort: prefs.get('sort', { key: 'name', dir: 1 }), expanded: new Set() };
let isLocal = false;   // a browser on the computer running Classbook

// --- routing -----------------------------------------------------------------

function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean);
  return { parts, q: new URLSearchParams(query) };
}


function render() {
  const { parts, q } = route();
  let screen;
  try {
    if (parts[0] === 'class' && db.get('classes', parts[1])) screen = classScreen(db.get('classes', parts[1]), parts[2] || 'courses');
    else if (parts[0] === 'course' && db.get('courses', parts[1]) && parts[2] === 'summary') screen = summaryScreen(db.get('courses', parts[1]), q);
    else if (parts[0] === 'course' && db.get('courses', parts[1]) && parts[2] === 'plan') screen = pv.planScreen(db.get('courses', parts[1]));
    else if (parts[0] === 'course' && db.get('courses', parts[1]) && parts[2] === 'setup') screen = pv.setupScreen(db.get('courses', parts[1]));
    else if (parts[0] === 'course' && db.get('courses', parts[1]) && parts[2] === 'grades' && parts[3] && db.get('submissions', parts[3])) screen = gr.submissionScreen(db.get('courses', parts[1]), db.get('submissions', parts[3]));
    else if (parts[0] === 'course' && db.get('courses', parts[1]) && parts[2] === 'grades') screen = gr.gradesScreen(db.get('courses', parts[1]));
    else if (parts[0] === 'year' && db.get('years', parts[1])) screen = pv.yearScreen(db.get('years', parts[1]));
    else if (parts[0] === 'course' && db.get('courses', parts[1])) screen = courseScreen(db.get('courses', parts[1]), q.get('d') || m.today());
    else if (parts[0] === 'settings') screen = settingsScreen();
    else if (parts[0] === 'pair') screen = pairScreen();
    else screen = homeScreen();
  } catch (e) {
    console.error(e);
    screen = page('Something went wrong', null, h('p', { class: 'error' }, String(e)));
  }
  // A field marked data-focus-key keeps the cursor (and what is typed in it)
  // across the redraw — e.g. Tab from one student's points to the next while
  // the first is being saved.
  const a = document.activeElement;
  const key = a && main.contains(a) ? a.dataset?.focusKey : null;
  const kept = key ? { value: a.value, start: a.selectionStart, end: a.selectionEnd } : null;
  main.replaceChildren(screen);
  if (key) {
    const el = main.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
    if (el) {
      if ('value' in el && el.value !== kept.value) el.value = kept.value;
      el.focus();
      try { if (kept.start != null) el.setSelectionRange(kept.start, kept.end); } catch { /* not a text field */ }
    }
  }
  renderSheet();
  window.__classbookStarted = true;   // see the fallback in index.html
}

// A remote change should not wipe out what you are typing: wait until the
// field loses focus.
let deferred = false;
function refresh() {
  const a = document.activeElement;
  if (a && (main.contains(a) || sheetRoot.contains(a)) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && a.type !== 'checkbox') {
    deferred = true;
    return;
  }
  render();
}
document.addEventListener('focusout', () => { if (deferred) { deferred = false; setTimeout(refresh, 0); } });

// --- chrome ------------------------------------------------------------------

function updateStatus() {
  const pill = main.querySelector('.pill');
  if (pill) pill.replaceWith(syncPill());
  const card = main.querySelector('.sync-card');
  if (card) card.replaceWith(syncCard());
}

// Settings' sync card: redrawn on its own at every status change (not the
// whole page, which would re-ask the server for the setup details each time).
function syncCard() {
  const s = db.status;
  return h('div', { class: 'card sync-card' },
    h('h2', 'Sync'),
    h('p', `Status: ${s.state === 'offline' && s.message ? s.message
      : `${{ idle: 'not synced yet', syncing: 'syncing', ok: 'up to date', offline: 'computer not reachable', unpaired: 'not paired', error: 'error' }[s.state]}${s.message ? ` — ${s.message}` : ''}`}`),
    h('p', { class: 'muted' }, s.lastSync ? `Last sync: ${new Date(s.lastSync).toLocaleString()}` : 'Never synced.', s.pending ? ` ${s.pending} changes waiting to be sent.` : ''),
    s.state === 'offline' && !isLocal ? h('p', { class: 'hint-box' },
      isAndroid
        ? 'Your computer is on and on the same Wi-Fi? Then check first: Settings → Security & privacy → Encryption & credentials → Trusted credentials → User → “classbook local CA” listed. More under “If this device stops syncing” below.'
        : 'Your computer is on and on the same Wi-Fi? Then check first: iPhone Settings → General → About → Certificate Trust Settings → “classbook local CA” switched on. More under “If this device stops syncing” below.') : null,
    h('div', { class: 'row-buttons' },
      h('button', { class: 'primary', onclick: () => db.sync() }, 'Sync now'),
      !isLocal && h('a', { class: 'button', href: '#/pair' }, 'Change pairing code')));
}

// --- home --------------------------------------------------------------------

function homeScreen() {
  const list = m.classes();
  const name = h('input', { placeholder: 'e.g. 3A', required: true });
  const rows = h('input', { type: 'number', min: 1, max: 20, value: 5 });
  const cols = h('input', { type: 'number', min: 1, max: 20, value: 6 });
  const form = h('form', {
    class: 'card form',
    onsubmit: async (e) => {
      e.preventDefault();
      if (e.submitter) e.submitter.disabled = true;   // a double tap creates one class, not two
      const id = await db.put('classes', { name: name.value.trim(), rows: +rows.value || 5, cols: +cols.value || 6 });
      go(`/class/${id}/students`);
    },
  }, h('h2', 'New class'), h('div', { class: 'row' }, field('Name', name), field('Rows', rows), field('Seats per row', cols)),
  h('button', { class: 'primary' }, 'Create class'));

  return page('Classes', null,
    list.length ? h('div', { class: 'cards' }, list.map((c) => {
      const cs = m.courses(c.id);
      return h('div', { class: 'card class-card' },
        h('a', { class: 'title', href: `#/class/${c.id}/courses` }, c.name),
        h('div', { class: 'muted' }, `${m.students(c.id).length} students · ${cs.length} ${cs.length === 1 ? 'course' : 'courses'}`),
        cs.length ? h('div', { class: 'chips' }, cs.map((co) => h('a', { class: 'chip', href: `#/course/${co.id}` }, co.name))) : null);
    })) : h('p', { class: 'empty' }, db.status.state === 'unpaired' ? 'Not paired with your computer yet.' : 'No classes yet. Create the first one below.'),
    db.status.state === 'unpaired' && !isLocal ? h('p', link('/pair', 'Pair this device with your computer →')) : null,
    form,
    pv.yearsCard());
}

// --- class -------------------------------------------------------------------

function classScreen(cls, tab) {
  const tabs = [['courses', 'Courses'], ['seating', 'Seating plan'], ['students', 'Students']];
  const body = { courses: coursesTab, seating: seatingTab, students: studentsTab }[tab] || coursesTab;
  return page(cls.name, { href: '/', label: 'Classes' },
    h('nav', { class: 'tabs' }, tabs.map(([key, label]) =>
      h('a', { href: `#/class/${cls.id}/${key}`, class: key === tab ? 'active' : '' }, label))),
    body(cls),
    h('div', { class: 'danger-zone' },
      h('button', {
        onclick: () => {
          const name = prompt('Rename class', cls.name);
          if (name && name.trim()) db.patch('classes', cls.id, { name: name.trim() });
        },
      }, 'Rename class'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm(`Delete ${cls.name} with all its students, courses, marks and absences? This cannot be undone.`)) return;
          await m.deleteClass(cls.id);
          go('/');
        },
      }, 'Delete class')));
}

function coursesTab(cls) {
  const list = m.courses(cls.id);
  const name = h('input', { placeholder: 'e.g. Mathematics', required: true });
  return h('section', {},
    list.length ? h('ul', { class: 'list' }, list.map((c) => h('li', {},
      h('a', { class: 'grow', href: `#/course/${c.id}` }, c.name,
        h('span', { class: 'muted small' }, ` ${p.slotsOf(c).map((x) => `${p.WD_SHORT[x.weekday]} ${x.hours}h`).join(', ') || ''}`)),
      h('a', { class: 'button', href: `#/course/${c.id}/plan` }, 'Plan'),
      h('a', { class: 'button', href: `#/course/${c.id}/summary` }, 'Summary'),
      h('button', {
        onclick: () => {
          const n = prompt('Rename course', c.name);
          if (n && n.trim()) db.patch('courses', c.id, { name: n.trim() });
        },
      }, 'Rename'),
      h('button', {
        class: 'danger',
        onclick: () => confirm(`Delete ${c.name} with all its marks and absences?`) && m.deleteCourse(c.id),
      }, 'Delete')))) : h('p', { class: 'empty' }, 'No courses yet.'),
    h('form', {
      class: 'inline-form',
      onsubmit: async (e) => {
        e.preventDefault();
        if (e.submitter) e.submitter.disabled = true;
        const id = await db.put('courses', { classId: cls.id, name: name.value.trim(), yearId: p.currentYear()?.id || null, slots: [], teacher: '', room: '', color: '#2a4b9b', notes: '' });
        go(`/course/${id}/setup`);
      },
    }, name, h('button', { class: 'primary' }, 'Add course')),
    h('button', { class: 'link', onclick: () => pv.importCourseInto(cls) }, 'Import a course (planer JSON)…'));
}

// The plan as seen from the teacher's desk (board at the bottom, everything
// turned round — the default), or from the back of the room (board at the top).
function seatOrder(cls) {
  const rows = [...Array(cls.rows).keys()];
  const cols = [...Array(cls.cols).keys()];
  return display().boardBottom ? { rows: rows.reverse(), cols: cols.reverse() } : { rows, cols };
}

// compact: leave out empty rows at the back of the room (the marking view,
// where they would only push the class off a phone screen).
function seatGrid(cls, grid, renderSeat, { compact = false } = {}) {
  let { rows, cols } = seatOrder(cls);
  if (compact) {
    const used = [...grid.keys()].map((k) => +k.split(',')[0]);
    const last = used.length ? Math.max(...used) : -1;
    rows = rows.filter((r) => r <= last);
  }
  const front = h('div', { class: 'front' }, 'Board');
  return h('div', { class: 'plan' },
    !display().boardBottom && front,
    h('div', { class: 'grid', style: { gridTemplateColumns: `repeat(${cls.cols}, minmax(var(--seat-min, 44px), 1fr))` } },
      rows.flatMap((r) => cols.map((c) => renderSeat(m.seatKey(r, c), grid.get(m.seatKey(r, c)) || null)))),
    display().boardBottom && front);
}

function seatingTab(cls) {
  const studs = m.students(cls.id);
  const { grid, unplaced } = m.seatMap(cls, studs);
  const disp = display();
  const sel = ui.selected;

  const place = async (seat) => {
    if (!ui.selected) return;
    const id = ui.selected;
    ui.selected = null;
    await m.moveStudent(cls, id, seat);
    render();   // also when nothing moved, to drop the selection
  };
  const pick = (id) => { ui.selected = ui.selected === id ? null : id; render(); };
  // Two quick taps on one student open their card. (The browser's own
  // dblclick never fires here: the first tap redraws the plan.)
  const doubleTap = (id) => {
    const now = Date.now();
    const hit = ui.lastTap?.id === id && now - ui.lastTap.t < 450;
    ui.lastTap = hit ? null : { id, t: now };
    return hit;
  };
  const openEdit = (id) => { ui.selected = null; ui.sheet = { type: 'edit', studentId: id, draft: {} }; render(); };
  const flip = async (how, what) => {
    await m.flipSeats(cls, how);
    toast(`Swapped ${what}.`, { label: 'Undo', run: () => m.flipSeats(cls, how) });
  };
  const openAdd = (seat) => { ui.sheet = { type: 'add', classId: cls.id, seat, draft: {} }; renderSheet(); };
  const dragProps = (s) => ({
    draggable: true,
    ondragstart: (e) => { e.dataTransfer.setData('text/plain', s.id); e.dataTransfer.effectAllowed = 'move'; },
  });
  const dropProps = (seat) => ({
    ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
    ondragleave: (e) => e.currentTarget.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault();
      const id = e.dataTransfer.getData('text/plain');
      if (id) m.moveStudent(cls, id, seat);
    },
  });

  const size = (key, label) => h('input', {
    type: 'number', min: 1, max: 20, value: cls[key], 'aria-label': label, dataset: { focusKey: `size-${key}` },
    onchange: async (e) => {
      const n = Math.max(1, Math.min(20, Math.round(+e.target.value) || cls[key]));
      const plan = m.resizePlan(cls, key === 'rows' ? n : cls.rows, key === 'cols' ? n : cls.cols);
      if (plan.displaced.length) {
        const names = plan.displaced.map(m.fullName).join(', ');
        if (!confirm(`There are not enough empty ${key === 'rows' ? 'rows' : 'seats per row'} to remove. ${plan.displaced.length} ${plan.displaced.length === 1 ? 'student loses a seat' : 'students lose their seats'} (they move to “Not seated”):\n\n${names}`)) {
          e.target.value = cls[key];
          return;
        }
      }
      await plan.apply();
    },
  });

  return h('section', {},
    h('div', { class: 'toolbar' },
      h('label', { class: 'size' }, 'Rows', size('rows', 'Rows')),
      h('label', { class: 'size' }, 'Seats per row', size('cols', 'Seats per row')),
      toggle('Names', 'showNames', render), toggle('Photos', 'showPhotos', render), toggle('Board at the bottom', 'boardBottom', render)),
    h('p', { class: 'hint' }, sel ? 'Now tap a seat — or “Not seated” to take them off the plan.' : 'Tap a student, then tap a seat. Occupied seats swap. On a computer you can also drag. Tap an empty seat to add a student there; double-tap a student to edit their name and photo.'),
    seatGrid(cls, grid, (seat, s) => h('div', {
      class: `seat ${s ? 'taken' : 'empty addable'} ${s && s.id === sel ? 'selected' : ''} ${sel ? 'target' : ''}`,
      onclick: () => {
        if (s && doubleTap(s.id)) return openEdit(s.id);
        return sel ? place(seat) : s ? pick(s.id) : openAdd(seat);
      },
      title: s ? null : 'Add a student here',
      ...dropProps(seat),
      ...(s ? dragProps(s) : {}),
    }, s ? face(s, disp) : h('span', { class: 'add-hint', 'aria-hidden': 'true' }, '+'))),
    h('div', { class: `tray ${sel ? 'target' : ''}`, onclick: (e) => { if (e.target === e.currentTarget && sel) place(null); }, ...dropProps(null) },
      h('h3', { onclick: () => sel && place(null) }, `Not seated (${unplaced.length})`),
      unplaced.length ? unplaced.map((s) => h('div', {
        class: `seat taken ${s.id === sel ? 'selected' : ''}`,
        onclick: (e) => { e.stopPropagation(); if (doubleTap(s.id)) openEdit(s.id); else pick(s.id); },
        ...dragProps(s),
      }, face(s, disp))) : h('span', { class: 'muted' }, 'Everyone has a seat.')),
    h('div', { class: 'row-buttons' },
      h('button', { onclick: () => m.fillSeats(cls), disabled: !unplaced.length }, 'Seat the rest alphabetically'),
      h('button', { onclick: () => confirm('Take everyone off the plan?') && m.clearSeats(cls) }, 'Clear plan')),
    // For a plan entered the wrong way round: mirror it. Both together turn it by 180°.
    h('div', { class: 'row-buttons' },
      h('span', { class: 'muted' }, 'Entered the wrong way round?'),
      h('button', { onclick: () => flip({ rows: true }, 'front and back') }, 'Flip front ↔ back'),
      h('button', { onclick: () => flip({ cols: true }, 'left and right') }, 'Flip left ↔ right')));
}

// Any image — picked, pasted — becomes the small square JPEG a photo is stored as.
async function asPhoto(blob) {
  if (!blob) return null;
  try {
    return await m.resizePhoto(blob);
  } catch {
    toast('That image could not be read.');
    return null;
  }
}

const setPhoto = async (s, blob) => {
  const photo = await asPhoto(blob);
  if (photo) await db.patch('students', s.id, { photo });
};

function photoInput(onFile) {
  return h('input', { type: 'file', accept: 'image/*', class: 'hidden', onchange: (e) => onFile(e.target.files[0]) });
}

// Paste while typing in a name field (⌘V, or long-press → Paste on the phone):
// an image becomes the photo, text goes into the field as usual.
const onPastePhoto = (use) => (e) => {
  const img = pastedImage(e);
  if (img) { e.preventDefault(); use(img); }
};

const pasteButton = (use, label = 'Paste photo') => h('button', {
  type: 'button', class: 'paste', title: 'Paste an image from the clipboard as the photo',
  onclick: async () => { const img = await readClipboardImage(); if (img) use(img); },
}, label);

// Once everyone has a seat, the list follows the plan as it is shown — top
// left to bottom right, row by row; until then, by surname.
function studentsInOrder(cls) {
  const studs = m.students(cls.id);
  const { grid, unplaced } = m.seatMap(cls, studs);
  if (!studs.length || unplaced.length) return { studs, bySeat: false };
  const { rows, cols } = seatOrder(cls);
  const order = rows.flatMap((r) => cols.map((c) => grid.get(m.seatKey(r, c)))).filter(Boolean);
  return { studs: order, bySeat: true };
}

function studentsTab(cls) {
  const { studs, bySeat } = studentsInOrder(cls);
  // What is typed for the next student, kept across redraws (a pasted photo, a sync).
  if (ui.addDraft?.classId !== cls.id) ui.addDraft = { classId: cls.id, firstName: '', lastName: '' };
  const draft = ui.addDraft;
  const first = h('input', { name: 'firstName', placeholder: 'First name', required: true, autocomplete: 'off', value: draft.firstName, dataset: { focusKey: 'add-first' }, oninput: (e) => { draft.firstName = e.target.value; } });
  const last = h('input', { name: 'lastName', placeholder: 'Surname', autocomplete: 'off', value: draft.lastName, dataset: { focusKey: 'add-last' }, oninput: (e) => { draft.lastName = e.target.value; } });
  // Adding redraws the form: the cursor goes into the new one's surname field.
  const focusSurname = () => requestAnimationFrame(() => main.querySelector('form.add-student input[name=lastName]')?.focus());
  // The photo for the next student added here, kept across redraws.
  const pending = ui.newPhoto?.classId === cls.id ? ui.newPhoto.photo : null;
  const setPending = async (blob) => {
    const photo = await asPhoto(blob);
    if (photo) { ui.newPhoto = { classId: cls.id, photo }; render(); focusSurname(); }
  };
  const newFile = photoInput(setPending);
  const bulk = h('textarea', { rows: 6, placeholder: 'Musterfrau, Erika\nMustermann, Max\nBerta Beispiel' });

  return h('section', {},
    h('form', {
      class: 'inline-form add-student',
      onpaste: onPastePhoto(setPending),
      onsubmit: async (e) => {
        e.preventDefault();
        const firstName = first.value.trim();
        const lastName = last.value.trim();
        ui.newPhoto = null;   // before the write: the write redraws the form
        ui.addDraft = { classId: cls.id, firstName: '', lastName: '' };
        await db.put('students', { classId: cls.id, firstName, lastName, photo: pending, seat: null });
        first.value = ''; last.value = '';
        focusSurname();
      },
    },
    h('button', { type: 'button', class: 'photo', title: 'Photo for the new student', 'aria-label': 'Choose a photo', onclick: () => newFile.click() },
      pending ? h('img', { src: pending, alt: '' }) : h('span', '📷')),
    newFile,
    last, first,
    pasteButton(setPending),
    pending ? h('button', { type: 'button', onclick: () => { ui.newPhoto = null; render(); } }, 'No photo') : null,
    h('button', { class: 'primary' }, 'Add')),
    h('p', { class: 'hint' }, 'A photo can be chosen, or pasted: copy an image, then press ⌘V in a name field or tap “Paste photo”.'),
    h('details', { class: 'bulk' },
      h('summary', 'Paste a class list'),
      h('p', { class: 'hint' }, 'One student per line: “Surname, First name” or “First name Surname”.'),
      bulk,
      h('button', {
        class: 'primary',
        onclick: async () => {
          const people = m.parseRoster(bulk.value);
          if (!people.length) return;
          await db.write(people.map((p) => ({ tbl: 'students', data: { classId: cls.id, ...p, photo: null, seat: null } })));
          toast(`Added ${people.length} students.`);
        },
      }, 'Add all')),
    studs.length ? h('p', { class: 'muted small list-order' }, bySeat
      ? 'In seating-plan order: top left to bottom right, row by row.'
      : 'By surname — once everyone has a seat, the list follows the seating plan.') : null,
    studs.length ? h('ul', { class: 'list students' }, studs.map((s) => {
      const file = photoInput((f) => setPhoto(s, f));
      const edit = (key) => h('input', {
        value: s[key], 'aria-label': key === 'firstName' ? 'First name' : 'Surname', dataset: { focusKey: `name-${s.id}-${key}` },
        onchange: (e) => db.patch('students', s.id, { [key]: e.target.value.trim() }),
      });
      return h('li', { onpaste: onPastePhoto((img) => setPhoto(s, img)) },
        h('button', { class: 'photo', title: 'Photo', onclick: () => file.click() },
          s.photo ? h('img', { src: s.photo, alt: '' }) : h('span', m.initials(s))),
        file,
        h('div', { class: 'names' }, edit('lastName'), edit('firstName')),
        pasteButton((img) => setPhoto(s, img), 'Paste'),
        s.photo ? h('button', { onclick: () => db.patch('students', s.id, { photo: null }) }, 'Remove photo') : null,
        h('button', { title: 'Left the class: hidden everywhere, marks kept', onclick: () => confirmDropOut(s) }, 'Dropped out'),
        h('button', {
          class: 'danger',
          onclick: () => confirm(`Delete ${m.fullName(s)} and all their marks?`) && m.deleteStudent(s.id),
        }, 'Delete'));
    })) : h('p', { class: 'empty' }, 'No students yet.'),
    droppedCard(cls));
}

function confirmDropOut(s) {
  if (!confirm(`${m.fullName(s)} dropped out of the class?\n\nThey no longer show up in marking, the seating plan, the summary or the grades. Nothing is deleted: “Dropped out” at the end of the Students tab takes them back.`)) return Promise.resolve(false);
  return m.dropOut(s).then(() => { toast(`${m.fullName(s)}: dropped out.`, { label: 'Undo', run: () => m.takeBack(s) }); return true; });
}

// Who left the class — and the way back.
function droppedCard(cls) {
  const gone = m.droppedStudents(cls.id);
  if (!gone.length) return null;
  return h('details', { class: 'card dropped', open: gone.length <= 3 },
    h('summary', h('strong', `Dropped out (${gone.length})`), h('span', { class: 'muted small' }, ' — hidden everywhere; their marks are kept')),
    h('ul', { class: 'list compact' }, gone.map((s) => h('li',
      h('span', { class: 'grow' }, s.lastName, ' ', h('span', { class: 'muted' }, s.firstName)),
      h('span', { class: 'muted small' }, `since ${m.formatDate(s.droppedOut, { day: 'numeric', month: 'short', year: 'numeric' })}`),
      h('button', { class: 'mini', onclick: async () => { await m.takeBack(s); toast(`${m.fullName(s)} is back in the class — give them a seat in the seating plan.`); } }, 'Back in class'),
      h('button', { class: 'mini danger', onclick: () => confirm(`Delete ${m.fullName(s)} and all their marks for good?`) && m.deleteStudent(s.id) }, 'Delete')))));
}

// --- marking -----------------------------------------------------------------

// The marks' symbols are a setting (see model.symbols); what they mean is fixed.
const MODES = ['details', 'plus', 'star', 'minus', 'absent'];
const symbolOf = (kind) => (kind === 'comment' ? '✎' : m.symbols()[kind] || '·');
const modeLabel = (key) => ({ details: 'Details', absent: 'Absent' }[key] || symbolOf(key));

function courseScreen(course, date) {
  const cls = db.get('classes', course.classId);
  const studs = m.students(cls.id);
  const { grid, unplaced } = m.seatMap(cls, studs);
  const disp = display();
  const mode = prefs.get('mode', 'details');
  const todays = m.entries(course.id, (e) => e.date === date);
  const absent = new Set(m.absences(course.id, (a) => a.date === date).map((a) => a.studentId));
  // Who is here: the class, minus those marked absent for this day.
  const awayCount = studs.filter((s) => absent.has(s.id)).length;
  const presentCount = studs.length - awayCount;
  const counts = new Map();
  for (const e of todays) {
    const c = counts.get(e.studentId) || { plus: 0, star: 0, minus: 0, comment: 0 };
    c[e.kind]++;
    counts.set(e.studentId, c);
  }
  const setDate = (d) => go(`/course/${course.id}?d=${d}`);
  const colours = prefs.get('showStanding', true);
  const stand = m.standing(course, studs);
  const signed = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0');
  const sym = m.symbols();

  const tap = async (s) => {
    const name = s.firstName || m.fullName(s);
    if (mode === 'minus') {
      openReason(await m.addEntry(course.id, s.id, date, 'minus'), { undo: true });
    } else if (mode === 'plus' || mode === 'star') {
      closeReason();
      const id = await m.addEntry(course.id, s.id, date, mode);
      toast(`${symbolOf(mode)} for ${name}`, { label: 'Undo', run: () => db.remove('entries', id) });
    } else if (mode === 'absent') {
      const on = !absent.has(s.id);
      await m.setAbsent(course.id, s.id, date, on);
      toast(`${name} ${on ? 'absent' : 'present'}`, { label: 'Undo', run: () => m.setAbsent(course.id, s.id, date, !on) });
    } else {
      ui.sheet = { courseId: course.id, studentId: s.id, date };
      renderSheet();
    }
  };

  const tile = (s) => {
    const c = counts.get(s.id);
    const away = absent.has(s.id);
    const st = stand.of.get(s.id);
    // Green above the class average, red below; absent stays yellow.
    const bg = colours && !away && st ? m.tint(st.z) : null;
    return h('button', {
      class: `seat taken mark ${away ? 'absent' : ''}`,
      style: bg ? { background: bg } : null,
      title: st ? `In this course: ${signed(st.net)} (class average ${stand.mean >= 0 ? '+' : '−'}${Math.abs(stand.mean).toFixed(1)})` : null,
      onclick: () => tap(s),
    },
      face(s, disp),
      h('div', { class: 'badges' },
        away && h('span', { class: 'badge away' }, 'absent'),
        c?.plus ? h('span', { class: 'badge plus' }, `${sym.plus}${c.plus}`) : null,
        c?.star ? h('span', { class: 'badge star' }, `${sym.star}${c.star > 1 ? c.star : ''}`) : null,
        c?.minus ? h('span', { class: 'badge minus' }, `${sym.minus}${c.minus}`) : null,
        c?.comment ? h('span', { class: 'badge note', title: 'Comment' }, '✎') : null));
  };

  const totals = todays.reduce((t, e) => { t[e.kind]++; return t; }, { plus: 0, star: 0, minus: 0, comment: 0 });
  const isToday = date === m.today();

  const screen = page(course.name, { href: `/class/${cls.id}/courses`, label: cls.name },
    pv.courseTabs(course, ''),
    h('div', { class: 'datebar' },
      h('button', { onclick: () => setDate(pv.stepDay(course, date, -1)), 'aria-label': 'Previous teaching day' }, '‹'),
      h('input', { type: 'date', value: date, onchange: (e) => e.target.value && setDate(e.target.value) }),
      h('button', { onclick: () => setDate(pv.stepDay(course, date, 1)), 'aria-label': 'Next teaching day' }, '›'),
      !isToday && h('button', { onclick: () => setDate(m.today()) }, 'Today'),
      recordedDaysPicker(course, date, setDate),
      h('span', { class: 'muted day' }, isToday ? 'Today' : m.formatDate(date)),
      h('span', { class: `attendance ${awayCount ? 'some-away' : ''}`, title: 'Present = the class minus those marked absent for this day' },
        h('b', String(presentCount)), ` / ${studs.length} present`,
        awayCount ? h('span', { class: 'away-count' }, ` · ${awayCount} absent`) : null)),
    pv.planLine(course, date),
    h('div', { class: 'modes', role: 'radiogroup', 'aria-label': 'What a tap does' }, MODES.map((key) =>
      h('button', {
        class: `mode ${key} ${mode === key ? 'active' : ''}`,
        role: 'radio', 'aria-checked': String(mode === key),
        title: { plus: 'Plus', star: 'Super-plus', minus: 'Minus' }[key] || null,
        onclick: () => { prefs.set('mode', key); closeReason(); render(); },
      }, modeLabel(key)))),
    h('p', { class: 'hint' }, {
      details: `Tap a student for ${sym.plus}, ${sym.star}, ${sym.minus}, comment and absence.`,
      plus: `Every tap gives a ${sym.plus} (a plus). Tap again for another.`,
      star: `Every tap gives a ${sym.star} — a super-plus. Tap again for another.`,
      minus: `Every tap gives a ${sym.minus} (a minus). Tap again for another.`,
      absent: 'Tap to mark absent; tap again to mark present.',
    }[mode]),
    seatGrid(cls, grid, (seat, s) => (s ? tile(s) : h('div', { class: 'seat empty' })), { compact: true }),
    unplaced.length ? h('div', { class: 'tray' }, h('h3', `Not seated (${unplaced.length})`), unplaced.map(tile)) : null,
    h('div', { class: 'daysum' },
      h('span', { class: 'plus' }, `${sym.plus}${totals.plus}`), totals.star ? h('span', { class: 'star' }, `${sym.star}${totals.star}`) : null, h('span', { class: 'minus' }, `${sym.minus}${totals.minus}`),
      h('span', `${totals.comment} ${totals.comment === 1 ? 'comment' : 'comments'}`), h('span', `${presentCount} present, ${awayCount} absent`), h('span', { class: 'muted' }, `of ${studs.length}`)),
    h('div', { class: 'row-buttons' },
      sizePicker(render),
      h('span', { title: 'Tile colour: green above the class average of + minus −, red below; the stronger, the further away' },
        toggle('Colours', 'showStanding', render)),
      toggle('Names', 'showNames', render), toggle('Photos', 'showPhotos', render), toggle('Board at the bottom', 'boardBottom', render),
      h('button', {
        title: 'Every student’s +, ★ and − of this day, with the IDs of the entries',
        onclick: () => {
          const name = `${cls.name}-${course.name}-${date}`.replace(/[^\p{L}\p{N}-]+/gu, '_');
          m.download(`${name}.json`, JSON.stringify(m.dayScores(course, date), null, 2), 'application/json');
        },
      }, 'Export day (JSON)'),
      exportCourseButton(course, cls),
      gr.overviewButton(course),
      h('a', { class: 'button primary', href: `#/course/${course.id}/summary` }, 'Summary')));
  screen.classList.add('marking', `size-${markingSize()}`);
  return screen;
}

// Jump to a day that already has marks, comments or absences in this course.
function recordedDaysPicker(course, date, setDate) {
  const days = m.recordedDays(course);
  if (!days.length) return null;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const describe = (d) => [
    d.marks && plural(d.marks, 'mark', 'marks'),
    d.comments && plural(d.comments, 'comment', 'comments'),
    d.absent && `${d.absent} absent`,
  ].filter(Boolean).join(', ');
  const here = days.some((d) => d.date === date);
  const thisYear = m.today().slice(0, 4);
  return h('select', {
    class: 'recorded-days', 'aria-label': 'Days with marks',
    title: `${plural(days.length, 'day', 'days')} with marks, comments or absences`,
    onchange: (e) => e.target.value && setDate(e.target.value),
  },
  !here && h('option', { value: '', selected: true }, `Days with marks (${days.length})…`),
  days.map((d) => h('option', { value: d.date, selected: d.date === date },
    `${m.formatDate(d.date, { weekday: 'short', day: 'numeric', month: 'short', ...(d.date.slice(0, 4) === thisYear ? {} : { year: 'numeric' }) })} · ${describe(d)}`)));
}

// Every student's +, ★ and − over the whole course, with the IDs of the entries.
function exportCourseButton(course, cls) {
  return h('button', {
    title: 'Every student’s +, ★ and − over the whole course, day by day, with the IDs of the entries',
    onclick: () => {
      const name = `${cls.name}-${course.name}-course`.replace(/[^\p{L}\p{N}-]+/gu, '_');
      m.download(`${name}.json`, JSON.stringify(m.courseScores(course), null, 2), 'application/json');
    },
  }, 'Export course (JSON)');
}

// How big the marking screen is drawn, per device: smaller fits a whole
// seating plan onto a phone screen.
const SIZES = [['normal', 'Normal'], ['compact', 'Compact'], ['mini', 'Mini']];
const markingSize = () => {
  const v = prefs.get('markingSize', 'normal');
  return SIZES.some(([k]) => k === v) ? v : 'normal';
};

function sizePicker(onChange) {
  const cur = markingSize();
  return h('div', { class: 'sizes', role: 'radiogroup', 'aria-label': 'Size of the marking screen' },
    h('span', { class: 'muted small' }, 'Size'),
    SIZES.map(([key, label]) => h('button', {
      type: 'button', class: key === cur ? 'active' : '', role: 'radio', 'aria-checked': String(key === cur),
      onclick: () => { prefs.set('markingSize', key); onChange?.(); },
    }, label)));
}

function closeSheet() {
  if (ui.sheet?.type === 'edit') saveEdit(ui.sheet);
  ui.sheet = null;
  sheetRoot.replaceChildren();
  document.body.classList.remove('sheet-open');
}

function renderSheet() {
  const st = ui.sheet;
  if (st?.type === 'add') { renderAddSheet(st); return; }
  if (st?.type === 'edit') { renderEditSheet(st); return; }
  const s = st && db.get('students', st.studentId);
  if (!s || !db.get('courses', st.courseId)) {
    ui.sheet = null;
    sheetRoot.replaceChildren();
    document.body.classList.remove('sheet-open');
    return;
  }
  const { courseId, date } = st;
  const list = m.entries(courseId, (e) => e.studentId === s.id && e.date === date);
  const away = m.isAbsent(courseId, s.id, date);
  const all = m.entries(courseId, (e) => e.studentId === s.id);
  const absentDays = m.absences(courseId, (a) => a.studentId === s.id).length;
  const close = () => { ui.sheet = null; renderSheet(); };
  // The sheet is redrawn on every change (a + tapped a moment ago, a sync):
  // what is half-typed, and the cursor, survive that.
  const typing = document.activeElement?.name === 'note' && sheetRoot.contains(document.activeElement);
  const note = h('input', {
    name: 'note', placeholder: 'Comment…', enterkeyhint: 'done', autocomplete: 'off',
    value: st.draft || '', oninput: (e) => { st.draft = e.target.value; },
  });
  const addNote = async () => {
    const text = note.value.trim();
    if (!text) return;
    note.value = '';
    st.draft = '';
    await m.addEntry(courseId, s.id, date, 'comment', text);
  };

  document.body.classList.add('sheet-open');
  sheetRoot.replaceChildren(
    h('div', { class: 'backdrop', onclick: close }),
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': m.fullName(s) },
      h('div', { class: 'sheet-head' },
        face(s, { names: true, photos: true }),
        h('div', { class: 'muted' }, m.formatDate(date)),
        h('button', { class: 'icon close', onclick: close, 'aria-label': 'Close' }, '✕')),
      h('div', { class: 'big-buttons' },
        h('button', { class: 'big plus', title: 'A plus', onclick: () => m.addEntry(courseId, s.id, date, 'plus') }, symbolOf('plus')),
        h('button', { class: 'big star', title: 'A super-plus', onclick: () => m.addEntry(courseId, s.id, date, 'star') }, symbolOf('star')),
        h('button', { class: 'big minus', title: 'A minus', onclick: async () => openReason(await m.addEntry(courseId, s.id, date, 'minus')) }, symbolOf('minus'))),
      h('label', { class: 'switch absent-switch' },
        h('input', { type: 'checkbox', checked: away, onchange: (e) => m.setAbsent(courseId, s.id, date, e.target.checked) }),
        h('span', 'Absent in this lesson')),
      h('form', { class: 'inline-form', onsubmit: (e) => { e.preventDefault(); addNote(); } },
        note, h('button', { class: 'primary' }, 'Add')),
      list.length ? h('ul', { class: 'entries' }, list.map((e) => h('li', { class: e.kind },
        h('span', { class: 'kind' }, symbolOf(e.kind)),
        h('span', { class: 'grow' }, e.text || (e.kind === 'minus' ? h('span', { class: 'muted' }, 'no reason') : '')),
        h('span', { class: 'muted' }, new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
        e.kind === 'minus' ? h('button', { class: 'mini ghost', title: 'Give or change the reason', onclick: () => openReason(e.id) }, 'Reason') : null,
        h('button', { class: 'mini ghost', title: 'Remove this entry', onclick: () => db.remove('entries', e.id) }, 'Remove'))))
        : h('p', { class: 'muted' }, 'Nothing yet for this day.'),
      h('p', { class: 'muted total' },
        `In this course: ${['plus', 'star', 'minus'].map((k) => `${symbolOf(k)}${all.filter((e) => e.kind === k).length}`).join('  ')}  · absent ${absentDays}×`)));
  if (typing) note.focus();
}

// A new student straight onto an empty seat — or an unseated one moved there.
function renderAddSheet(st) {
  const cls = db.get('classes', st.classId);
  if (!cls) { closeSheet(); return; }
  const { grid, unplaced } = m.seatMap(cls, m.students(cls.id));
  if (grid.has(st.seat)) { closeSheet(); return; }   // taken meanwhile (a sync)
  const [r, c] = st.seat.split(',').map(Number);
  const d = st.draft;
  // Redrawn by syncs: keep what is typed and where the cursor is.
  const focused = sheetRoot.contains(document.activeElement) ? document.activeElement.name : null;
  const input = (name, placeholder) => h('input', {
    name, placeholder, value: d[name] || '', autocomplete: 'off', autocapitalize: 'words', spellcheck: false,
    enterkeyhint: name === 'lastName' ? 'next' : 'done',
    oninput: (e) => { d[name] = e.target.value; },
  });
  const first = input('firstName', 'First name');
  const last = input('lastName', 'Surname');
  last.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); first.focus(); } });
  const usePhoto = async (blob) => {
    const photo = await asPhoto(blob);
    if (!photo) return;
    d.photo = photo;
    renderSheet();
    // Back to typing the name, wherever the paste came from.
    const box = sheetRoot.querySelector(`input[name=${d.lastName ? 'firstName' : 'lastName'}]`);
    box?.focus();
  };
  const photo = photoInput(usePhoto);

  // The next empty seat after this one, in the order they appear on screen.
  const nextSeat = () => {
    const order = seatOrder(cls);
    const keys = order.rows.flatMap((row) => order.cols.map((col) => m.seatKey(row, col)));
    const at = keys.indexOf(st.seat);
    for (let i = 1; i < keys.length; i++) {
      const key = keys[(at + i) % keys.length];
      if (!grid.has(key)) return key;
    }
    return null;
  };
  const add = async (andNext) => {
    const firstName = first.value.trim();
    const lastName = last.value.trim();
    if (!firstName && !lastName) { last.focus(); return; }
    const next = andNext ? nextSeat() : null;
    await db.put('students', { classId: cls.id, firstName, lastName, photo: d.photo || null, seat: st.seat });
    toast(`Added ${firstName || lastName}.`);
    if (next) {
      ui.sheet = { type: 'add', classId: cls.id, seat: next, draft: {} };
      renderSheet();
      sheetRoot.querySelector('input[name=lastName]')?.focus();
    } else {
      closeSheet();
      if (andNext) toast('Added. Every seat is taken now.');
    }
  };
  const seatExisting = async (studentId) => {
    await m.moveStudent(cls, studentId, st.seat);
    closeSheet();
  };

  document.body.classList.add('sheet-open');
  sheetRoot.replaceChildren(
    h('div', { class: 'backdrop', onclick: closeSheet }),
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add a student', onpaste: onPastePhoto(usePhoto) },
      h('div', { class: 'sheet-head' },
        h('button', { class: 'avatar photo-pick', title: 'Photo', 'aria-label': 'Add a photo', onclick: () => photo.click() },
          d.photo ? h('img', { src: d.photo, alt: '' }) : '📷'),
        photo,
        h('div', { class: 'name' }, h('span', { class: 'first' }, 'New student'), h('span', { class: 'last' }, r === 0 ? 'Front row' : `Row ${r + 1} from the front`)),
        h('button', { class: 'icon close', onclick: closeSheet, 'aria-label': 'Close' }, '✕')),
      h('form', { class: 'add-form', onsubmit: (e) => { e.preventDefault(); add(true); } },
        last, first,
        h('div', { class: 'row-buttons' },
          h('button', { class: 'primary' }, 'Add & next seat'),
          h('button', { type: 'button', onclick: () => add(false) }, 'Add'),
          pasteButton(usePhoto),
          d.photo ? h('button', { type: 'button', onclick: () => { d.photo = null; renderSheet(); } }, 'Remove photo') : null)),
      unplaced.length ? h('div', { class: 'existing' },
        h('h3', 'Or seat someone who has no seat yet'),
        h('div', { class: 'chips' }, unplaced.map((s) => h('button', { class: 'chip', onclick: () => seatExisting(s.id) }, m.fullName(s))))) : null));
  const again = focused && sheetRoot.querySelector(`input[name=${focused}]`);
  (again || (focused === null && !d.lastName ? last : null))?.focus();
}

// A student's card from the seating plan: name and photo.
function saveEdit(st) {
  const s = db.get('students', st.studentId);
  if (!s) return;
  const fields = {};
  for (const key of ['lastName', 'firstName']) {
    if (st.draft[key] !== undefined && st.draft[key].trim() !== (s[key] || '')) fields[key] = st.draft[key].trim();
  }
  st.draft = {};
  if (Object.keys(fields).length) db.patch('students', s.id, fields);
}

function renderEditSheet(st) {
  const s = db.get('students', st.studentId);
  if (!s) { closeSheet(); return; }
  const d = st.draft;
  const focused = sheetRoot.contains(document.activeElement) ? document.activeElement.name : null;
  const input = (name, placeholder) => h('input', {
    name, placeholder, value: d[name] ?? s[name] ?? '', autocomplete: 'off', autocapitalize: 'words', spellcheck: false,
    enterkeyhint: name === 'lastName' ? 'next' : 'done', 'aria-label': placeholder,
    oninput: (e) => { d[name] = e.target.value; },
    onchange: () => saveEdit(st),
  });
  const last = input('lastName', 'Surname');
  const first = input('firstName', 'First name');
  last.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); first.focus(); } });
  first.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); closeSheet(); } });
  const usePhoto = async (blob) => {
    const photo = await asPhoto(blob);
    if (photo) await db.patch('students', s.id, { photo });
  };
  const file = photoInput(usePhoto);

  document.body.classList.add('sheet-open');
  sheetRoot.replaceChildren(
    h('div', { class: 'backdrop', onclick: closeSheet }),
    h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Edit ${m.fullName(s)}`, onpaste: onPastePhoto(usePhoto) },
      h('div', { class: 'sheet-head' },
        h('button', { class: 'avatar photo-pick', title: 'Choose a photo', 'aria-label': 'Choose a photo', onclick: () => file.click() },
          s.photo ? h('img', { src: s.photo, alt: '' }) : m.initials(s)),
        file,
        h('div', { class: 'name' }, h('span', { class: 'first' }, m.fullName(s) || 'Student'), h('span', { class: 'last' }, 'Edit name and photo')),
        h('button', { class: 'icon close', onclick: closeSheet, 'aria-label': 'Close' }, '✕')),
      h('form', { class: 'add-form', onsubmit: (e) => { e.preventDefault(); closeSheet(); } },
        last, first,
        h('div', { class: 'row-buttons' },
          h('button', { class: 'primary' }, 'Done'),
          h('button', { type: 'button', onclick: () => file.click() }, 'Choose photo'),
          pasteButton(usePhoto),
          s.photo ? h('button', { type: 'button', onclick: () => db.patch('students', s.id, { photo: null }) }, 'Remove photo') : null,
          h('button', { type: 'button', onclick: async () => { saveEdit(st); if (await confirmDropOut(s)) closeSheet(); } }, 'Dropped out')))));
  const again = focused && sheetRoot.querySelector(`input[name=${focused}]`);
  if (again) again.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.sheet) closeSheet();
});

// --- summary -----------------------------------------------------------------

function summaryScreen(course, q) {
  const cls = db.get('classes', course.classId);
  const from = q.get('from') || '';
  const to = q.get('to') || '';
  const tab = q.get('tab') || 'totals';
  const { rows, dates } = m.summarise(course, from, to);
  // Rows coloured like the marking tiles: green above the class average of
  // + and ★ minus −, red below — over the range shown.
  const colours = prefs.get('showStanding', true);
  const stand = m.standingOf(new Map(rows.map((r) => [r.student.id, r.plus + r.star - r.minus])));
  const rowTint = (id) => (colours ? m.tint(stand.of.get(id)?.z ?? 0) : null);
  const avg = `${stand.mean >= 0 ? '+' : '−'}${Math.abs(stand.mean).toFixed(1)}`;
  const setQ = (changes) => {
    const p = new URLSearchParams({ from, to, tab, ...changes });
    for (const [k, v] of [...p]) if (!v) p.delete(k);
    go(`/course/${course.id}/summary?${p}`);
  };

  const cols = [
    ['name', 'Student', (r) => `${r.student.lastName} ${r.student.firstName}`],
    ['plus', symbolOf('plus'), (r) => r.plus],
    ['star', symbolOf('star'), (r) => r.star],
    ['minus', symbolOf('minus'), (r) => r.minus],
    ['net', 'Net', (r) => r.plus + r.star - r.minus],
    ['absent', 'Absent', (r) => r.absent.size],
    ['comments', 'Comments', (r) => r.comments],
    ['last', 'Last', (r) => r.last],
  ];
  const sortCol = cols.find((c) => c[0] === ui.sort.key) || cols[0];
  rows.sort((a, b) => {
    const x = sortCol[2](a), y = sortCol[2](b);
    const d = typeof x === 'string' ? m.collator.compare(x, y) : x - y;
    return d * ui.sort.dir || m.byName(a.student, b.student);
  });
  const sortBy = (key) => {
    ui.sort = { key, dir: ui.sort.key === key ? -ui.sort.dir : (key === 'name' ? 1 : -1) };
    prefs.set('sort', ui.sort);
    render();
  };

  const dayCell = (d) => {
    if (!d) return '';
    const plus = d.entries.filter((e) => e.kind === 'plus').length;
    const star = d.entries.filter((e) => e.kind === 'star').length;
    const minus = d.entries.filter((e) => e.kind === 'minus').length;
    const notes = d.entries.filter((e) => e.kind === 'comment');
    return [
      d.absent && h('span', { class: 'away' }, 'A'),
      plus ? h('span', { class: 'plus' }, `${symbolOf('plus')}${plus > 1 ? plus : ''}`) : null,
      star ? h('span', { class: 'star' }, `${symbolOf('star')}${star > 1 ? star : ''}`) : null,
      minus ? h('span', { class: 'minus', title: d.entries.filter((e) => e.kind === 'minus').map((e) => e.text || 'no reason').join('\n') }, `${symbolOf('minus')}${minus > 1 ? minus : ''}`) : null,
      notes.length ? h('span', { class: 'note', title: notes.map((n) => n.text).join('\n') }, '✎') : null,
    ];
  };

  const history = (r) => h('tr', { class: 'history' }, h('td', { colSpan: cols.length },
    r.byDate.size ? h('ul', [...r.byDate.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, d]) =>
      h('li', h('strong', m.formatDate(date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })), ' ',
        d.absent ? h('span', { class: 'away' }, 'absent ') : null,
        d.entries.map((e) => (e.kind === 'comment' ? h('span', { class: 'note' }, `“${e.text}” `)
          : h('span', { class: e.kind }, `${symbolOf(e.kind)}${e.text ? ` (${e.text})` : ''} `)))))) : h('span', { class: 'muted' }, 'Nothing recorded.')));

  const totals = h('div', { class: 'table-wrap' }, h('table', { class: 'summary' },
    h('thead', h('tr', cols.map(([key, label]) => h('th', {
      class: `${key === ui.sort.key ? 'sorted' : ''} ${key === 'name' ? '' : 'num'}`,
      onclick: () => sortBy(key),
    }, label, key === ui.sort.key ? (ui.sort.dir > 0 ? ' ▲' : ' ▼') : '')))),
    h('tbody', rows.flatMap((r) => {
      const open = ui.expanded.has(r.student.id);
      const net = r.plus + r.star - r.minus;
      return [
        h('tr', {
          class: 'clickable', style: rowTint(r.student.id) ? { background: rowTint(r.student.id) } : null,
          title: `Net ${net > 0 ? '+' : net < 0 ? '−' : ''}${Math.abs(net)} (class average ${avg})`,
          onclick: () => { open ? ui.expanded.delete(r.student.id) : ui.expanded.add(r.student.id); render(); },
        },
          h('td', h('span', { class: 'caret' }, open ? '▾ ' : '▸ '), r.student.lastName, ' ', h('span', { class: 'muted' }, r.student.firstName)),
          h('td', { class: 'num plus' }, r.plus || ''),
          h('td', { class: 'num star' }, r.star || ''),
          h('td', { class: 'num minus' }, r.minus || ''),
          h('td', { class: `num ${net > 0 ? 'plus' : net < 0 ? 'minus' : ''}` }, net > 0 ? `+${net}` : net < 0 ? `−${-net}` : '0'),
          h('td', { class: 'num' }, r.absent.size || ''),
          h('td', { class: 'num' }, r.comments || ''),
          h('td', { class: 'num muted' }, r.last ? m.formatDate(r.last, { day: 'numeric', month: 'numeric' }) : '')),
        open && history(r),
      ];
    }))));

  const byDate = dates.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'matrix' },
    h('thead', h('tr', h('th', 'Student'), dates.map((d) => h('th', { class: 'num' }, m.formatDate(d, { day: 'numeric', month: 'numeric' }))))),
    h('tbody', [...rows].sort((a, b) => m.byName(a.student, b.student)).map((r) => h('tr',
      h('th', { style: rowTint(r.student.id) ? { background: rowTint(r.student.id) } : null }, r.student.lastName, ' ', h('span', { class: 'muted' }, r.student.firstName)),
      dates.map((d) => h('td', { class: 'num' }, dayCell(r.byDate.get(d))))))))) : h('p', { class: 'empty' }, 'Nothing recorded in this range.');

  const stamp = `${cls.name}-${course.name}`.replace(/[^\p{L}\p{N}]+/gu, '_');
  const exportTotals = () => m.download(`${stamp}-summary.csv`, m.csv([
    ['Surname', 'First name', 'Plus', 'Star', 'Minus', 'Net', 'Absent', 'Comments'],
    ...[...rows].sort((a, b) => m.byName(a.student, b.student)).map((r) => [r.student.lastName, r.student.firstName, r.plus, r.star, r.minus, r.plus + r.star - r.minus, r.absent.size, r.comments]),
  ]));
  const exportAll = () => {
    const out = [['Date', 'Surname', 'First name', 'Type', 'Comment', 'Time']];
    for (const r of [...rows].sort((a, b) => m.byName(a.student, b.student))) {
      for (const [date, d] of [...r.byDate.entries()].sort()) {
        if (d.absent) out.push([date, r.student.lastName, r.student.firstName, 'absent', '', '']);
        for (const e of d.entries) out.push([date, r.student.lastName, r.student.firstName, e.kind, e.text || '', new Date(e.at).toLocaleTimeString()]);
      }
    }
    m.download(`${stamp}-entries.csv`, m.csv(out));
  };

  return page(course.name, { href: `/class/${cls.id}/courses`, label: cls.name },
    pv.courseTabs(course, 'summary'),
    tab !== 'grades' && h('div', { class: 'toolbar' },
      h('label', { class: 'size' }, 'From', h('input', { type: 'date', value: from, onchange: (e) => setQ({ from: e.target.value }) })),
      h('label', { class: 'size' }, 'To', h('input', { type: 'date', value: to, onchange: (e) => setQ({ to: e.target.value }) })),
      (from || to) && h('button', { onclick: () => setQ({ from: '', to: '' }) }, 'All dates')),
    h('nav', { class: 'tabs' },
      h('a', { href: '#', class: tab === 'totals' ? 'active' : '', onclick: (e) => { e.preventDefault(); setQ({ tab: 'totals' }); } }, 'Totals'),
      h('a', { href: '#', class: tab === 'dates' ? 'active' : '', onclick: (e) => { e.preventDefault(); setQ({ tab: 'dates' }); } }, 'By date'),
      h('a', { href: '#', class: tab === 'grades' ? 'active' : '', onclick: (e) => { e.preventDefault(); setQ({ tab: 'grades' }); } }, 'Grades')),
    // Grades always cover the whole course: no date range, its own buttons.
    tab === 'grades' ? gr.gradesTable(course) : [
      tab === 'dates' ? byDate : totals,
      h('p', { class: 'hint' }, `${dates.length} ${dates.length === 1 ? 'day' : 'days'} with records. A = absent, ✎ = comment (hover or tap a row for the text).`,
        colours ? ` Green / red: above / below the class average (${avg}) of ${m.symbols().plus} and ${m.symbols().star} minus ${m.symbols().minus}${from || to ? ' in this range' : ''}.` : ''),
      h('div', { class: 'row-buttons' }, toggle('Colours', 'showStanding', render)),
      h('div', { class: 'row-buttons' },
        h('button', { onclick: exportTotals }, 'Export totals (CSV)'),
        h('button', { onclick: exportAll }, 'Export every entry (CSV)'),
        exportCourseButton(course, cls),
        gr.overviewButton(course))]);
}

// --- settings and pairing ---------------------------------------------------

function settingsScreen() {
  const s = db.status;
  const setup = h('div', { class: 'card' }, h('h2', 'Set up a phone'), h('p', { class: 'muted' }, 'Loading…'));
  if (isLocal) { if (setupInfo) drawSetup(setup); else loadSetup(setup); }
  const setupCard = isLocal ? setup : deviceCard();

  return page('Settings', { href: '/', label: 'Classes' },
    syncCard(),
    setupCard,
    h('div', { class: 'card' },
      h('h2', 'Display on this device'),
      h('div', { class: 'row-buttons' }, toggle('Names', 'showNames'), toggle('Photos', 'showPhotos'), toggle('Board at the bottom', 'boardBottom')),
      h('div', { class: 'row-buttons' }, sizePicker(render), h('span', { class: 'muted small' }, 'of the marking screen'))),
    symbolsCard(),
    reasonsCard(),
    h('div', { class: 'card' },
      h('h2', 'Backup'),
      h('p', { class: 'muted' }, 'At every start the computer running Classbook saves a copy of the database without the photos in data/backups (old copies are not deleted automatically). This downloads everything, photos included, as one JSON file.'),
      h('div', { class: 'row-buttons' },
        h('button', { onclick: () => m.download(`classbook-${m.today()}.json`, JSON.stringify(db.dump(), null, 1), 'application/json') }, 'Download JSON'),
        h('button', { onclick: restoreBackup }, 'Import a backup (JSON)…')),
      h('p', { class: 'hint' }, 'Importing adds what is missing here — e.g. marks from a phone that never reached your computer. Nothing deleted since comes back, and records that exist here stay as they are unless you choose otherwise. Then it syncs to your computer.')),
    !isLocal && h('div', { class: 'card' },
      h('h2', 'Remove data from this device'),
      h('p', { class: 'muted' }, 'Deletes the copy on this device only. Anything not yet synced is lost.'),
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (s.pending && !confirm(`${s.pending} changes have not reached your computer yet and will be lost.`)) return;
          if (!confirm('Remove all classbook data from this device?')) return;
          await db.wipe();
          location.hash = '#/pair';
          location.reload();
        },
      }, 'Remove data from this device')));
}

// The marks' symbols — how they look, shared by all devices; never what they mean.
function symbolsCard() {
  const sym = m.symbols();
  const kinds = [['plus', 'Plus', 'counts +1'], ['star', 'Super-plus', 'counts +1, shown on its own'], ['minus', 'Minus', 'counts −1']];
  const input = (key) => h('input', {
    class: 'symbol-input', value: sym[key], 'aria-label': `Symbol for ${key}`, autocomplete: 'off', spellcheck: false, dataset: { focusKey: `sym-${key}` },
    onchange: (e) => {
      const v = e.target.value.trim();
      if (!v) { e.target.value = sym[key]; return; }
      if (m.symbolLength(v) > m.MAX_SYMBOL) { toast(`At most ${m.MAX_SYMBOL} characters.`); e.target.value = sym[key]; return; }
      const clash = Object.entries(sym).find(([k, s]) => k !== key && s === v);
      if (clash) { toast('Each kind of mark needs its own symbol.'); e.target.value = sym[key]; return; }
      m.setSymbols({ [key]: v });
    },
  });
  const suggestions = { plus: ['●', '•', '+', '✓', '👍'], star: ['★', '✱', '⊕', '++', '🌟'], minus: ['✕', '×', '−', '✗', '👎'] };
  return h('div', { class: 'card' },
    h('h2', 'Symbols for the marks'),
    h('p', { class: 'muted' }, 'How the marks look everywhere — on the tiles, the buttons, the summary — on all your devices. What they count for stays the same.'),
    kinds.map(([key, label, meaning]) => h('div', { class: 'symbol-row' },
      h('span', { class: `symbol-label ${key}` }, label, h('span', { class: 'muted small' }, ` · ${meaning}`)),
      input(key),
      h('span', { class: 'symbol-picks' }, suggestions[key].map((s) => h('button', {
        type: 'button', class: `mini ${sym[key] === s ? 'active' : ''}`, title: `Use ${s}`,
        onclick: () => {
          if (Object.entries(sym).some(([k, v]) => k !== key && v === s)) return toast('Each kind of mark needs its own symbol.');
          m.setSymbols({ [key]: s });
        },
      }, s))))),
    h('div', { class: 'row-buttons' },
      h('button', { onclick: () => m.resetSymbols() }, `Back to the defaults (${m.DEFAULT_SYMBOLS.plus} ${m.DEFAULT_SYMBOLS.star} ${m.DEFAULT_SYMBOLS.minus})`)));
}

// A new version has been downloaded in the background: say so until it is
// used (Reload) or put off (✕) — a passing toast is too easy to miss.
function showUpdate() {
  const root = document.getElementById('update');
  root.replaceChildren(h('div', { class: 'update-banner', role: 'status' },
    h('span', 'A new version of Classbook is ready.'),
    h('button', { class: 'primary mini', onclick: () => location.reload() }, 'Reload'),
    h('button', { class: 'icon', 'aria-label': 'Later', title: 'Later', onclick: () => root.replaceChildren() }, '✕')));
}

// The preset reasons for a minus — shared by all devices.
function reasonsCard() {
  const reasons = m.minusReasons();
  const set = (list) => m.setMinusReasons(list);
  const add = h('input', { placeholder: 'e.g. Forgot the exercise book', dataset: { focusKey: 'reason-new' } });
  return h('div', { class: 'card' },
    h('h2', `Reasons for a ${m.symbols().minus} (minus)`),
    h('p', { class: 'muted' }, 'Offered as one-tap choices whenever you give a minus — a reason of your own can always be typed instead. The list is shared by all your devices.'),
    reasons.length ? h('ul', { class: 'list compact reason-list' }, reasons.map((r, i) => h('li',
      h('input', {
        class: 'grow', value: r, 'aria-label': 'Reason', dataset: { focusKey: `reason-${i}` },
        onchange: (e) => { const v = e.target.value.trim(); const next = m.minusReasons(); if (v) next[i] = v; else next.splice(i, 1); set(next); },
      }),
      // Each button reads the list as it is when clicked: an edit saved a moment ago is kept.
      h('button', { class: 'mini ghost', title: 'Up', disabled: i === 0, onclick: () => { const next = m.minusReasons(); [next[i - 1], next[i]] = [next[i], next[i - 1]]; set(next); } }, '↑'),
      h('button', { class: 'mini ghost', title: 'Down', disabled: i === reasons.length - 1, onclick: () => { const next = m.minusReasons(); [next[i + 1], next[i]] = [next[i], next[i + 1]]; set(next); } }, '↓'),
      h('button', { class: 'mini danger', title: 'Remove', onclick: () => set(m.minusReasons().filter((_, j) => j !== i)) }, '✕')))) : h('p', { class: 'muted' }, 'No presets — a reason can still be typed each time.'),
    h('form', {
      class: 'inline-form',
      onsubmit: (e) => {
        e.preventDefault();
        const v = add.value.trim();
        if (!v) return;
        const now = m.minusReasons();
        if (now.includes(v)) return toast('That reason is already in the list.');
        set([...now, v]);
        add.value = '';
      },
    }, add, h('button', { class: 'primary' }, 'Add')),
    h('button', { class: 'mini ghost', onclick: () => set(m.DEFAULT_MINUS_REASONS) }, 'Back to the defaults'));
}

// --- the reason panel ----------------------------------------------------------
//
// After a minus: the preset reasons as one-tap buttons, and a field for one of
// one's own. It never blocks — the minus is saved already; marking simply
// goes on, and the next minus takes the panel over.

const reasonRoot = document.getElementById('reason');
let reasonTimer = null;

function closeReason() {
  clearTimeout(reasonTimer);
  reasonRoot.replaceChildren();
}

function openReason(entryId, { undo = false } = {}) {
  const e = db.get('entries', entryId);
  if (!e) return closeReason();
  const s = db.get('students', e.studentId);
  const save = async (text) => {
    const cur = db.get('entries', entryId);
    if (cur) await db.patch('entries', entryId, { text: text.trim() });
    closeReason();
    if (text.trim()) toast(`Reason saved: ${text.trim()}`);
  };
  const own = h('input', {
    placeholder: 'Another reason…', value: e.text && !m.minusReasons().includes(e.text) ? e.text : '',
    autocomplete: 'off', enterkeyhint: 'done',
    onkeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); save(own.value); } if (ev.key === 'Escape') closeReason(); },
  });
  clearTimeout(reasonTimer);
  reasonRoot.replaceChildren(h('div', { class: 'reason-panel', role: 'dialog', 'aria-label': 'Reason for the minus' },
    h('div', { class: 'reason-head' },
      h('strong', { class: 'minus' }, symbolOf('minus')), ` for ${s ? (s.firstName || m.fullName(s)) : 'a student'} — why?`,
      h('span', { class: 'grow' }),
      undo ? h('button', { class: 'link', onclick: async () => { await db.remove('entries', entryId); closeReason(); toast('Minus taken back.'); } }, 'Undo') : null,
      h('button', { class: 'icon', 'aria-label': 'No reason', title: 'No reason', onclick: closeReason }, '✕')),
    h('div', { class: 'chips' }, m.minusReasons().map((r) => h('button', {
      class: `chip ${e.text === r ? 'active' : ''}`, onclick: () => save(r),
    }, r))),
    h('div', { class: 'inline-form' }, own, h('button', { class: 'primary', onclick: () => save(own.value) }, 'Save'),
      e.text ? h('button', { onclick: () => save('') }, 'No reason') : null)));
}

const TABLE_NAMES = {
  classes: 'classes', students: 'students', courses: 'courses', entries: 'marks and comments', absences: 'absences',
  years: 'school years', holidays: 'free days', cancellations: 'cancelled dates', extras: 'extra sessions', topics: 'topics', files: 'attached files', settings: 'settings',
  categories: 'grading categories', submissions: 'submissions', scores: 'points',
};

async function restoreBackup() {
  const picked = await pickJson();
  if (!picked) return;
  let plan;
  try {
    plan = m.planRestore(picked.doc);
  } catch (e) {
    toast(e.message);
    return;
  }
  const list = Object.entries(plan.counts).map(([t, n]) => `  ${n} ${TABLE_NAMES[t] || t}`).join('\n');
  const lines = [
    `${picked.name}`,
    '',
    plan.add.length ? `New here — will be added:\n${list}` : 'Nothing in it is missing here.',
    plan.same ? `${plan.same} already here, identical.` : '',
    plan.deleted ? `${plan.deleted} deleted since — stay deleted.` : '',
    plan.differ.length ? `${plan.differ.length} ${plan.differ.length === 1 ? 'exists' : 'exist'} here in a different version.` : '',
    plan.invalid ? `${plan.invalid} unreadable — skipped.` : '',
  ].filter(Boolean);
  if (!plan.add.length && !plan.differ.length) { alert(lines.join('\n')); return; }
  if (!confirm(`${lines.join('\n')}\n\nImport?`)) return;
  const replace = plan.differ.length > 0 && confirm(
    `${plan.differ.length === 1 ? '1 record exists' : `${plan.differ.length} records exist`} here in a different version (a changed name, a moved seat, an edited topic…).\n\n`
    + 'OK = replace them with the backup’s version\nCancel = keep the current version (recommended if you are not sure)');
  const n = await m.applyRestore(plan, replace);
  toast(`Imported ${n} ${n === 1 ? 'record' : 'records'}. ${isLocal ? 'The phone gets them at its next sync.' : 'They sync to your computer now.'}`);
  db.sync();
}

const revealLabel = (info) => ({ windows: 'Show in Explorer', linux: 'Show the folder' }[info?.host_os] || 'Show in Finder');

async function revealCa() {
  try {
    await db.authFetch('/api/reveal-ca', { method: 'POST' });
  } catch (e) {
    toast(e.message || 'Could not open the file manager.');
  }
}

// The phone this page runs on (for the phone's own Settings page).
const isAndroid = /Android/i.test(navigator.userAgent);
const thisPlatform = isAndroid ? 'android' : 'ios';
const PHONE = { ios: 'iPhone', android: 'Android phone' };

// Chrome on Android offers installing the app itself; the prompt is kept here
// so the phone's Settings page can show an "Install Classbook" button.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; hooks.render(); });
window.addEventListener('appinstalled', () => { installPrompt = null; hooks.render(); });

let setupInfo = null;   // the computer's details, fetched once per Settings visit

async function loadSetup(card) {
  try {
    const code = await db.getMeta('code');
    const r = await fetch('/api/info', { headers: { Authorization: `Bearer ${code}` } });
    const info = await r.json();
    if (!info.https_port) {
      card.replaceChildren(h('h2', 'Set up a phone'), h('p', 'The server was started with --no-https, so no phone can reach it. Restart with ./start.sh.'));
      return;
    }
    const pairing = (await (await fetch('/api/pair/local')).json()).code;
    setupInfo = { info, pairing };
    drawSetup(card);
  } catch {
    card.replaceChildren(h('h2', 'Set up a phone'), h('p', { class: 'error' }, 'Could not read the server’s details.'));
  }
}

// On the computer itself: the setup for an iPhone or an Android phone, switchable.
function drawSetup(card) {
  const { info, pairing } = setupInfo;
  const platform = prefs.get('setupPlatform', 'ios') === 'android' ? 'android' : 'ios';
  const local = `https://${info.bonjour}:${info.https_port}`;
  const byIp = info.addresses.map((a) => `https://${a}:${info.https_port}`);
  // Android only resolves .local names from version 12 on (and not always):
  // there the IP address is the safer choice — it stays put with a fixed address.
  const url = platform === 'android' && byIp.length ? byIp[0] : local;
  const phone = PHONE[platform];
  const switcher = h('div', { class: 'platforms', role: 'tablist' }, ['ios', 'android'].map((p) => h('button', {
    type: 'button', role: 'tab', class: p === platform ? 'active' : '', 'aria-selected': String(p === platform),
    onclick: () => { prefs.set('setupPlatform', p); drawSetup(card); },
  }, p === 'ios' ? 'iPhone' : 'Android')));

  const trust = platform === 'ios' ? [
    h('p', 'First get the certificate onto the iPhone — by AirDrop (the most reliable way) or with Safari:'),
    h('div', { class: 'setup-option' },
      h('strong', 'By AirDrop'),
      h('ol', { class: 'steps' },
        h('li', 'On this computer: ', h('button', { class: 'mini', onclick: revealCa }, revealLabel(info)), ' — or open ', h('code', info.airdrop_file), info.host_os === 'mac' ? ' in the Finder.' : '. (AirDrop needs a Mac — from Windows, use Safari below.)'),
        h('li', 'Right-click ', h('code', 'classbook-ca.cer'), ' → Share → AirDrop → your iPhone. Accept it on the iPhone.'))),
    h('div', { class: 'setup-option' },
      h('strong', 'Or with Safari'),
      h('p', 'On the iPhone, open ', h('code', `${url}/classbook-ca.crt`),
        ' — with the https://. Safari warns that the connection is not private: tap “Show Details” → “visit this website”, then allow the download. (If no download starts, use AirDrop.)')),
    h('p', 'Then, on the iPhone:'),
    h('ol', { class: 'steps' },
      h('li', 'Settings → General → ', h('strong', 'VPN & Device Management'), ' → under “Downloaded Profile”: ',
        h('em', 'classbook local CA'), ' → Install → passcode → Install. (Sometimes it also shows at the top of Settings as “Profile Downloaded”.)',
        h('br'), h('span', { class: 'muted' }, 'Do it within a few minutes: iOS drops a downloaded profile that is not installed after about 8 minutes — then send it again. If it is not listed, open the file in the Files app and tap it.')),
      h('li', 'Before installing, check under “More Details” that the SHA-256 fingerprint is the one shown below.'),
      h('li', 'Settings → General → About → ', h('strong', 'Certificate Trust Settings'), ' → switch on “classbook local CA”. It only appears there once the profile is installed.')),
    h('p', { class: 'muted' }, 'Without this step the page still opens, but iOS will not keep it for offline use.'),
  ] : [
    h('p', 'Use ', h('strong', 'Chrome'), ' on the phone (it trusts certificates you install; Firefox does not by default). The phone needs a screen lock (PIN, pattern or password) — Android asks for one before it installs a certificate.'),
    h('div', { class: 'setup-option' },
      h('strong', 'Download the certificate'),
      h('p', 'In Chrome on the phone, open ', h('code', `${url}/classbook-ca.crt`),
        ' — with the https://. Chrome warns “Your connection is not private”: tap “Advanced” → “Proceed”. The file lands in Downloads.'),
      h('p', { class: 'muted' }, 'Or copy ', h('code', info.airdrop_file), ' to the phone’s Download folder with a USB cable (', h('button', { class: 'mini', onclick: revealCa }, revealLabel(info)), ').')),
    h('p', 'Then install it — not by tapping the file (Android refuses that for this kind of certificate), but in Settings:'),
    h('ol', { class: 'steps' },
      h('li', 'Settings → ', h('strong', 'Security & privacy'), ' → More security settings → ', h('strong', 'Encryption & credentials'), ' → ',
        h('strong', 'Install a certificate'), ' → ', h('strong', 'CA certificate'), ' → “Install anyway” → choose ', h('code', 'classbook-ca.crt'), ' in Downloads.',
        h('br'), h('span', { class: 'muted' }, 'The menu names differ a little between makers (Samsung: Security and privacy → Other security settings → Install from device storage). Searching Settings for “CA certificate” finds it.')),
      h('li', 'Check: Encryption & credentials → ', h('strong', 'Trusted credentials'), ' → tab ', h('strong', 'User'), ': “classbook local CA” is listed. Tap it: the SHA-256 fingerprint must be the one shown below.')),
    h('p', { class: 'muted' }, 'Without this step the page still opens, but Chrome will not keep it for offline use.'),
  ];

  // Optional lines are null: left out, not shown as text.
  card.replaceChildren(...[
    h('h2', 'Set up a phone'),
    switcher,
    h('p', { class: 'muted' }, `Once per phone. The ${phone} and this computer must be on the same network${platform === 'ios' ? ' — or connect this computer to the iPhone’s Personal Hotspot' : ' — or connect this computer to the phone’s hotspot'}.`),
    h('h3', { class: 'step-title' }, '1 · Trust this computer’s certificate'),
    ...trust,
    h('h3', { class: 'step-title' }, '2 · Install Classbook as an app (for offline use)'),
    installSteps(url, platform),
    platform === 'android' ? h('p', { class: 'muted' }, `Use the same address every time — ${url} — the phone keeps its data per address. ${byIp.length ? `${local} works too on newer Android versions; keep this computer’s IP address fixed in the router either way.` : ''}`) : null,
    h('h3', { class: 'step-title' }, '3 · Pair'),
    h('ol', { class: 'steps' },
      h('li', `Open Classbook from the home screen — not from ${platform === 'ios' ? 'Safari' : 'a Chrome tab'}: the app keeps its own data.`),
      h('li', 'Enter the pairing code:', h('div', { class: 'code' }, pairing)),
      h('li', 'Wait until the pill at the top says “Synced”: the phone now has its own copy of every class.')),
    h('h3', { class: 'step-title' }, '4 · Check that it works offline'),
    h('ol', { class: 'steps' },
      h('li', `Switch on ${platform === 'ios' ? 'Airplane Mode' : 'Aeroplane mode'} and open Classbook from the home screen. It opens, with all classes, and the pill says “Offline”.`),
      h('li', 'Give a mark and switch it off again: the pill shows “1 to send”, then “Synced”, and the mark appears on this computer.')),
    h('p', { class: 'muted' }, 'Settings in the app on the phone shows whether it is installed and ready for offline use.'),
    h('p', { class: 'muted' }, 'CA fingerprint (SHA-256), shown on the phone in the certificate’s details:'),
    h('p', h('code', { class: 'fp' }, info.ca_fingerprint || '—')),
    platform === 'ios' && byIp.length ? h('p', { class: 'muted' }, `Also reachable at ${byIp.join(', ')} — but use the .local name: it stays the same on every network, and the phone keeps its data per address.`) : null,
    h('p', { class: 'muted' }, `Data folder on this computer: ${info.data_dir}`),
    h('h3', { class: 'step-title' }, `If the ${phone} stops syncing`),
    h('p', { class: 'muted' }, 'The app says “Offline” although this computer is on — check, in this order:'),
    ...stuckChecklist(url, platform === 'ios' ? byIp : [local], platform),
  ].filter(Boolean));
}

// How to put the page on the home screen. Only an app opened from there is
// kept for good; a browser tab's data can be cleared after some weeks unused.
function installSteps(url, platform = thisPlatform) {
  if (platform === 'android') {
    return h('ol', { class: 'steps' },
      h('li', 'Open ', h('code', url), ' in Chrome. After step 1 there is no warning any more.'),
      h('li', 'Tap the menu ⋮ (top right) → ', h('strong', 'Install app'), ' — on some phones “Add to Home screen” → Install.'),
      h('li', 'Confirm. The blue +/− icon appears on the home screen and in the app drawer.'),
      h('li', 'From now on, always open Classbook with that icon. It opens full-screen like an app, and works without a network.'));
  }
  return h('ol', { class: 'steps' },
    h('li', 'Open ', h('code', url), ' in Safari. After step 1 there is no warning any more.'),
    h('li', 'Tap the Share button (the square with the arrow pointing up) — at the bottom of the screen, or behind “⋯” next to the address bar.'),
    h('li', 'Scroll down and tap “Add to Home Screen”. If there is an “Open as Web App” switch, leave it on.'),
    h('li', 'Keep the name “Classbook” and tap “Add”. The blue +/− icon appears on your home screen.'),
    h('li', 'From now on, always open Classbook with that icon. It opens full-screen without the address bar, and works without a network.'));
}

// When the phone no longer syncs although the computer is running. `origin` is the
// address the phone uses; `others` the alternatives worth trying.
function stuckChecklist(origin, others = [], platform = thisPlatform) {
  const android = platform === 'android';
  const browser = android ? 'Chrome' : 'Safari';
  return [
    h('ol', { class: 'steps' },
      android
        ? h('li', h('strong', 'Certificate still installed?'), ' Settings → Security & privacy → More security settings → Encryption & credentials → ',
          h('strong', 'Trusted credentials'), ' → tab ', h('strong', 'User'), ': ', h('em', 'classbook local CA'),
          ' must be listed (and not switched off there). If it is missing, install it again (step 1 of the setup) — Android removes user certificates when the screen lock is switched off.')
        : h('li', h('strong', 'Certificate still trusted?'), ' iPhone Settings → General → About → ',
          h('strong', 'Certificate Trust Settings'), ': ', h('em', 'classbook local CA'),
          ' must be listed and ', h('strong', 'switched on'), '. iOS sometimes switches it off again (after an update, for example) — then the app only says “Offline”. ',
          'If it is not listed at all, install it again (step 1 of the setup: AirDrop is easiest).'),
      h('li', h('strong', 'Classbook running on your computer?'), ' ', h('code', './start.sh'), ' (Windows: ', h('code', 'start.bat'), ') — and the computer awake, not asleep.'),
      h('li', h('strong', 'Same network?'), ` ${android ? 'Phone' : 'iPhone'} and your computer on the same Wi-Fi — not a guest network, which keeps devices apart. Or the computer on the phone’s hotspot.`),
      android ? h('li', h('strong', 'The address:'), ' if the app was installed from a ', h('code', '….local'), ' address and the phone cannot resolve it (Android before version 12, or some networks), install it again from your computer’s IP address.') : null,
      h('li', h('strong', 'Test the connection:'), ' open ', h('code', `${origin}/api/pair/local`), ` in ${browser} on the phone`,
        others.length ? [' — or ', others.map((o, i) => [i ? ' / ' : '', h('code', `${o}/api/pair/local`)]), ', whichever the app was installed from'] : null, '.',
        h('ul', { class: 'plain-bullets' },
          h('li', 'A short text “Only a browser on this computer itself…” — the connection works; tap the pill in the app to sync.'),
          h('li', `“${android ? 'Your connection is not private' : 'This Connection Is Not Private'}” — the certificate is not trusted: see 1.`),
          h('li', `“${android ? 'This site can’t be reached' : 'Safari can’t connect'}” — the phone does not reach your computer: see 2 and 3${android ? ' (and 4)' : ''}.`)))),
  ];
}

// On the phone: is this the installed app, and can it open without a network?
function deviceCard() {
  const installed = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const offline = !!navigator.serviceWorker?.controller;
  const persisted = h('span', { class: 'muted' }, '…');
  navigator.storage?.persisted?.().then((p) => { persisted.textContent = p ? 'yes' : 'not confirmed by the browser'; }).catch(() => { persisted.textContent = 'unknown'; });
  const check = (ok, yes, no) => h('li', { class: ok ? 'ok' : 'no' }, h('span', { class: 'mark' }, ok ? '✓' : '✕'), ok ? yes : no);
  return h('div', { class: 'card' },
    h('h2', 'This device'),
    h('ul', { class: 'checks' },
      check(installed, 'Opened as the installed app', 'Opened in the browser, not as the installed app'),
      check(offline, 'Ready to open without a network', 'Not ready for offline use yet'),
      h('li', h('span', { class: 'mark' }, '·'), h('span', 'Data kept permanently: ', persisted))),
    !offline && h('p', { class: 'muted' }, 'Offline use needs your computer’s certificate to be trusted (see the setup under Settings in the browser on your computer) and the app to have been opened once while connected. Reopen the app after that.'),
    installed ? h('p', 'Marks you give without a connection are kept here and sent to your computer when it can be reached.')
      : [h('h3', { class: 'step-title' }, 'Install it as an app'),
        installPrompt ? h('p', h('button', {
          class: 'primary',
          onclick: async () => {
            const prompt = installPrompt;
            installPrompt = null;
            await prompt.prompt();
            const { outcome } = await prompt.userChoice;
            toast(outcome === 'accepted' ? 'Installed — open Classbook from its icon from now on.' : 'Not installed.');
            hooks.render();
          },
        }, 'Install Classbook')) : null,
        installSteps(location.origin)],
    h('details', { class: 'stuck', open: db.status.state === 'offline' },
      h('summary', 'If this device stops syncing'),
      stuckChecklist(location.origin)));
}

function pairScreen() {
  const input = h('input', { placeholder: 'XXXX-XXXX-XX', autocapitalize: 'characters', autocomplete: 'off', spellcheck: false, class: 'code-input', required: true });
  const msg = h('p', { class: 'error' });
  return page('Pair with your computer', { href: '/', label: 'Classes' },
    h('form', {
      class: 'card form',
      onsubmit: async (e) => {
        e.preventDefault();
        msg.textContent = '';
        const code = input.value.trim();
        try {
          await db.checkCode(code);
          await db.setMeta('code', code);
          await db.sync();
          toast('Paired. Everything is syncing.');
          go('/');
        } catch (err) {
          msg.textContent = err.status ? err.message : 'Your computer is not reachable. Is Classbook running there, and are you on the same network?';
        }
      },
    },
    h('p', 'The pairing code is shown when Classbook starts on your computer, and under Settings in the browser there.'),
    input, msg, h('button', { class: 'primary' }, 'Pair')));
}

// --- start -------------------------------------------------------------------

// On the computer itself the server hands over the pairing code; nothing to type.
// Only asked in a browser on that computer (a phone always gets "no"), and never
// waited on for long: on a network where the server cannot be reached a
// request does not fail, it stalls.
async function askForLocalCode() {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch('/api/pair/local', { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) return false;
    const { code } = await r.json();
    if (code !== await db.getMeta('code')) await db.setMeta('code', code);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function start() {
  await db.open();

  hooks.render = render;
  db.onChange((what) => (what === 'status' ? updateStatus() : what === 'remote' ? refresh() : render()));
  window.addEventListener('hashchange', () => { closeReason(); if (ui.sheet) closeSheet(); ui.selected = null; pv.resetPlanUi(); render(); });
  window.addEventListener('online', () => db.sync());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    db.sync();
    // An app that sat in the background never reloads: ask for a new version now.
    navigator.serviceWorker?.controller?.postMessage('check-update');
  });
  setInterval(() => { if (document.visibilityState === 'visible') db.sync(); }, 20000);

  // Everything on screen comes from this device's own copy: draw it now,
  // before anything that involves the network.
  const paired = !!(await db.getMeta('code'));
  if (paired || location.hash.startsWith('#/pair')) render();

  isLocal = await askForLocalCode();
  if (!(await db.getMeta('code')) && !location.hash.startsWith('#/pair')) location.hash = '#/pair';
  else if (isLocal || !paired) render();   // the computer's own extras (Settings), or first start
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  db.sync();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('No offline mode:', e));
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data === 'updated') showUpdate();
    });
  }
}

start();
