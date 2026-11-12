// Rendering of questions as a student would see them, with optional grading.
import { h, renderHtml, shuffle, stripHtml, dataUrl, escapeHtml } from "./util.js";
import { GAP_RE, parseGap, bestAnswer } from "./cloze.js";

export const TYPE_LABELS = {
  truefalse: "True/False",
  multichoice: "Multiple choice",
  multichoiceset: "Multiple choice (all-or-nothing)",
  shortanswer: "Short answer",
  matching: "Matching",
  ddimageortext: "Drag & drop onto image",
  gapselect: "Select missing words",
  cloze: "Cloze (embedded answers)",
  essay: "Essay",
};

export function typeBadge(type) {
  const known = type in TYPE_LABELS;
  return h("span", { class: `badge t-${known ? type : "unsupported"}` }, known ? TYPE_LABELS[type] : `${type} (preserved)`);
}

const html = (q, s) => h("div", { html: renderHtml(s, q.files) });

function numbering(style, i) {
  switch (style) {
    case "abc": return String.fromCharCode(97 + i) + ".";
    case "ABCD": return String.fromCharCode(65 + i) + ".";
    case "123": return `${i + 1}.`;
    case "iii": return roman(i + 1).toLowerCase() + ".";
    case "IIII": return roman(i + 1) + ".";
    default: return "";
  }
}

function roman(n) {
  const map = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let out = "";
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

export function wildcardMatch(pattern, value, caseSensitive) {
  const p = pattern.trim();
  const re = "^" + p.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$";
  return new RegExp(re, caseSensitive ? "su" : "isu").test(value.trim());
}

function combinedFeedback(q, fraction) {
  if (fraction >= 0.9999999) return { cls: "ok", text: q.correctfeedback };
  if (fraction <= 0) return { cls: "bad", text: q.incorrectfeedback };
  return { cls: "", text: q.partiallycorrectfeedback ?? q.incorrectfeedback };
}

/**
 * Render a question.
 * mode: "practice" (interactive, can be checked) or "solution" (shows the right answers).
 * Returns { el, check() -> {fraction, grade, max}, showSolution() }.
 */
export function renderQuestion(q, { mode = "practice" } = {}) {
  const root = h("div", { class: "qview" });
  root.append(h("div", { class: "qtext", html: renderHtml(q.questiontext, q.files) }));
  const fbBox = h("div", { class: "fb hidden" });
  // Questions kept as raw XML (imported before their type was supported) cannot be rendered.
  const renderer = q.raw ? null : RENDERERS[q.type];
  let impl;
  if (!renderer) {
    root.append(h("p", { class: "muted" }, `Question type "${q.type}" cannot be previewed here, but it is preserved on export.`));
    impl = { check: () => null, solve: () => {} };
  } else {
    impl = renderer(q, root, mode === "solution");
  }
  root.append(fbBox);

  function showFeedback(result, extra) {
    fbBox.innerHTML = "";
    fbBox.className = "fb";
    if (result) {
      const cf = combinedFeedback(q, result.fraction);
      fbBox.classList.add(cf.cls || "partial");
      fbBox.append(h("div", { style: { fontWeight: 700 } }, `Mark: ${(result.fraction * (q.defaultgrade ?? 1)).toFixed(2)} / ${Number(q.defaultgrade ?? 1).toFixed(2)}`));
      if (result.numCorrect !== undefined && q.shownumcorrect && result.fraction < 1 && result.fraction > 0) {
        fbBox.append(h("div", {}, `You have ${result.numCorrect} correct of ${result.numTotal}.`));
      }
      if (cf.text) fbBox.append(html(q, cf.text));
    }
    if (q.generalfeedback) fbBox.append(html(q, q.generalfeedback));
    if (extra) fbBox.append(extra);
    if (!fbBox.childNodes.length) fbBox.classList.add("hidden");
  }

  if (mode === "solution") {
    impl.solve();
    const sol = impl.solutionText?.();
    if (q.generalfeedback || sol) showFeedback(null, sol ? h("div", { class: "solution" }, sol) : null);
  }

  return {
    el: root,
    check() {
      const r = impl.check();
      if (r) showFeedback(r, impl.solutionText ? h("div", { class: "solution" }, impl.solutionText()) : null);
      return r ? { ...r, grade: r.fraction * (q.defaultgrade ?? 1), max: q.defaultgrade ?? 1 } : null;
    },
    solve() { impl.solve(); },
  };
}

// ------------------------------------------------------------------ per type

let uid = 0;

function trueFalse(q, root, solution) {
  const name = `tf${++uid}`;
  const opts = [true, false].map((v) => {
    const input = h("input", { type: "radio", name, value: String(v), disabled: solution });
    const row = h("label", { class: "choice" }, input, h("span", {}, v ? "True" : "False"));
    return { v, input, row };
  });
  root.append(h("div", { class: "instruction" }, "Select one:"), ...opts.map((o) => o.row));
  return {
    solve() { for (const o of opts) { o.input.checked = o.v === q.correct; o.row.classList.toggle("is-correct", o.v === q.correct); } },
    check() {
      const sel = opts.find((o) => o.input.checked);
      for (const o of opts) {
        o.row.classList.remove("is-correct", "is-wrong");
        o.row.querySelector(".afb")?.remove();
      }
      if (!sel) return { fraction: 0 };
      sel.row.classList.add(sel.v === q.correct ? "is-correct" : "is-wrong");
      const fb = sel.v ? q.feedback_true : q.feedback_false;
      if (fb) sel.row.append(h("span", { class: "afb", html: renderHtml(fb, q.files) }));
      return { fraction: sel.v === q.correct ? 1 : 0 };
    },
    solutionText: () => `The correct answer is '${q.correct ? "True" : "False"}'.`,
  };
}

function multiChoice(q, root, solution) {
  const multiple = q.type === "multichoiceset" || q.single === false;
  const name = `mc${++uid}`;
  let answers = q.answers.map((a, i) => ({ ...a, i }));
  if (q.shuffleanswers && !solution) answers = shuffle(answers);
  const rows = answers.map((a, idx) => {
    const input = h("input", { type: multiple ? "checkbox" : "radio", name, disabled: solution });
    const row = h("label", { class: "choice" }, input,
      h("span", { class: "num" }, numbering(q.answernumbering, idx)),
      h("span", { html: renderHtml(a.text, q.files) }));
    return { a, input, row };
  });
  if (q.showstandardinstruction !== false) root.append(h("div", { class: "instruction" }, multiple ? "Select one or more:" : "Select one:"));
  root.append(...rows.map((r) => r.row));
  const isRight = (a) => Number(a.fraction) > 0;
  return {
    solve() {
      for (const r of rows) {
        r.input.checked = multiple ? isRight(r.a) : Number(r.a.fraction) >= 100;
        r.row.classList.toggle("is-correct", r.input.checked);
      }
    },
    check() {
      let fraction = 0, numCorrect = 0;
      const numTotal = rows.filter((r) => isRight(r.a)).length;
      for (const r of rows) {
        r.row.classList.remove("is-correct", "is-wrong");
        r.row.querySelector(".afb")?.remove();
        if (!r.input.checked) continue;
        r.row.classList.add(isRight(r.a) ? "is-correct" : "is-wrong");
        if (isRight(r.a)) numCorrect++;
        if (r.a.feedback) r.row.append(h("span", { class: "afb", html: renderHtml(r.a.feedback, q.files) }));
        fraction += Number(r.a.fraction) / 100;
      }
      if (q.type === "multichoiceset") {
        const allRight = rows.every((r) => r.input.checked === isRight(r.a));
        fraction = allRight ? 1 : 0;
      }
      return { fraction: Math.max(0, Math.min(1, fraction)), numCorrect, numTotal };
    },
    solutionText: () => {
      const right = q.answers.filter((a) => (multiple ? isRight(a) : Number(a.fraction) >= 100)).map((a) => stripHtml(a.text));
      return right.length > 1 ? `The correct answers are: ${right.join(", ")}` : `The correct answer is: ${right[0] ?? "–"}`;
    },
  };
}

function shortAnswer(q, root, solution) {
  const input = h("input", { type: "text", style: { width: "min(100%, 420px)" }, disabled: solution, placeholder: "Answer" });
  const mark = h("span", { class: "mark" });
  root.append(h("div", { class: "row" }, h("label", {}, "Answer:"), input, mark));
  const best = () => [...q.answers].sort((a, b) => b.fraction - a.fraction)[0];
  return {
    solve() { input.value = best()?.text.replaceAll("*", " ") ?? ""; input.classList.add("is-correct"); },
    check() {
      input.classList.remove("is-correct", "is-wrong");
      mark.textContent = "";
      const value = input.value;
      const hit = value.trim() ? q.answers.find((a) => a.text && wildcardMatch(a.text, value, q.usecase)) : null;
      const fraction = hit ? Number(hit.fraction) / 100 : 0;
      input.classList.add(fraction > 0 ? "is-correct" : "is-wrong");
      mark.className = "mark " + (fraction > 0 ? "ok" : "bad");
      mark.textContent = fraction > 0 ? "✓" : "✗";
      if (hit?.feedback) mark.append(h("span", { class: "afb", html: renderHtml(hit.feedback, q.files) }));
      return { fraction };
    },
    solutionText: () => `Accepted answers: ${q.answers.filter((a) => a.fraction > 0).map((a) => `${a.text}${a.fraction < 100 ? ` (${a.fraction}%)` : ""}`).join("  |  ")}` + (q.usecase ? " (case sensitive)" : ""),
  };
}

function matching(q, root, solution) {
  const subs = q.subquestions.filter((s) => stripHtml(s.text) || /<img/i.test(s.text || ""));
  let choices = [...new Set(q.subquestions.map((s) => s.answer).filter((a) => a !== ""))];
  choices = q.shuffleanswers && !solution ? shuffle(choices) : choices.sort((a, b) => a.localeCompare(b));
  const order = q.shuffleanswers && !solution ? shuffle(subs) : subs;
  const rows = order.map((s) => {
    const select = h("select", { disabled: solution },
      h("option", { value: "" }, "Choose…"),
      ...choices.map((c) => h("option", { value: c }, c)));
    const mark = h("span", { class: "mark" });
    const tr = h("tr", {}, h("td", { html: renderHtml(s.text, q.files) }), h("td", {}, select, mark));
    return { s, select, mark, tr };
  });
  root.append(h("table", { class: "match" }, h("tbody", {}, rows.map((r) => r.tr))));
  if (solution) {
    // The solution view shows the correct assignments; also list the remaining (wrong) options.
    const used = new Set(subs.map((s) => s.answer));
    const unused = choices.filter((c) => !used.has(c));
    if (unused.length) {
      root.append(h("div", { class: "match-unused" },
        h("span", { class: "muted small" }, "Not assigned:"), unused.map((c) => h("span", { class: "opt" }, c))));
    }
  }
  return {
    solve() { for (const r of rows) { r.select.value = r.s.answer; r.tr.classList.add("is-correct"); } },
    check() {
      let n = 0;
      for (const r of rows) {
        const ok = r.select.value === r.s.answer;
        if (ok) n++;
        r.tr.classList.toggle("is-correct", ok);
        r.tr.classList.toggle("is-wrong", !ok);
        r.mark.className = "mark " + (ok ? "ok" : "bad");
        r.mark.textContent = ok ? "✓" : "✗";
      }
      return { fraction: rows.length ? n / rows.length : 0, numCorrect: n, numTotal: rows.length };
    },
  };
}

// ---- drag and drop onto image

const measureCtx = document.createElement("canvas").getContext("2d");
function textWidth(text) {
  measureCtx.font = "14.4px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  return measureCtx.measureText(text).width;
}

export function dragSize(drag) {
  if (drag.image?.data) return { w: 80, h: 60 };
  return { w: Math.ceil(textWidth(drag.text || "") + 26), h: 30 };
}

function ddImageOrText(q, root, solution) {
  const dragByNo = Object.fromEntries(q.drags.map((d) => [d.no, d]));
  const groupOf = (drop) => dragByNo[drop.choice]?.draggroup ?? 1;
  // Size of every drop zone = largest drag item of its group (like Moodle).
  const groupSize = {};
  for (const d of q.drags) {
    const s = dragSize(d), g = groupSize[d.draggroup] || { w: 0, h: 0 };
    groupSize[d.draggroup] = { w: Math.max(g.w, s.w), h: Math.max(g.h, s.h) };
  }
  const placed = q.drops.map(() => null); // drag no per drop
  let selected = null;

  const stage = h("div", { class: "dd-stage" });
  if (q.background?.data) stage.append(h("img", { class: "bg", src: dataUrl(q.background.name, q.background.data), draggable: false, alt: "" }));
  else stage.append(h("div", { class: "muted", style: { padding: "40px", border: "1px dashed var(--border)" } }, "No background image"));

  const dropEls = q.drops.map((drop, idx) => {
    const size = groupSize[groupOf(drop)] || { w: 60, h: 28 };
    const el = h("div", {
      class: "dd-drop",
      style: { left: drop.xleft + "px", top: drop.ytop + "px", width: size.w + 6 + "px", height: size.h + 6 + "px" },
    });
    if (!solution) {
      el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
      el.addEventListener("dragleave", () => el.classList.remove("over"));
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        el.classList.remove("over");
        const [src, val] = e.dataTransfer.getData("text/plain").split(":");
        const no = src === "drop" ? placed[+val] : +val;
        if (src === "drop") placed[+val] = null;
        place(idx, no);
      });
      el.addEventListener("click", () => {
        if (selected !== null) { place(idx, selected); selected = null; draw(); }
        else if (placed[idx] !== null) { placed[idx] = null; draw(); }
      });
    }
    stage.append(el);
    return el;
  });

  // Drop zones may extend beyond the image; grow the stage so nothing is clipped.
  const extent = q.drops.reduce((m, d) => {
    const size = groupSize[groupOf(d)] || { w: 60, h: 28 };
    return { w: Math.max(m.w, d.xleft + size.w + 10), h: Math.max(m.h, d.ytop + size.h + 10) };
  }, { w: 0, h: 0 });
  Object.assign(stage.style, { minWidth: extent.w + "px", minHeight: extent.h + "px" });

  const palette = h("div", { class: "dd-palette" });
  if (!solution) {
    palette.addEventListener("dragover", (e) => e.preventDefault());
    palette.addEventListener("drop", (e) => {
      e.preventDefault();
      const [src, val] = e.dataTransfer.getData("text/plain").split(":");
      if (src === "drop") { placed[+val] = null; draw(); }
    });
  }

  function place(idx, no) {
    const drag = dragByNo[no];
    if (!drag || drag.draggroup !== groupOf(q.drops[idx])) { draw(); return; }
    if (!drag.infinite) placed.forEach((p, i) => { if (p === no) placed[i] = null; });
    placed[idx] = no;
    draw();
  }

  function chip(drag, origin) {
    const c = h("div", { class: `dd-chip g${((drag.draggroup - 1) % 8) + 1}`, draggable: !solution });
    if (drag.image?.data) c.append(h("img", { src: dataUrl(drag.image.name, drag.image.data), alt: drag.text, draggable: false }));
    else c.textContent = drag.text;
    if (!solution) {
      c.addEventListener("dragstart", (e) => e.dataTransfer.setData("text/plain", origin));
      if (origin.startsWith("palette")) {
        c.addEventListener("click", () => { selected = selected === drag.no ? null : drag.no; draw(); });
        if (selected === drag.no) c.classList.add("selected");
      }
    }
    return c;
  }

  function draw() {
    dropEls.forEach((el, idx) => {
      el.innerHTML = "";
      el.classList.remove("is-correct", "is-wrong");
      if (placed[idx] !== null) el.append(chip(dragByNo[placed[idx]], `drop:${idx}`));
    });
    palette.innerHTML = "";
    const used = new Set(placed.filter((p) => p !== null));
    for (const d of paletteOrder) if (d.infinite || !used.has(d.no)) palette.append(chip(d, `palette:${d.no}`));
    if (!palette.childNodes.length) palette.append(h("span", { class: "muted small" }, solution ? "" : "All items placed"));
  }

  const paletteOrder = q.shuffleanswers && !solution ? shuffle(q.drags) : [...q.drags];
  root.append(h("div", { class: "dd-wrap" }, stage), palette);
  if (!solution) root.append(h("div", { class: "muted small" }, "Drag the items onto the image, or click an item and then a drop zone. Click a placed item to remove it."));
  draw();

  return {
    solve() { q.drops.forEach((d, i) => { placed[i] = d.choice; }); draw(); dropEls.forEach((el) => el.classList.add("is-correct")); },
    check() {
      draw();
      let n = 0;
      q.drops.forEach((d, i) => {
        const ok = placed[i] === d.choice;
        if (ok) n++;
        dropEls[i].classList.add(ok ? "is-correct" : "is-wrong");
      });
      return { fraction: q.drops.length ? n / q.drops.length : 0, numCorrect: n, numTotal: q.drops.length };
    },
  };
}

// ---- gaps inside the question text (gapselect, cloze)

/** Replace gap markers in the question text by placeholders and return them in order. */
function fillGaps(q, root, re, toGap) {
  const gaps = [];
  const marked = (q.questiontext || "").replace(re, (...m) => {
    gaps.push(toGap(...m));
    return `<span data-qmgap="${gaps.length - 1}"></span>`;
  });
  const qtext = root.querySelector(".qtext");
  qtext.innerHTML = renderHtml(marked, q.files);
  return { gaps, slots: [...qtext.querySelectorAll("[data-qmgap]")] };
}

function markGap(el, ok, partial = false) {
  el.classList.remove("is-correct", "is-wrong", "is-partial");
  el.classList.add(ok ? "is-correct" : partial ? "is-partial" : "is-wrong");
}

function gapSelect(q, root, solution) {
  const options = q.options || [];
  const { gaps, slots } = fillGaps(q, root, /\[\[(\d+)\]\]/g, (_m, n) => options[Number(n) - 1] || null);
  const controls = gaps.map((opt, i) => {
    const group = opt?.group ?? 1;
    let texts = [...new Set(options.filter((o) => o.group === group).map((o) => o.text))];
    if (q.shuffleanswers && !solution) texts = shuffle(texts);
    const sel = h("select", { class: "gap", disabled: solution }, h("option", { value: "" }, " "), texts.map((t) => h("option", { value: t }, t)));
    slots[i].replaceWith(sel);
    return { sel, correct: opt?.text ?? null };
  });
  if (solution) {
    // The drop-downs show the correct answers; also list the remaining (wrong) options, per group.
    const used = new Set(controls.map((c) => c.correct));
    const groups = [...new Set(options.map((o) => o.group))].sort((a, b) => a - b);
    const chips = [];
    for (const g of groups) {
      const unused = [...new Set(options.filter((o) => o.group === g && !used.has(o.text)).map((o) => o.text))];
      if (!unused.length) continue;
      if (groups.length > 1) chips.push(h("span", { class: "muted small" }, `Group ${g}:`));
      chips.push(...unused.map((t) => h("span", { class: "opt" }, t)));
    }
    if (chips.length) root.append(h("div", { class: "match-unused" }, h("span", { class: "muted small" }, "Not assigned:"), chips));
  }
  return {
    solve() { for (const c of controls) { c.sel.value = c.correct ?? ""; markGap(c.sel, c.correct !== null); } },
    check() {
      let n = 0;
      for (const c of controls) { const ok = c.sel.value !== "" && c.sel.value === c.correct; if (ok) n++; markGap(c.sel, ok); }
      return { fraction: controls.length ? n / controls.length : 0, numCorrect: n, numTotal: controls.length };
    },
  };
}

function numberMatch(a, input) {
  if (a.text.trim() === "*") return true;
  const v = Number(String(input).trim().replace(",", "."));
  return input.trim() !== "" && !Number.isNaN(v) && Math.abs(v - a.value) <= Math.abs(a.tolerance) + 1e-12;
}

let gapUid = 0;
function cloze(q, root, solution) {
  const { gaps, slots } = fillGaps(q, root, new RegExp(GAP_RE.source, "gs"), (_m, w, t, body) => parseGap(w, t, body));
  const controls = gaps.map((g, i) => {
    const name = `cz${++gapUid}`;
    let answers = g.answers.map((a, k) => ({ ...a, k }));
    if (g.shuffle && !solution) answers = shuffle(answers);
    let el, get, set;
    if (g.kind === "shortanswer" || g.kind === "numerical") {
      const size = Math.max(6, ...g.answers.map((a) => a.text.length)) + 2;
      el = h("input", { type: "text", class: "gap", size, disabled: solution });
      get = () => el.value;
      set = (best) => { el.value = g.kind === "numerical" ? String(best.value) : best.text.replaceAll("*", "").trim(); };
    } else if (g.kind === "select") {
      el = h("select", { class: "gap", disabled: solution }, h("option", { value: "" }, " "), answers.map((a) => h("option", { value: a.k }, a.text)));
      get = () => el.value;
      set = (best) => { el.value = String(best.k ?? g.answers.indexOf(best)); };
    } else {
      const multi = g.kind.startsWith("checkbox");
      const vertical = g.kind.endsWith("_v");
      const inputs = answers.map((a) => ({ a, input: h("input", { type: multi ? "checkbox" : "radio", name, disabled: solution }) }));
      el = h(vertical ? "div" : "span", { class: "gap gap-choices" + (vertical ? " vertical" : "") },
        inputs.map(({ a, input }) => h("label", { class: "check" }, input, a.text)));
      get = () => inputs.filter((x) => x.input.checked).map((x) => x.a.k);
      set = () => { for (const x of inputs) x.input.checked = multi ? x.a.fraction > 0 : x.a.fraction >= 100; };
    }
    slots[i].replaceWith(el);
    return { g, el, get, set };
  });

  function grade(c) {
    const { g } = c;
    const value = c.get();
    if (g.kind === "shortanswer") {
      const hit = value.trim() ? g.answers.find((a) => a.text && wildcardMatch(a.text, value, g.caseSensitive)) : null;
      return { fraction: hit ? hit.fraction / 100 : 0, feedback: hit?.feedback };
    }
    if (g.kind === "numerical") {
      const hit = g.answers.find((a) => numberMatch(a, value));
      return { fraction: hit ? hit.fraction / 100 : 0, feedback: hit?.feedback };
    }
    if (g.kind === "select") {
      const a = value === "" ? null : g.answers[Number(value)];
      return { fraction: a ? a.fraction / 100 : 0, feedback: a?.feedback };
    }
    const chosen = value.map((k) => g.answers[k]);
    const sum = chosen.reduce((s, a) => s + a.fraction, 0) / 100;
    return { fraction: Math.max(0, Math.min(1, sum)), feedback: chosen.map((a) => a.feedback).filter(Boolean).join(" ") };
  }

  return {
    solve() { for (const c of controls) { const best = bestAnswer(c.g); if (best) c.set({ ...best, k: c.g.answers.indexOf(best) }); markGap(c.el, true); } },
    check() {
      let got = 0, total = 0, n = 0;
      for (const c of controls) {
        const r = grade(c);
        got += r.fraction * c.g.weight;
        total += c.g.weight;
        if (r.fraction >= 1) n++;
        markGap(c.el, r.fraction >= 1, r.fraction > 0);
        c.el.title = r.feedback || "";
      }
      return { fraction: total ? got / total : 0, numCorrect: n, numTotal: controls.length };
    },
    solutionText: () => "Correct answers: " + controls.map((c, i) => {
      const right = c.g.kind.startsWith("checkbox") ? c.g.answers.filter((a) => a.fraction > 0) : c.g.answers.filter((a) => a.fraction >= 100);
      return `(${i + 1}) ${right.map((a) => (c.g.kind === "numerical" ? `${a.value}${a.tolerance ? ` ± ${a.tolerance}` : ""}` : a.text)).join(" / ") || "–"}`;
    }).join("   "),
  };
}

function essay(q, root, solution) {
  const fmt = q.responseformat || "editor";
  if (fmt !== "noinline") {
    const area = h("textarea", { class: "essay" + (fmt === "monospaced" ? " mono" : ""), rows: q.responsefieldlines || 10, disabled: solution, value: stripHtml(q.responsetemplate || "") });
    root.append(area);
  }
  const notes = [];
  if (q.minwordlimit) notes.push(`at least ${q.minwordlimit} words`);
  if (q.maxwordlimit) notes.push(`at most ${q.maxwordlimit} words`);
  if (q.attachments) notes.push(q.attachments === -1 ? "file uploads allowed" : `up to ${q.attachments} file upload(s)`);
  if (notes.length) root.append(h("div", { class: "muted small" }, notes.join(" · ")));
  const info = h("div", { class: "fb hidden" }, h("strong", {}, "Information for graders: "), h("div", { html: renderHtml(q.graderinfo || "<p>–</p>", q.files) }));
  root.append(info);
  const reveal = () => info.classList.remove("hidden");
  return {
    solve: reveal,
    check() { reveal(); return null; },  // graded manually
  };
}

const RENDERERS = {
  truefalse: trueFalse,
  multichoice: multiChoice,
  multichoiceset: multiChoice,
  shortanswer: shortAnswer,
  matching,
  ddimageortext: ddImageOrText,
  gapselect: gapSelect,
  cloze,
  essay,
};

export function questionSummary(q) {
  return stripHtml(q.questiontext) || escapeHtml(q.name || "");
}

// ---- usage in quizzes (shading + counter)

/** CSS class shading a question card by the number of quizzes (incl. archived) it is used in. */
export function usageClass(q) {
  const n = q.quiz_count || 0;
  return n ? ` used-${Math.min(n, 3)}` : "";
}

/** Small counter: "2×" plus how many of those quizzes are archived. */
export function usageBadge(q) {
  const n = q.quiz_count || 0;
  const archived = q.archived_count || 0;
  const title = n
    ? `Used in ${n} quiz${n > 1 ? "zes" : ""}` + (archived ? ` (${archived} archived, ${n - archived} active)` : "")
    : "Not used in any quiz yet";
  return h("span", { class: "usage-count" + (n ? "" : " unused"), title },
    `${n}×`, archived ? h("span", { class: "archived-part" }, ` · ${archived} 🗄`) : null);
}
