// Question catalog: category tree, question browser, catalog view and the "add from catalog" picker.
import { h, api, toast, guard, modal, confirmDialog, pickFile } from "./util.js";
import { renderQuestion, typeBadge, TYPE_LABELS, usageBadge, usageClass } from "./render.js";
import { openEditor } from "./editor.js";
import { store } from "./store.js";

const expandedCats = new Set(JSON.parse(safeGet("qm.expandedCats") || "[]"));
function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function saveExpanded() { try { localStorage.setItem("qm.expandedCats", JSON.stringify([...expandedCats])); } catch { /* ignore */ } }

export function download(url) {
  const a = h("a", { href: url, download: "" });
  document.body.append(a);
  a.click();
  a.remove();
}

// ------------------------------------------------------------------ dialogs

export function categorySelectDialog(title, { exclude = null, allowRoot = false, okLabel = "OK" } = {}) {
  return new Promise((resolve) => {
    const banned = exclude ? new Set(store.descendants(exclude)) : new Set();
    const sel = h("select", { style: { width: "100%" }, size: 12 },
      allowRoot && h("option", { value: "0" }, "(top level)"),
      store.options().filter((o) => !banned.has(o.id)).map((o) => h("option", { value: o.id }, o.label)));
    let result = null;
    const m = modal({
      title, narrow: true, body: sel,
      footer: [h("button", { onclick: () => m.close() }, "Cancel"),
        h("button", { class: "primary", onclick: () => { if (sel.value !== "") { result = +sel.value; m.close(); } } }, okLabel)],
    });
    sel.addEventListener("dblclick", () => { if (sel.value !== "") { result = +sel.value; m.close(); } });
    m.dlg.addEventListener("close", () => resolve(result));
  });
}

export async function importDialog({ parentId = null, quizId = null } = {}) {
  const files = await pickFile(".xml,text/xml,application/xml", true);
  if (!files.length) return null;
  return importFilesDialog(files, { parentId, quizId });
}

export function importFilesDialog(files, { parentId = null, quizId = null } = {}) {
  return new Promise((resolve) => {
    const parent = h("select", { style: { width: "100%" } },
      h("option", { value: "" }, "(top level)"),
      store.options().map((o) => h("option", { value: o.id, selected: o.id === parentId }, o.label)));
    const createQuiz = h("input", { type: "checkbox", checked: !quizId });
    let result = null;
    const m = modal({
      title: `Import ${files.length} Moodle XML file${files.length > 1 ? "s" : ""}`, narrow: true,
      body: h("div", {},
        h("p", { class: "muted small" }, files.map((f) => f.name).join(", ")),
        h("div", { class: "field" }, h("label", {}, "Place the file's categories below"), parent,
          h("div", { class: "muted small" }, "Moodle category paths (e.g. top/Course/Chapter) are recreated as subcategories. Existing categories with the same name are reused.")),
        quizId
          ? h("p", { class: "hint" }, "The imported questions are added to the catalog and to this quiz.")
          : h("label", { class: "check" }, createQuiz, "Also create a quiz from each file")),
      footer: [h("button", { onclick: () => m.close() }, "Cancel"), h("button", { class: "primary", onclick: () => guard(run) }, "Import")],
    });
    async function run() {
      const fd = new FormData();
      for (const f of files) fd.append("files", f);
      if (parent.value) fd.append("parent_id", parent.value);
      if (quizId) fd.append("quiz_id", quizId);
      else fd.append("create_quiz", createQuiz.checked ? "true" : "false");
      result = await api("POST", "/api/import", fd);
      await store.load();
      toast(`Imported ${result.questions} question(s)` + (result.quizzes.length ? ` and created ${result.quizzes.length} quiz(zes)` : ""));
      m.close();
    }
    m.dlg.addEventListener("close", () => resolve(result));
  });
}

export async function addToQuizDialog(ids) {
  const quizzes = (await api("GET", "/api/quizzes")).filter((z) => !z.archived);
  const sel = h("select", { style: { width: "100%" } },
    h("option", { value: "new" }, "➕ New quiz…"),
    quizzes.map((z) => h("option", { value: z.id }, `${z.name} (${z.question_count})`)));
  const name = h("input", { type: "text", placeholder: "Name of the new quiz", style: { width: "100%" } });
  sel.addEventListener("change", () => name.classList.toggle("hidden", sel.value !== "new"));
  if (quizzes.length) { sel.value = quizzes[0].id; name.classList.add("hidden"); }
  return new Promise((resolve) => {
    let quizId = null;
    const m = modal({
      title: `Add ${ids.length} question(s) to a quiz`, narrow: true,
      body: h("div", { class: "field" }, h("label", {}, "Quiz"), sel, name),
      footer: [h("button", { onclick: () => m.close() }, "Cancel"), h("button", { class: "primary", onclick: () => guard(async () => {
        if (sel.value === "new") {
          const quiz = await api("POST", "/api/quizzes", { name: name.value.trim() || "New quiz", question_ids: ids });
          quizId = quiz.id;
          toast(`Quiz "${quiz.name}" created`);
        } else {
          const r = await api("POST", `/api/quizzes/${sel.value}/items`, { question_ids: ids });
          quizId = +sel.value;
          toast(`${r.added} question(s) added` + (r.added < ids.length ? ` (${ids.length - r.added} already in the quiz)` : ""));
        }
        m.close();
      }) }, "Add")],
    });
    m.dlg.addEventListener("close", () => resolve(quizId));
  });
}

// ------------------------------------------------------------------ question browser

/**
 * Category tree + filterable question list.
 * mode "catalog": full management.  mode "pick": selection only (for adding to a quiz).
 */
export function questionBrowser({ mode = "catalog", inQuiz = new Set(), onSelectionChange = () => {}, initialCategory = null, types = [] } = {}) {
  const state = { cat: initialCategory, sub: true, search: "", type: "", tag: null, unused: false };

  /** "+ New question ▾" menu; the question is created in the selected category. */
  function newQuestionMenu(label, cls = "primary") {
    const menu = h("div", { class: "menu hidden right" }, types.map((t) => h("button", { onclick: () => {
      menu.classList.add("hidden");
      guard(async () => {
        const template = await api("GET", `/api/types/${t.type}/new`);
        if (await openEditor(template, { categoryId: state.cat })) await refresh();
      });
    } }, typeBadge(t.type), t.label)));
    return h("div", { class: "menu-wrap" }, h("button", { class: cls, onclick: () => menu.classList.toggle("hidden") }, label), menu);
  }
  const selected = new Set();
  const expanded = new Set();

  const tree = h("nav", { class: "cat-tree" });
  const head = h("div", { class: "browser-head" });
  const list = h("div", { class: "qlist" });
  const tagBar = h("div", { class: "row small" });
  const bulk = h("div", { class: "bulkbar hidden" });

  const search = h("input", { type: "search", placeholder: "Search name, text, tags…", style: { flex: "1", minWidth: "180px" }, oninput: () => { state.search = search.value.toLowerCase(); drawList(); } });
  const typeSel = h("select", { onchange: () => { state.type = typeSel.value; drawList(); } }, h("option", { value: "" }, "All types"), Object.entries(TYPE_LABELS).map(([k, v]) => h("option", { value: k }, v)));
  const subCb = h("input", { type: "checkbox", checked: true, onchange: () => { state.sub = subCb.checked; drawList(); } });
  const unusedCb = h("input", { type: "checkbox", onchange: () => { state.unused = unusedCb.checked; drawList(); } });
  const filters = h("div", { class: "row", style: { margin: "10px 0 6px" } }, search, typeSel,
    h("label", { class: "check" }, subCb, "incl. subcategories"),
    mode === "catalog" ? h("label", { class: "check" }, unusedCb, "not in any quiz") : null);

  const changed = () => onSelectionChange(selected);

  // tree ---------------------------------------------------------
  function drawTree() {
    const node = (c) => {
      const kids = store.kids(c.id);
      const open = expandedCats.has(c.id);
      const caret = h("span", { class: "caret" + (kids.length ? "" : " leaf"), onclick: (e) => { e.stopPropagation(); open ? expandedCats.delete(c.id) : expandedCats.add(c.id); saveExpanded(); drawTree(); } }, kids.length ? (open ? "▾" : "▸") : "");
      const row = h("div", { class: "cat-row" + (state.cat === c.id ? " active" : ""), title: store.pathString(c.id), onclick: () => select(c.id) },
        caret, h("span", { class: "cat-name" }, c.name), h("span", { class: "cat-count" }, store.total(c.id)));
      if (mode === "catalog") acceptQuestionDrop(row, c.id);
      return h("div", { class: "cat-node" }, row, open && kids.length ? h("div", { class: "cat-children" }, kids.map(node)) : null);
    };
    tree.replaceChildren(...[
      h("div", { class: "cat-row" + (state.cat === null ? " active" : ""), onclick: () => select(null) },
        h("span", { class: "caret leaf" }), h("span", { class: "cat-name" }, h("strong", {}, "All questions")), h("span", { class: "cat-count" }, store.questions.length)),
      ...store.kids(0).map(node),
      !store.categories.length ? h("p", { class: "muted small", style: { padding: "8px" } }, "No categories yet.") : null].filter(Boolean));
  }

  function acceptQuestionDrop(row, catId) {
    row.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/x-questions")) { e.preventDefault(); row.classList.add("drop-target"); } });
    row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", (e) => {
      row.classList.remove("drop-target");
      const ids = JSON.parse(e.dataTransfer.getData("text/x-questions") || "[]");
      if (!ids.length) return;
      e.preventDefault();
      guard(async () => {
        await api("POST", "/api/questions/bulk", { action: "move", ids, category_id: catId });
        toast(`Moved ${ids.length} question(s) to ${store.pathString(catId)}`);
        await refresh();
      });
    });
  }

  function select(catId) {
    state.cat = catId;
    if (catId) for (let c = store.byId.get(store.byId.get(catId)?.parent_id); c; c = store.byId.get(c.parent_id)) expandedCats.add(c.id);
    state.tag = null;
    drawTree();
    drawHead();
    drawList();
  }

  // header with category actions ------------------------------------
  function drawHead() {
    const cat = state.cat ? store.byId.get(state.cat) : null;
    const crumbs = cat
      ? store.path(cat.id).map((n, i, arr) => h("span", {}, i ? " / " : "", i === arr.length - 1 ? h("strong", {}, n) : n))
      : [h("strong", {}, "All questions")];
    const actions = [];
    if (mode === "catalog") {
      actions.push(
        newQuestionMenu(cat ? `+ New question in ${cat.name} ▾` : "+ New question ▾"),
        h("button", { onclick: () => guard(() => newCategory(cat?.id ?? null)) }, cat ? "+ Subcategory" : "+ Category"),
        cat && h("button", { onclick: () => guard(() => renameCategory(cat)) }, "Rename"),
        cat && h("button", { onclick: () => guard(() => moveCategory(cat)) }, "Move…"),
        cat && h("button", { class: "danger", onclick: () => guard(() => deleteCategory(cat)) }, "Delete"),
        h("button", { onclick: () => download(cat ? `/api/export.xml?category_id=${cat.id}` : "/api/export.xml") }, "⬇ Moodle XML"));
    }
    head.replaceChildren(h("div", { class: "row" }, h("div", { class: "crumbs" }, crumbs), h("span", { class: "spacer" }), actions),
      ...(cat?.info ? [h("div", { class: "muted small" }, cat.info)] : []));
  }

  async function newCategory(parentId) {
    const name = prompt(parentId ? `New subcategory of "${store.pathString(parentId)}":` : "New top-level category:");
    if (!name?.trim()) return;
    const { id } = await api("POST", "/api/categories", { name: name.trim(), parent_id: parentId });
    if (parentId) expandedCats.add(parentId);
    await store.load();
    select(id);
  }
  async function renameCategory(cat) {
    const name = prompt("Rename category:", cat.name);
    if (!name?.trim() || name === cat.name) return;
    await api("PUT", `/api/categories/${cat.id}`, { name: name.trim() });
    await refresh();
  }
  async function moveCategory(cat) {
    const target = await categorySelectDialog(`Move "${cat.name}" to…`, { exclude: cat.id, allowRoot: true, okLabel: "Move" });
    if (target === null) return;
    await api("PUT", `/api/categories/${cat.id}`, { parent_id: target || null });
    if (target) expandedCats.add(target);
    await refresh();
  }
  async function deleteCategory(cat) {
    const parent = store.byId.get(cat.parent_id);
    const n = store.counts.get(cat.id) || 0;
    const msg = parent
      ? `Delete category "${cat.name}"? Its ${n} question(s) and subcategories move to "${parent.name}".`
      : `Delete top-level category "${cat.name}"? Subcategories become top-level categories.`;
    if (!(await confirmDialog(msg))) return;
    await api("DELETE", `/api/categories/${cat.id}`);
    state.cat = cat.parent_id;
    await refresh();
  }

  // list -----------------------------------------------------------
  function scoped() {
    let qs = store.questions;
    if (state.cat !== null) {
      const cats = state.sub ? new Set(store.descendants(state.cat)) : new Set([state.cat]);
      qs = qs.filter((q) => cats.has(q.category_id));
    }
    return qs;
  }

  function visible() {
    return scoped().filter((q) =>
      (!state.type || q.type === state.type) &&
      (!state.tag || (q.tags || []).includes(state.tag)) &&
      (!state.unused || !q.quiz_count) &&
      (!state.search || `${q.name} ${q.snippet} ${(q.tags || []).join(" ")}`.toLowerCase().includes(state.search)));
  }

  function drawTags(qs) {
    const all = [...new Set(qs.flatMap((q) => q.tags || []))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    tagBar.replaceChildren(...(all.length ? [h("span", { class: "muted" }, "Tags:"),
      ...all.map((t) => h("a", { href: "javascript:void 0", class: "tag" + (t === state.tag ? " active" : ""), onclick: () => { state.tag = state.tag === t ? null : t; drawList(); } }, t))] : []));
  }

  function card(q) {
    const already = inQuiz.has(q.id);
    const isOpen = expanded.has(q.id);
    const cb = h("input", { type: "checkbox", checked: selected.has(q.id) || already, disabled: mode === "pick" && already, onclick: (e) => e.stopPropagation(),
      onchange: () => { cb.checked ? selected.add(q.id) : selected.delete(q.id); drawBulk(); syncSelectAll(); changed(); } });
    const stop = (fn) => (e) => { e.stopPropagation(); guard(fn); };
    const showPath = state.cat === null || (state.sub && q.category_id !== state.cat);
    const el = h("div", { class: "card qcard" + usageClass(q) + (already && mode === "pick" ? " in-quiz" : ""), draggable: mode === "catalog" });
    const headEl = h("div", { class: "qcard-head", onclick: () => {
      if (mode === "pick" && !already) { cb.checked = !cb.checked; cb.dispatchEvent(new Event("change")); return; }
      isOpen ? expanded.delete(q.id) : expanded.add(q.id); drawList();
    } },
      cb,
      h("div", { class: "qmain" },
        h("div", {}, typeBadge(q.type), h("span", { class: "qtitle" }, q.name || "(no name)"), q.hidden && h("span", { class: "tag" }, "hidden"),
          h("span", { class: "muted small" }, ` · ${Number(q.defaultgrade ?? 1)} pt`), " ",
          (q.tags || []).map((t) => h("span", { class: "tag" }, t)),
          already && mode === "pick" ? h("span", { class: "tag active" }, "in quiz") : null,
          usageBadge(q)),
        showPath && h("div", { class: "qpath" }, store.pathString(q.category_id)),
        !isOpen && h("div", { class: "qsnippet" }, q.snippet)),
      h("div", { class: "qactions" },
        mode === "pick" && h("button", { class: "icon", title: "Preview", onclick: stop(() => { isOpen ? expanded.delete(q.id) : expanded.add(q.id); drawList(); }) }, "👁"),
        mode === "catalog" && q.type in TYPE_LABELS && h("button", { onclick: stop(async () => { if (await openEditor(await api("GET", `/api/questions/${q.id}`))) await refresh(); }) }, "✎ Edit"),
        mode === "catalog" && h("button", { class: "icon", title: "Duplicate", onclick: stop(async () => { await api("POST", `/api/questions/${q.id}/duplicate`); await refresh(); }) }, "⧉"),
        mode === "catalog" && h("button", { class: "icon danger", title: "Delete from catalog", onclick: stop(() => deleteQuestions([q.id])) }, "✕")));
    el.append(headEl);
    if (isOpen) {
      const body = h("div", { class: "qcard-body muted" }, "Loading…");
      el.append(body);
      const show = (full) => {
        body.className = "qcard-body";
        body.replaceChildren(renderQuestion(full, { mode: "solution" }).el,
          ...(mode === "catalog" && full.quizzes?.length
            ? [h("div", { class: "muted small", style: { marginTop: "8px" } }, "Used in: ", full.quizzes.map((z, i) => [i ? ", " : "", h("a", { href: `#/quiz/${z.id}` }, z.name), z.archived ? " 🗄" : ""]))]
            : []));
      };
      if (fullCache.has(q.id)) show(fullCache.get(q.id));
      else loadFull([q.id]).then(() => fullCache.has(q.id) && show(fullCache.get(q.id)));
    }
    if (mode === "catalog") {
      el.addEventListener("dragstart", (e) => {
        const ids = selected.has(q.id) ? [...selected] : [q.id];
        e.dataTransfer.setData("text/x-questions", JSON.stringify(ids));
        e.dataTransfer.effectAllowed = "move";
        el.classList.add("dragging");
      });
      el.addEventListener("dragend", () => el.classList.remove("dragging"));
    }
    return el;
  }

  async function deleteQuestions(ids) {
    const used = store.questions.filter((q) => ids.includes(q.id) && q.quiz_count).length;
    const msg = `Delete ${ids.length} question(s) from the catalog?` + (used ? ` ${used} of them are used in quizzes and will be removed from those quizzes.` : "");
    if (!(await confirmDialog(msg))) return;
    await api("POST", "/api/questions/bulk", { action: "delete", ids });
    ids.forEach((id) => selected.delete(id));
    toast("Deleted");
    await refresh();
  }

  function drawBulk() {
    for (const id of [...selected]) if (!store.questions.some((q) => q.id === id)) selected.delete(id);
    if (mode !== "catalog") return;
    bulk.classList.toggle("hidden", !selected.size);
    const ids = () => [...selected];
    bulk.replaceChildren(
      h("strong", {}, `${selected.size} selected`),
      h("button", { class: "primary", onclick: () => guard(async () => { const quizId = await addToQuizDialog(ids()); if (quizId) await refresh(); }) }, "Add to quiz…"),
      h("button", { onclick: () => guard(async () => {
        const target = await categorySelectDialog(`Move ${selected.size} question(s) to…`, { okLabel: "Move" });
        if (!target) return;
        await api("POST", "/api/questions/bulk", { action: "move", ids: ids(), category_id: target });
        toast("Moved");
        await refresh();
      }) }, "Move to…"),
      h("button", { onclick: () => download(`/api/export.xml?ids=${ids().join(",")}`) }, "⬇ Moodle XML"),
      h("button", { class: "danger", onclick: () => guard(() => deleteQuestions(ids())) }, "Delete"),
      h("span", { class: "spacer" }),
      h("button", { onclick: () => { visible().forEach((q) => selected.add(q.id)); drawList(); } }, "Select all visible"),
      h("button", { onclick: () => { selected.clear(); drawList(); } }, "Clear"));
  }

  // Full questions (for expanded previews), fetched in batches.
  const fullCache = new Map();
  async function loadFull(ids) {
    const missing = ids.filter((id) => !fullCache.has(id));
    for (let i = 0; i < missing.length; i += 50) {
      for (const q of await api("POST", "/api/questions/full", { ids: missing.slice(i, i + 50) })) fullCache.set(q.id, q);
    }
  }

  const countEl = h("span", { class: "stats" });
  // Selectable = listed questions (in the picker: those not yet in the quiz).
  const selectable = () => visible().filter((q) => mode !== "pick" || !inQuiz.has(q.id));
  const selectAllCb = h("input", { type: "checkbox", onchange: () => {
    for (const q of selectable()) selectAllCb.checked ? selected.add(q.id) : selected.delete(q.id);
    drawList();
  } });
  function syncSelectAll() {
    const sel = selectable();
    const n = sel.filter((q) => selected.has(q.id)).length;
    selectAllCb.checked = sel.length > 0 && n === sel.length;
    selectAllCb.indeterminate = n > 0 && n < sel.length;
    selectAllCb.disabled = !sel.length;
  }
  const selectAll = h("label", { class: "check", title: "Select or deselect all listed questions" }, selectAllCb, "Select all");
  const expandBtn = h("button", { title: "Show all listed questions in full, with their answers", onclick: () => guard(async () => {
    const ids = visible().map((q) => q.id);
    if (ids.length && ids.every((id) => expanded.has(id))) {
      ids.forEach((id) => expanded.delete(id));
    } else {
      expandBtn.disabled = true;
      expandBtn.textContent = "Loading…";
      try { await loadFull(ids); } finally { expandBtn.disabled = false; }
      ids.forEach((id) => expanded.add(id));
    }
    drawList();
  }) });
  function drawList() {
    drawTags(scoped());
    const qs = visible();
    countEl.textContent = `${qs.length} question${qs.length === 1 ? "" : "s"}`;
    const allOpen = qs.length > 0 && qs.every((q) => expanded.has(q.id));
    expandBtn.textContent = allOpen ? "▴ Collapse all" : "▾ Expand all";
    expandBtn.disabled = !qs.length;
    syncSelectAll();
    list.replaceChildren(...qs.map(card));
    if (!qs.length) {
      const cat = state.cat ? store.byId.get(state.cat) : null;
      const emptyCategory = cat && !scoped().length;
      list.append(h("div", { class: "empty" },
        h("p", {}, emptyCategory ? `"${cat.name}" has no questions yet.` : store.questions.length ? "No question matches." : "The catalog is empty. Import a Moodle XML file or create a question."),
        mode === "catalog" && (emptyCategory || !store.questions.length)
          ? h("div", { class: "row", style: { justifyContent: "center" } }, newQuestionMenu(emptyCategory ? "+ New question here ▾" : "+ New question ▾"))
          : null));
    }
    drawBulk();
    changed();
  }

  async function refresh() {
    fullCache.clear();
    await store.load();
    if (state.cat !== null && !store.byId.has(state.cat)) state.cat = null;
    drawTree();
    drawHead();
    drawList();
  }

  drawTree();
  drawHead();
  drawList();

  const el = h("div", { class: "browser" + (mode === "pick" ? " pick" : "") },
    h("aside", { class: "browser-side card" }, tree),
    h("section", { class: "browser-main" }, head, filters, h("div", { class: "row" }, tagBar, h("span", { class: "spacer" }), countEl, selectAll, expandBtn), list, bulk));
  return {
    el, selected, refresh,
    get category() { return state.cat; },
    clearSelection() { selected.clear(); drawList(); },
  };
}

// ------------------------------------------------------------------ catalog view

export async function catalogView(app, types, setPageDrop) {
  document.title = "Catalog · Quizmaster";
  await store.load();
  const browser = questionBrowser({ mode: "catalog", types });
  const doImport = async (files) => {
    const res = await importFilesDialog(files, { parentId: browser.category });
    if (res) await browser.refresh();
  };
  setPageDrop(doImport);

  app.replaceChildren(
    h("div", { class: "row", style: { marginBottom: "12px" } },
      h("h1", { style: { margin: 0 } }, "Question catalog"), h("span", { class: "spacer" }),
      h("button", { onclick: () => guard(async () => { if (await importDialog({ parentId: browser.category })) await browser.refresh(); }) }, "⬆ Import Moodle XML")),
    browser.el);
}

// ------------------------------------------------------------------ picker

/** Dialog to pick catalog questions for a quiz. Resolves with the selected ids (or []). */
export async function pickQuestions(inQuiz, title = "Add questions from the catalog") {
  await store.load();
  return new Promise((resolve) => {
    let result = [];
    const addBtn = h("button", { class: "primary", disabled: true }, "Add");
    const browser = questionBrowser({
      mode: "pick", inQuiz,
      onSelectionChange: (sel) => { addBtn.disabled = !sel.size; addBtn.textContent = sel.size ? `Add ${sel.size} question${sel.size > 1 ? "s" : ""}` : "Add"; },
    });
    addBtn.addEventListener("click", () => { result = [...browser.selected]; m.close(); });
    const m = modal({ title, body: browser.el, footer: [h("button", { onclick: () => m.close() }, "Cancel"), addBtn] });
    m.dlg.classList.add("wide");
    m.dlg.addEventListener("close", () => resolve(result));
  });
}
