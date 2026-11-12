// Quizmaster single-page app: routing, quizzes and practice views.
import { h, api, toast, guard, modal, confirmDialog, shuffle } from "./util.js";
import { renderQuestion, typeBadge, TYPE_LABELS, usageBadge, usageClass } from "./render.js";
import { openEditor } from "./editor.js";
import { store } from "./store.js";
import { catalogView, pickQuestions, importDialog, importFilesDialog, download } from "./catalog.js";

const app = document.getElementById("app");
let types = [];

// ------------------------------------------------------------------ routing

async function route() {
  const [view, id, sub] = location.hash.replace(/^#\/?/, "").split("/");
  for (const a of document.querySelectorAll(".nav a")) a.classList.toggle("active", a.dataset.view === (view === "quiz" ? "quizzes" : view || "catalog"));
  window.scrollTo(0, 0);
  onPageDrop = null;
  if (!types.length) types = await api("GET", "/api/types");
  if (view === "quiz" && id) await guard(() => (sub === "practice" ? practiceView(+id) : quizView(+id)));
  else if (view === "quizzes") await guard(() => quizzesView(id === "archived"));
  else await guard(() => catalogView(app, types, (fn) => { onPageDrop = fn; }));
}
window.addEventListener("hashchange", route);

// One page-wide drop target for XML files; each view decides what happens with them.
let onPageDrop = null;
(() => {
  let depth = 0;
  const body = document.body;
  const isFiles = (e) => e.dataTransfer?.types.includes("Files");
  body.addEventListener("dragenter", (e) => { if (isFiles(e) && onPageDrop) { depth++; body.classList.add("file-over"); } });
  body.addEventListener("dragleave", (e) => { if (isFiles(e)) { depth = Math.max(0, depth - 1); if (!depth) body.classList.remove("file-over"); } });
  body.addEventListener("dragover", (e) => { if (isFiles(e) && onPageDrop) e.preventDefault(); });
  body.addEventListener("drop", (e) => {
    depth = 0;
    body.classList.remove("file-over");
    if (!isFiles(e) || !onPageDrop) return;
    e.preventDefault();
    const files = [...e.dataTransfer.files].filter((f) => /\.xml$/i.test(f.name));
    if (!files.length) { toast("Only Moodle XML (.xml) files can be imported", "error"); return; }
    guard(() => onPageDrop(files));
  });
})();

// Close open menus when clicking elsewhere.
document.addEventListener("click", (e) => {
  for (const m of document.querySelectorAll(".menu:not(.hidden)")) if (!m.parentElement.contains(e.target)) m.classList.add("hidden");
}, { capture: true });

route();

const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const fmtPts = (p) => (Math.round(Number(p) * 100) / 100).toString();

function menu(label, items, cls = "") {
  const m = h("div", { class: "menu hidden" }, items.filter(Boolean).map(([text, fn]) => h("button", { onclick: () => { m.classList.add("hidden"); guard(fn); } }, text)));
  return h("div", { class: "menu-wrap" }, h("button", { class: cls, onclick: () => m.classList.toggle("hidden") }, label), m);
}

// ------------------------------------------------------------------ PDF

/** opts: optional { language, show_points } overriding the quiz's saved PDF settings. */
async function openPdf(quizId, answers, opts = {}) {
  const win = window.open("", "_blank");  // before any await, so the browser does not block the pop-up
  if (win) win.document.write("<p style='font:16px system-ui;padding:24px'>Compiling PDF with LaTeX…</p>");
  toast("Compiling PDF…");
  const query = new URLSearchParams({ answers: answers ? 1 : 0 });
  for (const [k, v] of Object.entries(opts)) query.set(k, String(v));
  const res = await fetch(`/api/quizzes/${quizId}/exam.pdf?${query}`);
  if (!res.ok) {
    win?.close();
    let detail = res.statusText, log = "";
    try { const j = await res.json(); detail = j.detail; log = j.log || ""; } catch { /* ignore */ }
    const m = modal({
      title: "PDF export failed",
      body: h("div", {}, h("p", { class: "errors" }, detail), log && h("details", {}, h("summary", {}, "LaTeX log (end)"), h("pre", { class: "log" }, log))),
      footer: [h("button", { onclick: () => download(`/api/quizzes/${quizId}/exam.zip?${query}`) }, "⬇ Download LaTeX source"), h("button", { class: "primary", onclick: () => m.close() }, "Close")],
    });
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  if (win) win.location.href = url;
  else window.open(url, "_blank");
}

let latexInfo = null;

/** Quick export dialog: version, language and points; the choices are remembered for the quiz. */
async function pdfExportDialog(quizOrId, answers = false) {
  const quiz = typeof quizOrId === "number" ? await api("GET", `/api/quizzes/${quizOrId}`) : quizOrId;
  latexInfo ||= await api("GET", "/api/latex/info");
  const s = { ...latexInfo.defaults, ...(quiz.settings.latex || {}) };
  const name = `pdfver${quiz.id}`;
  const exam = h("input", { type: "radio", name, checked: !answers });
  const key = h("input", { type: "radio", name, checked: answers });
  const language = h("select", {}, [["en", "English"], ["de", "Deutsch"]].map(([v, l]) => h("option", { value: v, selected: s.language === v }, l)));
  const points = h("input", { type: "checkbox", checked: s.show_points !== false });
  const opts = () => ({ language: language.value, show_points: points.checked });
  const remember = () => {
    quiz.settings = { ...quiz.settings, latex: { ...(quiz.settings.latex || {}), ...opts() } };
    return api("PUT", `/api/quizzes/${quiz.id}`, { settings: quiz.settings });
  };
  const field = (label, ...els) => h("div", { class: "field" }, h("label", {}, label), ...els);
  const m = modal({
    title: `PDF export · ${quiz.name}`, narrow: true,
    body: h("div", {},
      field("Version", h("label", { class: "check" }, exam, "Exam"), h("label", { class: "check" }, key, "Answer key (solutions in red)")),
      field("Language", language),
      field("Points", h("label", { class: "check" }, points, "Show points per question and the grade table"))),
    footer: [
      h("button", { onclick: () => { m.close(); guard(async () => { await remember(); pdfSettingsDialog(quiz); }); } }, "⚙ All settings…"),
      h("button", { onclick: () => { download(`/api/quizzes/${quiz.id}/exam.zip?${new URLSearchParams(opts())}`); guard(remember); } }, "⬇ LaTeX"),
      h("span", { class: "spacer" }),
      h("button", { onclick: () => m.close() }, "Cancel"),
      h("button", { class: "primary", onclick: () => { guard(() => openPdf(quiz.id, key.checked, opts())); guard(remember); m.close(); } }, "Create PDF"),
    ],
  });
}

async function pdfSettingsDialog(quiz) {
  latexInfo ||= await api("GET", "/api/latex/info");
  const s = { ...latexInfo.defaults, ...(quiz.settings.latex || {}) };
  const text = (k, ph = "") => h("input", { type: "text", value: s[k], placeholder: ph, style: { width: "100%" } });
  const select = (k, opts) => h("select", {}, Object.entries(opts).map(([v, l]) => h("option", { value: v, selected: String(s[k]) === v }, l)));
  const check = (k) => h("input", { type: "checkbox", checked: !!s[k] });
  const engines = Object.fromEntries(["pdflatex", "xelatex", "lualatex"].map((e) => [e, e + (latexInfo.engines[e] ? "" : " (not installed)")]));
  const f = {
    title: text("title", quiz.name), subtitle: text("subtitle", "e.g. 2A · Networking"), date: text("date", "e.g. 14.10.2026"),
    instructions: h("textarea", { value: s.instructions, placeholder: "Instructions printed below the header" }),
    language: select("language", { en: "English", de: "Deutsch" }),
    font_size: select("font_size", { "10pt": "10 pt", "11pt": "11 pt", "12pt": "12 pt" }),
    engine: select("engine", engines),
    gradetable: select("gradetable", { auto: "Automatic (≤ 12 questions)", h: "Horizontal", v: "Vertical", none: "None" }),
    answerline_width: text("answerline_width"),
    name_fields: check("name_fields"), show_points: check("show_points"), shuffle_choices: check("shuffle_choices"), feedback_in_key: check("feedback_in_key"),
  };
  const field = (label, el) => h("div", { class: "field" }, h("label", {}, label), el);
  const collect = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.type === "checkbox" ? el.checked : el.value]));
  const save = async () => {
    quiz.settings = { ...quiz.settings, latex: collect() };
    await api("PUT", `/api/quizzes/${quiz.id}`, { settings: quiz.settings });
    toast("PDF settings saved");
  };
  const m = modal({
    title: "PDF settings (exam class)",
    body: h("div", {},
      h("div", { class: "grid-4" }, field("Title", f.title), field("Subtitle", f.subtitle), field("Date", f.date)),
      field("Instructions", f.instructions),
      h("div", { class: "grid-4" }, field("Language", f.language), field("Font size", f.font_size), field("Grade table", f.gradetable), field("LaTeX engine", f.engine), field("Answer line width", f.answerline_width)),
      h("div", { class: "field" },
        h("label", { class: "check" }, f.name_fields, "Name / class / date fields"),
        h("label", { class: "check" }, f.show_points, "Show points per question and the grade table"),
        h("label", { class: "check" }, f.shuffle_choices, "Shuffle answer options (except questions with shuffling turned off; same order in exam and key)"),
        h("label", { class: "check" }, f.feedback_in_key, "Print general feedback in the answer key"))),
    footer: [
      h("button", { onclick: () => m.close() }, "Cancel"),
      h("button", { onclick: () => guard(async () => { await save(); openPdf(quiz.id, false); }) }, "Save & preview"),
      h("button", { class: "primary", onclick: () => guard(async () => { await save(); m.close(); }) }, "Save"),
    ],
  });
}

// ------------------------------------------------------------------ quizzes list

async function setArchived(quiz, archived) {
  await api("POST", `/api/quizzes/${quiz.id}/archive`, { archived });
  toast(archived ? `"${quiz.name}" archived` : `"${quiz.name}" restored to the quiz list`);
}

/** The quiz list; archived quizzes are only shown at #/quizzes/archived. */
async function quizzesView(showArchived = false) {
  document.title = (showArchived ? "Archived quizzes" : "Quizzes") + " · Quizmaster";
  const all = await api("GET", "/api/quizzes");
  const quizzes = all.filter((z) => z.archived === showArchived);
  const archivedCount = all.filter((z) => z.archived).length;
  const reload = () => quizzesView(showArchived);
  const newQuiz = async () => {
    const quiz = await api("POST", "/api/quizzes", { name: "New quiz" });
    location.hash = `#/quiz/${quiz.id}`;
  };
  const doImport = async (files) => {
    await store.load();
    const res = files ? await importFilesDialog(files) : await importDialog();
    if (res?.quizzes.length === 1) location.hash = `#/quiz/${res.quizzes[0]}`;
    else if (res) quizzesView();
  };
  onPageDrop = showArchived ? null : doImport;

  const filter = h("input", { type: "search", placeholder: "Search quizzes…", style: { minWidth: "220px" } });
  const grid = h("div", { class: "quiz-grid" });
  const draw = () => {
    const term = filter.value.toLowerCase();
    grid.replaceChildren();
    for (const quiz of quizzes.filter((z) => z.name.toLowerCase().includes(term))) {
      const stop = (fn) => (e) => { e.stopPropagation(); guard(fn); };
      const archiveBtn = showArchived
        ? h("button", { class: "primary", title: "Move back to the quiz list", onclick: stop(async () => { await setArchived(quiz, false); reload(); }) }, "↩ Unarchive")
        : h("button", { title: "Hide from the quiz list (can be restored from the archive)", onclick: stop(async () => { await setArchived(quiz, true); reload(); }) }, "🗄 Archive");
      grid.append(h("div", { class: "card quiz-card" + (showArchived ? " archived" : ""), onclick: () => { location.hash = `#/quiz/${quiz.id}`; } },
        h("h2", {}, quiz.name, showArchived ? h("span", { class: "tag", style: { marginLeft: "8px", verticalAlign: "middle" } }, "archived") : null),
        quiz.description && h("div", { class: "cat" }, quiz.description),
        h("div", { class: "muted small" }, `${quiz.question_count} question${quiz.question_count === 1 ? "" : "s"} · ${fmtPts(quiz.points)} points · updated ${fmtDate(quiz.updated)}`),
        h("div", { class: "actions" },
          !showArchived && h("button", { onclick: stop(() => { location.hash = `#/quiz/${quiz.id}/practice`; }) }, "▶ Practice"),
          h("button", { onclick: stop(() => pdfExportDialog(quiz.id)) }, "📄 PDF"),
          h("button", { onclick: stop(() => download(`/api/quizzes/${quiz.id}/export.xml`)) }, "⬇ XML"),
          !showArchived && h("button", { onclick: stop(async () => { await api("POST", `/api/quizzes/${quiz.id}/duplicate`); toast("Quiz duplicated"); reload(); }) }, "Duplicate"),
          archiveBtn,
          h("button", { class: "danger", onclick: stop(async () => {
            if (!(await confirmDialog(`Delete quiz "${quiz.name}"? Its questions stay in the catalog.`))) return;
            await api("DELETE", `/api/quizzes/${quiz.id}`);
            reload();
          }) }, "Delete"))));
    }
    if (!grid.childNodes.length) {
      const empty = showArchived ? "No archived quizzes." : all.length && !quizzes.length ? "All quizzes are archived." : "No quizzes yet. Create one, or select questions in the catalog and choose \"Add to quiz…\".";
      grid.append(h("div", { class: "empty", style: { gridColumn: "1 / -1" } }, quizzes.length ? "No quiz matches." : empty));
    }
  };
  filter.addEventListener("input", draw);
  draw();

  if (showArchived) {
    app.replaceChildren(
      h("div", { style: { marginBottom: "10px" } }, h("a", { href: "#/quizzes" }, "← Quizzes")),
      h("div", { class: "row" }, h("h1", { style: { margin: 0 } }, "🗄 Archived quizzes"), h("span", { class: "spacer" }), filter),
      h("p", { class: "muted small" }, "Archived quizzes are hidden from the quiz list. Their questions stay in the catalog. Use \"↩ Unarchive\" to bring a quiz back."),
      grid);
    return;
  }
  app.replaceChildren(
    h("div", { class: "row" }, h("h1", { style: { margin: 0 } }, "Quizzes"), h("span", { class: "spacer" }), filter,
      h("button", { onclick: () => guard(() => doImport(null)) }, "⬆ Import Moodle XML"),
      h("button", { class: "primary", onclick: () => guard(newQuiz) }, "+ New quiz")),
    grid,
    h("div", { class: "archive-link" }, h("a", { href: "#/quizzes/archived" }, `🗄 Archived quizzes (${archivedCount})`)));
}

// ------------------------------------------------------------------ quiz composer

const expandedItems = new Set();

async function quizView(quizId) {
  let quiz = await api("GET", `/api/quizzes/${quizId}`);
  await store.load();
  document.title = `${quiz.name} · Quizmaster`;

  const saveMeta = (fields) => guard(async () => { await api("PUT", `/api/quizzes/${quizId}`, fields); Object.assign(quiz, fields); document.title = `${quiz.name} · Quizmaster`; });
  const title = h("input", { type: "text", class: "quiz-title-input", value: quiz.name, onchange: () => saveMeta({ name: title.value.trim() || "Untitled quiz" }) });
  const description = h("textarea", { value: quiz.description, placeholder: "Notes about this quiz", onchange: () => saveMeta({ description: description.value }) });
  const list = h("div", { class: "qlist with-gaps" });
  const stats = h("span", { class: "stats" });
  // Full questions for the expanded previews, fetched in batches and cached until the next reload.
  const fullCache = new Map();
  const loadFull = async (ids) => {
    const missing = ids.filter((id) => !fullCache.has(id));
    for (let i = 0; i < missing.length; i += 50) {
      for (const q of await api("POST", "/api/questions/full", { ids: missing.slice(i, i + 50) })) fullCache.set(q.id, q);
    }
  };
  const expandBtn = h("button", { title: "Show all questions in full, with their answers", onclick: () => guard(async () => {
    const ids = quiz.items.map((it) => it.question.id);
    if (ids.length && ids.every((id) => expandedItems.has(id))) {
      ids.forEach((id) => expandedItems.delete(id));
    } else {
      expandBtn.disabled = true;
      expandBtn.textContent = "Loading…";
      try { await loadFull(ids); } finally { expandBtn.disabled = false; }
      ids.forEach((id) => expandedItems.add(id));
    }
    draw();
  }) });

  const reload = async () => { fullCache.clear(); quiz = await api("GET", `/api/quizzes/${quizId}`); await store.load(); draw(); };
  const inQuiz = () => new Set(quiz.items.map((it) => it.question.id));

  /** beforeItemId: insert before this question/section (null = at the end). */
  async function addFromCatalog(beforeItemId = null) {
    const ids = await pickQuestions(inQuiz(), `Add questions to "${quiz.name}"`);
    if (!ids.length) return;
    const r = await api("POST", `/api/quizzes/${quizId}/items`, { question_ids: ids, before_item_id: beforeItemId });
    quiz = r.quiz;
    toast(`${r.added} question(s) added`);
    draw();
  }

  async function newQuestion(type, beforeItemId = null) {
    const template = await api("GET", `/api/types/${type}/new`);
    // Default category: where most of this quiz's questions live.
    const freq = {};
    for (const it of quiz.items) freq[it.question.category_id] = (freq[it.question.category_id] || 0) + 1;
    const common = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0];
    const saved = await openEditor(template, { quizId, beforeItemId, categoryId: common ? +common : null });
    if (saved) { expandedItems.add(saved.id); await reload(); }
  }

  // Questions and section headings in quiz order (they share one position sequence).
  const entries = () => [
    ...quiz.items.map((it) => ({ kind: "question", item_id: it.item_id, position: it.position, it })),
    ...(quiz.sections || []).map((sec) => ({ kind: "section", item_id: sec.item_id, position: sec.position, sec })),
  ].sort((a, b) => a.position - b.position || a.item_id - b.item_id);

  let focusSection = null;
  async function addSection(beforeItemId = null) {
    const r = await api("POST", `/api/quizzes/${quizId}/sections`, { name: "", visible: true, before_item_id: beforeItemId });
    quiz = r.quiz;
    focusSection = r.item_id;
    draw();
  }

  async function saveOrder(itemIds) {
    quiz = await api("POST", `/api/quizzes/${quizId}/reorder`, { item_ids: itemIds });
    draw();
  }

  let dragItem = null;
  function makeDraggable(card, handle, itemId) {
    handle.addEventListener("mousedown", () => { card.draggable = true; });
    handle.addEventListener("click", (e) => e.stopPropagation());
    card.addEventListener("dragstart", (e) => { dragItem = itemId; card.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/x-item", String(itemId)); });
    card.addEventListener("dragend", () => { card.draggable = false; card.classList.remove("dragging"); dragItem = null; });
    card.addEventListener("dragover", (e) => {
      if (!dragItem || dragItem === itemId) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      card.classList.toggle("drop-after", after);
      card.classList.toggle("drop-before", !after);
    });
    card.addEventListener("dragleave", () => card.classList.remove("drop-after", "drop-before"));
    card.addEventListener("drop", (e) => {
      if (!dragItem) return;
      e.preventDefault();
      const after = card.classList.contains("drop-after");
      card.classList.remove("drop-after", "drop-before");
      const ids = entries().map((x) => x.item_id).filter((id) => id !== dragItem);
      ids.splice(ids.indexOf(itemId) + (after ? 1 : 0), 0, dragItem);
      guard(() => saveOrder(ids));
    });
  }

  const moveButtons = (index, total) => [
    h("button", { class: "icon", title: "Move up", disabled: index === 0, onclick: (e) => { e.stopPropagation(); guard(() => move(index, -1)); } }, "↑"),
    h("button", { class: "icon", title: "Move down", disabled: index === total - 1, onclick: (e) => { e.stopPropagation(); guard(() => move(index, 1)); } }, "↓"),
  ];

  function sectionCard(sec, index, total) {
    const saveSection = (fields) => guard(async () => { quiz = await api("PUT", `/api/quizzes/${quizId}/items/${sec.item_id}`, fields); });
    const name = h("input", { type: "text", class: "section-name", value: sec.name, placeholder: "Section name",
      onchange: () => saveSection({ name: name.value.trim() }) });
    const visible = h("input", { type: "checkbox", checked: sec.visible,
      onchange: () => { card.classList.toggle("out-hidden", !visible.checked); saveSection({ visible: visible.checked }); } });
    const handle = h("span", { class: "handle", title: "Drag to reorder" }, "⋮⋮");
    const card = h("div", { class: "card scard" + (sec.visible ? "" : " out-hidden") },
      handle,
      h("span", { class: "section-mark", title: "Section" }, "§"),
      name,
      h("label", { class: "check small", title: "Print this heading in the PDF and show it in practice mode" }, visible, "Show in output"),
      h("div", { class: "qactions" },
        ...moveButtons(index, total),
        h("button", { class: "icon danger", title: "Delete section (the questions stay)", onclick: () => guard(async () => {
          quiz = await api("POST", `/api/quizzes/${quizId}/items/remove`, { item_ids: [sec.item_id] });
          draw();
        }) }, "✕")));
    makeDraggable(card, handle, sec.item_id);
    if (focusSection === sec.item_id) { focusSection = null; requestAnimationFrame(() => name.focus()); }
    return card;
  }

  /** Thin insertion bar between entries (shown on hover): add a question or a section at this place. */
  const gap = (beforeItemId) => h("div", { class: "insert-gap" },
    h("button", { title: "Add questions from the catalog here", onclick: () => guard(() => addFromCatalog(beforeItemId)) }, "+ From catalog"),
    menu("+ New question ▾", types.map((t) => [h("span", {}, typeBadge(t.type), t.label), () => newQuestion(t.type, beforeItemId)])),
    h("button", { title: "Insert a section heading here", onclick: () => guard(() => addSection(beforeItemId)) }, "+ Section"));

  function itemCard(it, index, entryIndex, total) {
    const q = it.question;
    const isOpen = expandedItems.has(q.id);
    const stop = (fn) => (e) => { e.stopPropagation(); guard(fn); };
    const points = h("input", {
      type: "number", min: 0, step: "any", class: "points-input", value: it.points_override ?? "", placeholder: fmtPts(q.defaultgrade ?? 1),
      title: "Points in this quiz (empty = question default)", onclick: (e) => e.stopPropagation(),
      onchange: () => guard(async () => { quiz = await api("PUT", `/api/quizzes/${quizId}/items/${it.item_id}`, { points: points.value === "" ? null : Number(points.value) }); drawStats(); }),
    });
    const handle = h("span", { class: "handle", title: "Drag to reorder" }, "⋮⋮");
    const card = h("div", { class: "card qcard" + usageClass(q) });
    card.append(h("div", { class: "qcard-head", onclick: () => { isOpen ? expandedItems.delete(q.id) : expandedItems.add(q.id); draw(); } },
      handle,
      h("span", { class: "qnum" }, index + 1),
      h("div", { class: "qmain" },
        h("div", {}, typeBadge(q.type), h("span", { class: "qtitle" }, q.name || "(no name)"), " ", (q.tags || []).map((t) => h("span", { class: "tag" }, t)),
          usageBadge(q)),
        h("div", { class: "qpath" }, store.pathString(q.category_id)),
        !isOpen && h("div", { class: "qsnippet" }, q.snippet)),
      h("label", { class: "points-label", onclick: (e) => e.stopPropagation() }, points, "pt"),
      h("div", { class: "qactions" },
        q.type in TYPE_LABELS && h("button", { onclick: stop(async () => { if (await openEditor(await api("GET", `/api/questions/${q.id}`), { quizId })) await reload(); }) }, "✎ Edit"),
        ...moveButtons(entryIndex, total),
        h("button", { class: "icon danger", title: "Remove from quiz (stays in the catalog)", onclick: stop(async () => {
          quiz = await api("POST", `/api/quizzes/${quizId}/items/remove`, { item_ids: [it.item_id] });
          draw();
        }) }, "✕"))));
    if (isOpen) {
      const body = h("div", { class: "qcard-body muted" }, "Loading…");
      card.append(body);
      const show = (full) => { body.className = "qcard-body"; body.replaceChildren(renderQuestion(full, { mode: "solution" }).el); };
      if (fullCache.has(q.id)) show(fullCache.get(q.id));
      else loadFull([q.id]).then(() => fullCache.has(q.id) && show(fullCache.get(q.id)));
    }
    makeDraggable(card, handle, it.item_id);
    return card;
  }

  function move(index, delta) {
    const ids = entries().map((x) => x.item_id);
    const j = index + delta;
    [ids[index], ids[j]] = [ids[j], ids[index]];
    return saveOrder(ids);
  }

  function drawStats() {
    const pts = quiz.items.reduce((s, it) => s + Number(it.points), 0);
    stats.textContent = `${quiz.items.length} question${quiz.items.length === 1 ? "" : "s"} · ${fmtPts(pts)} points`;
  }

  function draw() {
    drawStats();
    const allOpen = quiz.items.length > 0 && quiz.items.every((it) => expandedItems.has(it.question.id));
    expandBtn.textContent = allOpen ? "▴ Collapse all" : "▾ Expand all";
    expandBtn.disabled = !quiz.items.length;
    const all = entries();
    let qIndex = 0;
    list.replaceChildren();
    all.forEach((e, i) => {
      list.append(gap(e.item_id));
      list.append(e.kind === "section" ? sectionCard(e.sec, i, all.length) : itemCard(e.it, qIndex++, i, all.length));
    });
    if (all.length) list.append(gap(null));
    if (!quiz.items.length) {
      list.append(h("div", { class: "empty" },
        h("p", {}, "This quiz is empty."),
        h("div", { class: "row", style: { justifyContent: "center" } },
          h("button", { class: "primary", onclick: () => guard(() => addFromCatalog()) }, "+ Add from catalog"),
          h("span", { class: "muted" }, "or create a new question with \"+ New question\"."))));
    }
  }

  onPageDrop = async (files) => { if (await importFilesDialog(files, { quizId })) await reload(); };

  const newMenu = menu("+ New question ▾", types.map((t) => [h("span", {}, typeBadge(t.type), t.label), () => newQuestion(t.type)]));
  app.replaceChildren(
    h("div", { class: "quiz-head" },
      h("div", {}, h("a", { href: quiz.archived ? "#/quizzes/archived" : "#/quizzes" }, quiz.archived ? "← Archived quizzes" : "← Quizzes")),
      quiz.archived
        ? h("div", { class: "archived-banner" }, "🗄 This quiz is archived and hidden from the quiz list.",
          h("button", { class: "primary", onclick: () => guard(async () => { await setArchived(quiz, false); quizView(quizId); }) }, "↩ Unarchive"))
        : null,
      title,
      h("details", {}, h("summary", { class: "muted small" }, "Description"), h("div", { style: { marginTop: "8px" } }, description)),
      h("div", { class: "toolbar" },
        h("button", { class: "primary", onclick: () => guard(() => addFromCatalog()) }, "+ Add from catalog"),
        newMenu,
        h("button", { title: "Add a section heading at the end (or use \"+ Section\" between questions)", onclick: () => guard(() => addSection(null)) }, "+ Section"),
        h("button", { onclick: () => guard(async () => { if (await importDialog({ quizId })) await reload(); }) }, "⬆ Import XML"),
        h("span", { class: "spacer" }),
        h("button", { onclick: () => { location.hash = `#/quiz/${quizId}/practice`; } }, "▶ Practice"),
        menu("📄 PDF ▾", [
          ["📄 Exam PDF…", () => pdfExportDialog(quiz, false)],
          ["🔑 Answer key PDF…", () => pdfExportDialog(quiz, true)],
          ["⬇ LaTeX source (.zip)", () => download(`/api/quizzes/${quizId}/exam.zip`)],
          ["⚙ PDF settings…", () => pdfSettingsDialog(quiz)],
        ]),
        menu("⬇ Moodle XML ▾", [
          ["As one category named after the quiz", () => download(`/api/quizzes/${quizId}/export.xml?mode=quiz`)],
          ["Keeping the catalog categories", () => download(`/api/quizzes/${quizId}/export.xml?mode=catalog`)],
        ]),
        !quiz.archived && h("button", { title: "Hide from the quiz list (can be restored from the archive)", onclick: () => guard(async () => {
          await setArchived(quiz, true);
          location.hash = "#/quizzes";
        }) }, "🗄 Archive")),
      h("div", { class: "row" }, h("span", { class: "muted small" }, "Questions are references to the catalog: editing one here changes it everywhere it is used."), h("span", { class: "spacer" }), stats, expandBtn)),
    list);
  // Menus of the right-hand toolbar buttons open towards the left.
  for (const m of app.querySelectorAll(".toolbar .spacer ~ .menu-wrap .menu")) m.classList.add("right");
  draw();
}

// ------------------------------------------------------------------ practice

async function practiceView(quizId) {
  const [quiz, questions] = await Promise.all([api("GET", `/api/quizzes/${quizId}`), api("GET", `/api/quizzes/${quizId}/questions`)]);
  document.title = `Practice: ${quiz.name} · Quizmaster`;
  const shuffleCb = h("input", { type: "checkbox" });
  const solutionsCb = h("input", { type: "checkbox" });
  const score = h("strong");
  const container = h("div");
  let views = [];

  function draw() {
    const qs = (shuffleCb.checked ? shuffle(questions) : questions).filter((q) => !q.hidden);
    const mode = solutionsCb.checked ? "solution" : "practice";
    container.replaceChildren();
    score.textContent = "";
    // Visible section headings go before the first question that follows them (not when shuffled).
    const headings = new Map();
    if (!shuffleCb.checked) {
      const sections = (quiz.sections || []).filter((sec) => sec.visible && sec.name.trim());
      const key = (x) => [x.position ?? 0, x.item_id ?? 0];
      const before = (a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1];
      for (const sec of sections) {
        const next = qs.find((q) => before(sec, q) < 0);
        if (next) headings.set(next, [...(headings.get(next) || []), sec.name]);
      }
    }
    views = qs.map((q, i) => {
      for (const name of headings.get(q) || []) container.append(h("h2", { class: "practice-section" }, name));
      const view = renderQuestion(q, { mode });
      const res = h("span", { class: "points" }, `${fmtPts(q.defaultgrade)} pt`);
      container.append(h("div", { class: "card practice-q" },
        h("div", { class: "qhead" }, h("h3", { style: { margin: 0 } }, `Question ${i + 1}`), typeBadge(q.type), h("span", { class: "muted small" }, q.name), h("span", { class: "spacer" }), res),
        view.el,
        mode === "practice" && h("div", { class: "row", style: { marginTop: "10px" } }, h("button", { onclick: () => { const r = view.check(); if (r) res.textContent = `${r.grade.toFixed(2)} / ${fmtPts(r.max)} pt`; } }, "Check"))));
      return { view, res };
    });
    if (!views.length) container.append(h("div", { class: "empty" }, "No (visible) questions in this quiz."));
  }

  function checkAll() {
    let got = 0, max = 0;
    for (const { view, res } of views) {
      const r = view.check();
      if (!r) continue;
      got += r.grade;
      max += r.max;
      res.textContent = `${r.grade.toFixed(2)} / ${fmtPts(r.max)} pt`;
    }
    score.textContent = `Score: ${got.toFixed(2)} / ${fmtPts(max)} (${max ? Math.round((got / max) * 100) : 0}%)`;
  }

  shuffleCb.addEventListener("change", draw);
  solutionsCb.addEventListener("change", draw);
  draw();
  app.replaceChildren(
    h("div", { style: { marginBottom: "10px" } }, h("a", { href: `#/quiz/${quizId}` }, "← Back to quiz")),
    h("h1", {}, `Practice: ${quiz.name}`),
    h("div", { class: "card scorebar" },
      h("label", { class: "check" }, shuffleCb, "Shuffle questions"),
      h("label", { class: "check" }, solutionsCb, "Show solutions"),
      h("span", { class: "spacer" }), score,
      h("button", { onclick: () => draw() }, "Restart"),
      h("button", { class: "primary", onclick: checkAll }, "Check all")),
    container);
}
