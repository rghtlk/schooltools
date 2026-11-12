// Shared helpers: DOM building, API calls, toasts, file handling, rich text editor.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  let value;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "value") value = v;
    else if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (value !== undefined) el.value = value;
  return el;
}

export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

export function toast(msg, kind = "info") {
  const t = h("div", { class: `toast ${kind}` }, msg);
  document.getElementById("toasts").append(t);
  setTimeout(() => t.remove(), kind === "error" ? 7000 : 3000);
}

export async function guard(fn) {
  try { return await fn(); } catch (e) { console.error(e); toast(e.message || String(e), "error"); }
}

export function stripHtml(html) {
  const d = document.createElement("div");
  d.innerHTML = (html || "").replace(/<img[^>]*>/g, " [image] ");
  return (d.textContent || "").replace(/\s+/g, " ").trim();
}

export function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const clone = (o) => JSON.parse(JSON.stringify(o));

// ------------------------------------------------------------------ files

const MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", svg: "image/svg+xml", webp: "image/webp", bmp: "image/bmp" };

export function mimeFor(name) {
  return MIME[(name.split(".").pop() || "").toLowerCase()] || "application/octet-stream";
}

export function dataUrl(name, b64) {
  return `data:${mimeFor(name)};base64,${b64}`;
}

/** Replace @@PLUGINFILE@@ references by data URLs so the HTML can be displayed. */
export function renderHtml(html, files = {}, forEditing = false) {
  return (html || "").replace(/(src|href)="@@PLUGINFILE@@\/([^"]*)"/g, (m, attr, n) => {
    let name = n;
    try { name = decodeURIComponent(n); } catch { /* keep raw */ }
    const data = files[name] ?? files[n];
    if (!data) return m;
    return `${attr}="${dataUrl(name, data)}"` + (forEditing ? ` data-qmfile="${escapeHtml(name)}"` : "");
  });
}

export function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, multiple });
    input.addEventListener("change", () => resolve([...input.files]));
    input.click();
  });
}

export function uniqueName(base, files) {
  const clean = base.replace(/[^\w.\-]+/g, "_") || "image.png";
  if (!(clean in files)) return clean;
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let i = 2;
  while (`${stem}_${i}${ext}` in files) i++;
  return `${stem}_${i}${ext}`;
}

// ------------------------------------------------------------------ tables (rich text editor)

// Moodle (Boost) styles tables with Bootstrap classes; the inline styles keep the borders elsewhere.
const TABLE_STYLE = "border-collapse: collapse;";
const CELL_STYLE = "border: 1px solid #999; padding: 4px 8px;";

function newCell(tag) {
  const c = document.createElement(tag);
  c.setAttribute("style", CELL_STYLE);
  if (tag === "th") c.setAttribute("scope", "col");
  c.innerHTML = "<br>";
  return c;
}

export function tableHtml(rows, cols, header) {
  const cell = (tag) => `<${tag} style="${CELL_STYLE}"${tag === "th" ? ' scope="col"' : ""}><br></${tag}>`;
  const row = (tag) => `<tr>${Array.from({ length: cols }, () => cell(tag)).join("")}</tr>`;
  const head = header ? `<thead>${row("th")}</thead>` : "";
  const bodyRows = Math.max(1, rows - (header ? 1 : 0));
  return `<table class="table table-bordered" style="${TABLE_STYLE}" data-qm-new="1">${head}<tbody>${Array.from({ length: bodyRows }, () => row("td")).join("")}</tbody></table><p><br></p>`;
}

function placeCaret(cell) {
  if (!cell) return;
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

const width = (tr) => [...tr.cells].reduce((n, c) => n + (c.colSpan || 1), 0);

function addRow(cell, tr, table) {
  const row = document.createElement("tr");
  for (let i = 0; i < width(tr); i++) row.append(newCell("td"));
  if (tr.parentElement.tagName === "THEAD") (table.tBodies[0] || table.createTBody()).prepend(row);
  else tr.after(row);
  placeCaret(row.cells[0]);
}

function addColumn(cell, tr, table) {
  const idx = cell.cellIndex;
  for (const r of table.rows) {
    const ref = r.cells[Math.min(idx, r.cells.length - 1)];
    const c = newCell(r.parentElement.tagName === "THEAD" || ref?.tagName === "TH" ? "th" : "td");
    if (ref) ref.after(c); else r.append(c);
  }
  placeCaret(tr.cells[idx + 1]);
}

function cleanup(table) {
  for (const section of [...table.querySelectorAll("thead, tbody, tfoot")]) if (!section.rows.length) section.remove();
  if (!table.rows.length) table.remove();
}

function deleteRow(cell, tr, table) {
  tr.remove();
  cleanup(table);
}

function deleteColumn(cell, tr, table) {
  const idx = cell.cellIndex;
  for (const r of [...table.rows]) {
    r.cells[idx]?.remove();
    if (!r.cells.length) r.remove();
  }
  cleanup(table);
}

function retag(cell, tag) {
  const c = newCell(tag);
  c.innerHTML = cell.innerHTML;
  if (cell.colSpan > 1) c.colSpan = cell.colSpan;
  if (cell.rowSpan > 1) c.rowSpan = cell.rowSpan;
  cell.replaceWith(c);
}

function toggleHeader(cell, tr, table) {
  if (table.tHead) {  // header row -> normal first row
    const body = table.tBodies[0] || table.createTBody();
    for (const r of [...table.tHead.rows].reverse()) {
      for (const c of [...r.cells]) retag(c, "td");
      body.prepend(r);
    }
    table.tHead.remove();
  } else {  // first row -> header row
    const first = table.rows[0];
    if (!first) return;
    const head = table.createTHead();
    for (const c of [...first.cells]) retag(c, "th");
    head.append(first);
  }
  cleanup(table);
}

// ------------------------------------------------------------------ rich text editor

/**
 * Minimal WYSIWYG editor working on Moodle-style HTML.
 * `files` is the (shared, mutable) file map of the question being edited.
 */
export function richEditor(html, files, { small = false, placeholder = "" } = {}) {
  const content = h("div", { class: "rte-content", contenteditable: "true", "data-placeholder": placeholder });
  const source = h("textarea", { class: "hidden", spellcheck: false });
  let sourceMode = false;

  const setHtml = (value) => { content.innerHTML = renderHtml(value, files, true); };
  // Enter creates <p> paragraphs (like Moodle's editors) instead of Chrome's <div>s.
  content.addEventListener("focus", () => document.execCommand("defaultParagraphSeparator", false, "p"));
  setHtml(html);

  const cmd = (name, arg) => () => { content.focus(); document.execCommand(name, false, arg); };
  const wrapCode = () => {
    content.focus();
    const sel = window.getSelection();
    const text = sel && sel.toString();
    document.execCommand("insertHTML", false, `<code>${escapeHtml(text || "code")}</code>&nbsp;`);
  };
  const insertImage = async () => {
    const [file] = await pickFile("image/*");
    if (!file) return;
    const b64 = await readFileAsBase64(file);
    const name = uniqueName(file.name, files);
    files[name] = b64;
    content.focus();
    document.execCommand("insertHTML", false, `<img src="${dataUrl(name, b64)}" data-qmfile="${escapeHtml(name)}" alt="">`);
  };
  const link = () => {
    const url = prompt("Link URL:", "https://");
    if (url) cmd("createLink", url)();
  };

  const btn = (label, title, fn) => h("button", { type: "button", title, onmousedown: (e) => e.preventDefault(), onclick: fn, html: label });
  const srcBtn = btn("&lt;/&gt;", "Edit HTML source", () => {
    sourceMode = !sourceMode;
    if (sourceMode) {
      source.value = getHtml();
      source.style.height = Math.max(120, content.offsetHeight) + "px";
    } else {
      setHtml(source.value);
    }
    content.classList.toggle("hidden", sourceMode);
    source.classList.toggle("hidden", !sourceMode);
    srcBtn.classList.toggle("on", sourceMode);
  });

  // ---- tables
  let savedRange = null;
  const insertTable = () => {
    const sel = window.getSelection();
    savedRange = sel.rangeCount && content.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const rows = h("input", { type: "number", min: 1, max: 40, value: 3, style: { width: "80px" } });
    const cols = h("input", { type: "number", min: 1, max: 12, value: 3, style: { width: "80px" } });
    const header = h("input", { type: "checkbox", checked: true });
    const insert = () => {
      const r = Math.max(1, Math.min(40, Number(rows.value) || 3));
      const c = Math.max(1, Math.min(12, Number(cols.value) || 3));
      m.close();
      content.focus();
      // Insert as a block after the paragraph holding the caret (a table must not sit inside a <p>).
      let anchor = savedRange && content.contains(savedRange.startContainer) ? savedRange.startContainer : null;
      while (anchor && anchor.parentNode !== content) anchor = anchor.parentNode;
      const tpl = document.createElement("template");
      tpl.innerHTML = tableHtml(r, c, header.checked);
      const nodes = [...tpl.content.childNodes];
      if (anchor?.nextSibling) nodes.pop();  // the empty paragraph after the table is only needed at the end
      if (anchor) anchor.after(...nodes); else content.append(...nodes);
      const table = content.querySelector("table[data-qm-new]");
      if (table) { table.removeAttribute("data-qm-new"); placeCaret(table.querySelector("th, td")); }
      content.dispatchEvent(new Event("input"));
    };
    const m = modal({
      title: "Insert table", narrow: true,
      body: h("div", {},
        h("div", { class: "row" }, h("label", {}, "Rows"), rows, h("label", {}, "Columns"), cols),
        h("label", { class: "check", style: { marginTop: "10px" } }, header, "First row is a header row")),
      footer: [h("button", { type: "button", onclick: () => m.close() }, "Cancel"), h("button", { type: "button", class: "primary", onclick: insert }, "Insert")],
    });
    rows.focus();
  };

  const currentCell = () => {
    const sel = window.getSelection();
    if (!sel.rangeCount || !content.contains(sel.anchorNode)) return null;
    const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
    return node.closest("td, th");
  };
  const tableOp = (fn) => () => {
    const cell = currentCell();
    if (!cell) return;
    fn(cell, cell.closest("tr"), cell.closest("table"));
    content.dispatchEvent(new Event("input"));
    updateTableBar();
  };
  const tableBar = h("span", { class: "rte-table-tools hidden" },
    btn("+ Row", "Insert a row below", tableOp(addRow)),
    btn("+ Col", "Insert a column to the right", tableOp(addColumn)),
    btn("− Row", "Delete this row", tableOp(deleteRow)),
    btn("− Col", "Delete this column", tableOp(deleteColumn)),
    btn("Header", "Toggle header row", tableOp(toggleHeader)),
    btn("✕ Table", "Delete the table", tableOp((cell, tr, table) => table.remove())));
  const updateTableBar = () => {
    if (!content.isConnected) { document.removeEventListener("selectionchange", updateTableBar); return; }
    tableBar.classList.toggle("hidden", !currentCell());
  };
  document.addEventListener("selectionchange", updateTableBar);

  const toolbar = h("div", { class: "rte-toolbar" },
    btn("<b>B</b>", "Bold", cmd("bold")),
    btn("<i>I</i>", "Italic", cmd("italic")),
    btn("<u>U</u>", "Underline", cmd("underline")),
    btn("x<sub>2</sub>", "Subscript", cmd("subscript")),
    btn("x<sup>2</sup>", "Superscript", cmd("superscript")),
    btn("<code>{}</code>", "Inline code", wrapCode),
    !small && btn("• List", "Bulleted list", cmd("insertUnorderedList")),
    !small && btn("1. List", "Numbered list", cmd("insertOrderedList")),
    btn("🔗", "Link", link),
    btn("🖼", "Insert image", insertImage),
    btn("▦ Table", "Insert table", insertTable),
    tableBar,
    btn("⌫", "Remove formatting", cmd("removeFormat")),
    srcBtn,
  );

  // Paste images from the clipboard as embedded files.
  content.addEventListener("paste", async (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    const b64 = await readFileAsBase64(file);
    const name = uniqueName(`pasted.${item.type.split("/")[1] || "png"}`, files);
    files[name] = b64;
    document.execCommand("insertHTML", false, `<img src="${dataUrl(name, b64)}" data-qmfile="${escapeHtml(name)}" alt="">`);
  });

  function getHtml() {
    if (sourceMode) return source.value.trim();
    const tmp = content.cloneNode(true);
    for (const img of tmp.querySelectorAll("img")) {
      let name = img.getAttribute("data-qmfile");
      const src = img.getAttribute("src") || "";
      if (!name && src.startsWith("data:")) {
        const m = src.match(/^data:image\/(\w+)[^,]*;base64,(.*)$/);
        if (m) {
          name = uniqueName(`image.${m[1] === "jpeg" ? "jpg" : m[1]}`, files);
          files[name] = m[2];
        }
      }
      if (name) {
        img.setAttribute("src", "@@PLUGINFILE@@/" + encodeURIComponent(name));
        img.removeAttribute("data-qmfile");
      }
    }
    if (!tmp.querySelector("img, table") && !(tmp.textContent || "").trim()) return "";
    // Wrap loose inline content in paragraphs like Moodle's editors do; blocks (tables, lists, …) stay as they are.
    const BLOCK = /^(P|DIV|UL|OL|TABLE|H[1-6]|PRE|BLOCKQUOTE|HR)$/;
    let run = null;
    for (const node of [...tmp.childNodes]) {
      if (node.nodeType === 1 && BLOCK.test(node.tagName)) { run = null; continue; }
      if (!run) {
        if (node.nodeType === 3 && !node.textContent.trim()) continue;  // whitespace between blocks
        run = document.createElement("p");
        node.before(run);
      }
      run.append(node);
    }
    return tmp.innerHTML.trim();
  }

  /** Insert plain text at the caret (or at the end if the editor has no caret). */
  function insertText(str) {
    if (sourceMode) {
      const pos = source.selectionStart ?? source.value.length;
      source.value = source.value.slice(0, pos) + str + source.value.slice(source.selectionEnd ?? pos);
      source.dispatchEvent(new Event("input"));
      return;
    }
    const sel = window.getSelection();
    if (!sel.rangeCount || !content.contains(sel.anchorNode)) {
      content.focus();
      const range = document.createRange();
      const target = content.querySelector("p:last-of-type") || content;
      range.selectNodeContents(target);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand("insertText", false, str);
  }

  const onChange = (fn) => { content.addEventListener("input", fn); source.addEventListener("input", fn); };
  const setValue = (value) => { if (sourceMode) source.value = value; else setHtml(value); };

  const el = h("div", { class: "rte" + (small ? " small" : "") }, toolbar, content, source);
  return { el, getHtml, setHtml: setValue, insertText, onChange };
}

// ------------------------------------------------------------------ modal

export function modal({ title, body, footer = [], narrow = false, onClose }) {
  const dlg = h("dialog", { class: "modal" + (narrow ? " narrow" : "") });
  const close = () => { dlg.close(); };
  const head = h("div", { class: "modal-head" }, h("h2", {}, title), h("button", { type: "button", class: "icon", title: "Close", onclick: () => dlg.dispatchEvent(new Event("cancel", { cancelable: true })) }, "✕"));
  const bodyEl = h("div", { class: "modal-body" }, body);
  const foot = h("div", { class: "modal-foot" }, footer);
  dlg.append(h("div", { class: "modal-inner" }, head, bodyEl, foot));
  dlg.addEventListener("cancel", (e) => {
    if (onClose && onClose() === false) { e.preventDefault(); return; }
    e.preventDefault();
    close();
  });
  dlg.addEventListener("close", () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close, head, body: bodyEl, foot };
}

export function confirmDialog(message, okLabel = "Delete") {
  return new Promise((resolve) => {
    let result = false;
    const m = modal({
      title: "Please confirm",
      narrow: true,
      body: h("p", {}, message),
      footer: [
        h("button", { type: "button", onclick: () => m.close() }, "Cancel"),
        h("button", { type: "button", class: "primary", onclick: () => { result = true; m.close(); } }, okLabel),
      ],
    });
    m.dlg.addEventListener("close", () => resolve(result));
  });
}
