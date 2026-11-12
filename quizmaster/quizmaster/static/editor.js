// Question editor dialog.
import { h, api, toast, richEditor, modal, clone, stripHtml, pickFile, readFileAsBase64, dataUrl, uniqueName, confirmDialog } from "./util.js";
import { renderQuestion, TYPE_LABELS, dragSize } from "./render.js";
import { store, lastCategory, rememberCategory } from "./store.js";
import { parseGaps, clozeProblems, totalWeight, KIND_LABELS } from "./cloze.js";

const PENALTIES = [1, 0.5, 0.3333333, 0.25, 0.2, 0.1, 0];
const GRADES = [100, 90, 83.33333, 80, 75, 70, 66.66667, 60, 50, 40, 33.33333, 30, 25, 20, 16.66667, 14.28571, 12.5, 11.11111, 10, 5, 0];
const NUMBERING = { abc: "a., b., c., …", ABCD: "A., B., C., …", 123: "1., 2., 3., …", iii: "i., ii., iii., …", IIII: "I., II., III., …", none: "No numbering" };

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-4;

function gradeSelect(value, negative = false) {
  const list = negative ? [...GRADES, ...GRADES.slice(0, -1).reverse().map((g) => -g)] : [...GRADES];
  if (!list.some((g) => near(g, value))) list.push(Number(value));
  const sel = h("select", {}, list.map((g) => h("option", { value: g, selected: near(g, value) }, g === 0 ? "None (0%)" : `${g}%`)));
  return { el: sel, get: () => Number(sel.value) };
}

function field(label, control, hint) {
  return h("div", { class: "field" }, h("label", {}, label), control, hint && h("div", { class: "muted small" }, hint));
}

function checkbox(label, checked) {
  const input = h("input", { type: "checkbox", checked: !!checked });
  return { el: h("label", { class: "check" }, input, label), get: () => input.checked };
}

function moveItem(arr, i, delta) {
  const j = i + delta;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

function itemButtons(arr, i, sync, render) {
  const act = (fn) => () => { sync(); fn(); render(); };
  return [
    h("button", { type: "button", class: "icon", title: "Move up", disabled: i === 0, onclick: act(() => moveItem(arr, i, -1)) }, "↑"),
    h("button", { type: "button", class: "icon", title: "Move down", disabled: i === arr.length - 1, onclick: act(() => moveItem(arr, i, 1)) }, "↓"),
    h("button", { type: "button", class: "icon danger", title: "Remove", onclick: act(() => arr.splice(i, 1)) }, "✕"),
  ];
}

// --------------------------------------------------------------------------- type sections

function trueFalseSection(q, files) {
  const name = "tfcorrect" + Math.random();
  const t = h("input", { type: "radio", name, checked: q.correct !== false });
  const f = h("input", { type: "radio", name, checked: q.correct === false });
  const fbT = richEditor(q.feedback_true, files, { small: true });
  const fbF = richEditor(q.feedback_false, files, { small: true });
  const el = h("fieldset", {}, h("legend", {}, "Answer"),
    h("div", { class: "row", style: { marginBottom: "12px" } }, h("strong", {}, "Correct answer:"), h("label", { class: "check" }, t, "True"), h("label", { class: "check" }, f, "False")),
    h("div", { class: "grid-4" }, field("Feedback for the response 'True'", fbT.el), field("Feedback for the response 'False'", fbF.el)));
  return { el, collect: (o) => Object.assign(o, { correct: t.checked, feedback_true: fbT.getHtml(), feedback_false: fbF.getHtml() }) };
}

function multiChoiceSection(q, files) {
  const allOrNothing = q.type === "multichoiceset";
  const shuffleCb = checkbox("Shuffle the choices", q.shuffleanswers);
  const instrCb = checkbox("Show standard instruction (\"Select one or more:\")", q.showstandardinstruction !== false);
  const numbering = h("select", {}, Object.entries(NUMBERING).map(([k, v]) => h("option", { value: k, selected: k === (q.answernumbering || "abc") }, v)));
  const single = h("select", {}, h("option", { value: "1", selected: q.single !== false }, "One answer only"), h("option", { value: "0", selected: q.single === false }, "Multiple answers allowed"));
  const layout = h("select", { title: "How the choices are printed in the PDF export" },
    h("option", { value: "lines", selected: q.choice_layout !== "inline" }, "One choice per line"),
    h("option", { value: "inline", selected: q.choice_layout === "inline" }, "All choices on one line"));

  let state = clone(q.answers || []);
  let rows = [];
  const list = h("div", { class: "items" });
  const sync = () => { state = rows.map((r) => r.get()); };
  const render = () => {
    list.innerHTML = "";
    rows = state.map((a, i) => {
      const text = richEditor(a.text, files, { small: true });
      const fb = richEditor(a.feedback, files, { small: true });
      let getFraction, control;
      if (allOrNothing) {
        const cb = checkbox("Correct", Number(a.fraction) > 0);
        control = cb.el;
        getFraction = () => (cb.get() ? 100 : 0);
        cb.el.querySelector("input").addEventListener("change", (e) => item.classList.toggle("correct", e.target.checked));
      } else {
        const g = gradeSelect(a.fraction, true);
        control = h("span", { class: "row" }, h("label", {}, "Grade"), g.el);
        getFraction = g.get;
        g.el.addEventListener("change", () => item.classList.toggle("correct", g.get() > 0));
      }
      const item = h("div", { class: "item" + (Number(a.fraction) > 0 ? " correct" : "") },
        h("div", { class: "item-head" }, h("span", { class: "title" }, `Choice ${i + 1}`), control, h("span", { class: "spacer" }), itemButtons(state, i, sync, render)),
        text.el,
        h("details", { open: !!a.feedback }, h("summary", { class: "small muted" }, "Feedback for this choice"), fb.el));
      list.append(item);
      return { get: () => ({ text: text.getHtml(), fraction: getFraction(), feedback: fb.getHtml() }) };
    });
  };
  render();
  const add = h("button", { type: "button", onclick: () => { sync(); state.push({ text: "", fraction: 0, feedback: "" }); render(); } }, "+ Add choice");

  const el = h("fieldset", {}, h("legend", {}, "Choices"),
    allOrNothing
      ? h("p", { class: "hint" }, "All-or-nothing: the student gets full marks only if exactly the correct choices are selected.")
      : null,
    h("div", { class: "grid-4" },
      !allOrNothing && field("One or multiple answers?", single),
      field("Numbering", numbering),
      field("PDF layout", layout),
      h("div", { class: "field" }, h("label", {}, "Options"), shuffleCb.el, instrCb.el)),
    list, h("div", { style: { marginTop: "10px" } }, add));

  return {
    el,
    collect(o) {
      sync();
      o.answers = state.filter((a) => stripHtml(a.text) || /<img/i.test(a.text));
      o.shuffleanswers = shuffleCb.get();
      o.showstandardinstruction = instrCb.get();
      o.answernumbering = numbering.value;
      if (layout.value === "inline") o.choice_layout = "inline"; else delete o.choice_layout;
      if (!allOrNothing) { if (single.value === "0") o.single = false; else delete o.single; }
    },
  };
}

function shortAnswerSection(q, files) {
  const usecase = h("select", {}, h("option", { value: "0", selected: !q.usecase }, "No, case is unimportant"), h("option", { value: "1", selected: !!q.usecase }, "Yes, case must match"));
  let state = clone(q.answers || []);
  let rows = [];
  const list = h("div", { class: "items" });
  const sync = () => { state = rows.map((r) => r.get()); };
  const render = () => {
    list.innerHTML = "";
    rows = state.map((a, i) => {
      const input = h("input", { type: "text", value: a.text, style: { flex: "1", minWidth: "200px" }, placeholder: "e.g. *wide*area*network*" });
      const g = gradeSelect(a.fraction);
      const fb = richEditor(a.feedback, files, { small: true });
      const item = h("div", { class: "item" + (a.fraction > 0 ? " correct" : "") },
        h("div", { class: "item-head" }, h("span", { class: "title" }, `Answer ${i + 1}`), input, h("label", {}, "Grade"), g.el, itemButtons(state, i, sync, render)),
        h("details", { open: !!a.feedback }, h("summary", { class: "small muted" }, "Feedback"), fb.el));
      g.el.addEventListener("change", () => item.classList.toggle("correct", g.get() > 0));
      list.append(item);
      return { get: () => ({ text: input.value, fraction: g.get(), feedback: fb.getHtml() }) };
    });
  };
  render();
  const add = h("button", { type: "button", onclick: () => { sync(); state.push({ text: "", fraction: 100, feedback: "" }); render(); } }, "+ Add answer");
  const el = h("fieldset", {}, h("legend", {}, "Answers"),
    h("p", { class: "hint" }, "Use * as a wildcard matching any characters, e.g. *wide*area*network* accepts \"Wide Area Network\". Answers are checked from top to bottom; the first match wins."),
    field("Case sensitivity", usecase), list, h("div", { style: { marginTop: "10px" } }, add));
  return {
    el,
    collect(o) {
      sync();
      o.usecase = usecase.value === "1";
      o.answers = state.filter((a) => a.text.trim());
    },
  };
}

function matchingSection(q, files) {
  const shuffleCb = checkbox("Shuffle", q.shuffleanswers);
  let state = clone(q.subquestions || []);
  let rows = [];
  const list = h("div", { class: "items" });
  const sync = () => { state = rows.map((r) => r.get()); };
  const render = () => {
    list.innerHTML = "";
    rows = state.map((s, i) => {
      const text = richEditor(s.text, files, { small: true, placeholder: "Question (leave empty for a distractor answer)" });
      const ans = h("input", { type: "text", value: s.answer, style: { flex: "1" }, placeholder: "Matching answer" });
      list.append(h("div", { class: "item" },
        h("div", { class: "item-head" }, h("span", { class: "title" }, `Pair ${i + 1}`), h("span", { class: "spacer" }), itemButtons(state, i, sync, render)),
        text.el,
        h("div", { class: "row", style: { marginTop: "6px" } }, h("label", {}, "Answer"), ans)));
      return { get: () => ({ text: text.getHtml(), answer: ans.value }) };
    });
  };
  render();
  const add = h("button", { type: "button", onclick: () => { sync(); state.push({ text: "", answer: "" }); render(); } }, "+ Add pair");
  const el = h("fieldset", {}, h("legend", {}, "Pairs"),
    h("p", { class: "hint" }, "Provide at least 2 questions and 3 answers. Pairs with an empty question are extra (wrong) answers shown in every drop-down."),
    h("div", { class: "row", style: { marginBottom: "10px" } }, shuffleCb.el), list, h("div", { style: { marginTop: "10px" } }, add));
  return {
    el,
    collect(o) {
      sync();
      o.shuffleanswers = shuffleCb.get();
      o.subquestions = state.filter((s) => s.answer.trim() || stripHtml(s.text));
    },
  };
}

function ddSection(q) {
  const shuffleCb = checkbox("Shuffle drag items each time the question is attempted", q.shuffleanswers);
  let background = q.background ? { ...q.background } : null;
  let drags = clone(q.drags || []);
  let drops = clone(q.drops || []);
  let activeDrop = -1;

  const bgInfo = h("span", { class: "muted small" });
  const stageWrap = h("div", { class: "dd-wrap", style: { maxHeight: "560px", overflow: "auto", marginTop: "10px" } });
  const dragList = h("div");
  const dropList = h("div");

  const renumber = () => drags.forEach((d, i) => { d.no = i + 1; });
  const dragLabel = (no) => drags.find((d) => d.no === no)?.text || (drags.find((d) => d.no === no)?.image ? "[image]" : `#${no}`);

  async function uploadBg() {
    const [file] = await pickFile("image/*");
    if (!file) return;
    background = { name: file.name.replace(/[^\w.\-]+/g, "_"), data: await readFileAsBase64(file) };
    drawStage();
  }

  function drawDrags() {
    dragList.innerHTML = "";
    const tbody = h("tbody");
    drags.forEach((d, i) => {
      const text = h("input", { type: "text", value: d.text, placeholder: "Text", oninput: () => { d.text = text.value; drawStage(); drawDrops(); } });
      const group = h("select", { onchange: () => { d.draggroup = +group.value; drawStage(); } }, [1, 2, 3, 4, 5, 6, 7, 8].map((g) => h("option", { value: g, selected: g === d.draggroup }, g)));
      const inf = h("input", { type: "checkbox", checked: !!d.infinite, onchange: () => { d.infinite = inf.checked; } });
      const imgCell = h("td", {});
      if (d.image?.data) {
        imgCell.append(h("img", { src: dataUrl(d.image.name, d.image.data), style: { maxHeight: "32px", verticalAlign: "middle" } }),
          h("button", { type: "button", class: "icon", title: "Remove image", onclick: () => { delete d.image; drawAll(); } }, "✕"));
      } else {
        imgCell.append(h("button", { type: "button", class: "icon", title: "Use an image instead of text", onclick: async () => {
          const [file] = await pickFile("image/*");
          if (!file) return;
          d.image = { name: file.name.replace(/[^\w.\-]+/g, "_"), data: await readFileAsBase64(file) };
          drawAll();
        } }, "🖼"));
      }
      const remove = h("button", { type: "button", class: "icon danger", title: "Remove item", onclick: () => {
        const removed = d.no;
        drags.splice(i, 1);
        drops = drops.filter((dr) => dr.choice !== removed).map((dr) => ({ ...dr, choice: dr.choice > removed ? dr.choice - 1 : dr.choice }));
        renumber();
        drawAll();
      } }, "✕");
      tbody.append(h("tr", {}, h("td", {}, h("strong", {}, d.no)), h("td", {}, text), imgCell, h("td", {}, group), h("td", {}, inf), h("td", {}, remove)));
    });
    dragList.append(
      drags.length
        ? h("table", { class: "simple" }, h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Text"), h("th", {}, "Image"), h("th", {}, "Group"), h("th", { title: "Can be used multiple times" }, "Unlimited"), h("th"))), tbody)
        : h("p", { class: "muted small" }, "No drag items yet."),
      h("button", { type: "button", style: { marginTop: "8px" }, onclick: () => { drags.push({ no: drags.length + 1, text: "", draggroup: 1, infinite: false }); drawAll(); dragList.querySelectorAll("input[type=text]")[drags.length - 1]?.focus(); } }, "+ Add drag item"),
    );
  }

  function drawDrops() {
    dropList.innerHTML = "";
    const tbody = h("tbody");
    drops.forEach((d, i) => {
      const choice = h("select", { onchange: () => { d.choice = +choice.value; drawStage(); } },
        h("option", { value: 0, selected: !d.choice }, "— choose —"),
        drags.map((g) => h("option", { value: g.no, selected: g.no === d.choice }, `${g.no}. ${dragLabel(g.no)}`)));
      const x = h("input", { type: "number", value: d.xleft, min: 0, oninput: () => { d.xleft = +x.value || 0; drawStage(); } });
      const y = h("input", { type: "number", value: d.ytop, min: 0, oninput: () => { d.ytop = +y.value || 0; drawStage(); } });
      const remove = h("button", { type: "button", class: "icon danger", title: "Remove drop zone", onclick: () => { drops.splice(i, 1); drops.forEach((dr, k) => { dr.no = k + 1; }); drawAll(); } }, "✕");
      const tr = h("tr", { style: i === activeDrop ? { background: "var(--accent-soft)" } : {} }, h("td", {}, h("strong", {}, i + 1)), h("td", {}, choice), h("td", {}, x), h("td", {}, y), h("td", {}, remove));
      tbody.append(tr);
    });
    dropList.append(drops.length
      ? h("table", { class: "simple" }, h("thead", {}, h("tr", {}, h("th", {}, "Zone"), h("th", {}, "Correct item"), h("th", {}, "Left (x)"), h("th", {}, "Top (y)"), h("th"))), tbody)
      : h("p", { class: "muted small" }, "No drop zones yet. Click on the image to add one."));
  }

  function drawStage() {
    stageWrap.innerHTML = "";
    bgInfo.textContent = background ? background.name : "No image selected";
    if (!background?.data) {
      stageWrap.append(h("div", { class: "dropzone" }, "Upload a background image to place drop zones."));
      return;
    }
    const img = h("img", { src: dataUrl(background.name, background.data), draggable: false, alt: "" });
    const stage = h("div", { class: "dd-editor-stage" }, img);
    const scale = () => (img.naturalWidth && img.clientWidth ? img.naturalWidth / img.clientWidth : 1);

    stage.addEventListener("click", (e) => {
      if (e.target !== img) return;
      const r = img.getBoundingClientRect();
      const used = new Set(drops.map((d) => d.choice));
      const next = drags.find((d) => !used.has(d.no)) || drags[0];
      drops.push({ no: drops.length + 1, text: "", choice: next ? next.no : 0, xleft: Math.round((e.clientX - r.left) * scale()), ytop: Math.round((e.clientY - r.top) * scale()) });
      activeDrop = drops.length - 1;
      drawStage();
      drawDrops();
    });

    drops.forEach((d, i) => {
      const drag = drags.find((g) => g.no === d.choice);
      const size = drag ? dragSize(drag) : { w: 60, h: 28 };
      const marker = h("div", {
        class: `dd-marker g${(((drag?.draggroup || 1) - 1) % 8) + 1}` + (i === activeDrop ? " active" : ""),
        style: { left: d.xleft + "px", top: d.ytop + "px", minWidth: size.w + "px" },
        title: "Drag to move",
      }, h("span", { class: "n" }, `${i + 1}`), drag ? dragLabel(drag.no) : "?");
      marker.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        marker.setPointerCapture(e.pointerId);
        const s = scale();
        const start = { x: e.clientX, y: e.clientY, l: d.xleft, t: d.ytop };
        activeDrop = i;
        stage.querySelectorAll(".dd-marker").forEach((m) => m.classList.remove("active"));
        marker.classList.add("active");
        const move = (ev) => {
          d.xleft = Math.max(0, Math.round(start.l + (ev.clientX - start.x) * s));
          d.ytop = Math.max(0, Math.round(start.t + (ev.clientY - start.y) * s));
          marker.style.left = d.xleft / s + "px";
          marker.style.top = d.ytop / s + "px";
        };
        const up = () => {
          marker.removeEventListener("pointermove", move);
          marker.removeEventListener("pointerup", up);
          drawDrops();
        };
        marker.addEventListener("pointermove", move);
        marker.addEventListener("pointerup", up);
      });
      stage.append(marker);
    });
    const extent = drops.reduce((m, d) => ({ w: Math.max(m.w, d.xleft + 200), h: Math.max(m.h, d.ytop + 40) }), { w: 0, h: 0 });
    Object.assign(stage.style, { minWidth: extent.w + "px", minHeight: extent.h + "px" });
    img.addEventListener("load", () => {
      const s = scale();
      if (s !== 1) stage.querySelectorAll(".dd-marker").forEach((m, i) => { m.style.left = drops[i].xleft / s + "px"; m.style.top = drops[i].ytop / s + "px"; });
    });
    stageWrap.append(stage);
  }

  const drawAll = () => { drawDrags(); drawStage(); drawDrops(); };
  drawAll();

  const el = h("div", {},
    h("fieldset", {}, h("legend", {}, "Background image"),
      h("div", { class: "row" }, h("button", { type: "button", onclick: uploadBg }, "Upload image…"), bgInfo),
      h("p", { class: "hint", style: { marginTop: "10px" } }, "Click on the image to add a drop zone (top-left corner at the click position). Drag the markers to move them. Coordinates are in image pixels, like in Moodle."),
      stageWrap),
    h("fieldset", {}, h("legend", {}, "Drag items"), h("div", { class: "row", style: { marginBottom: "8px" } }, shuffleCb.el), dragList,
      h("p", { class: "muted small" }, "Items not assigned to any drop zone act as distractors. A drop zone accepts only items of the same group as its correct item.")),
    h("fieldset", {}, h("legend", {}, "Drop zones"), dropList));

  return {
    el,
    collect(o) {
      o.shuffleanswers = shuffleCb.get();
      o.background = background;
      o.drags = drags;
      o.drops = drops.map((d, i) => ({ ...d, no: i + 1 }));
    },
  };
}

function gapSelectSection(q, files, { text }) {
  const shuffleCb = checkbox("Shuffle the options in each drop-down", q.shuffleanswers);
  let state = clone(q.options || []);
  let rows = [];
  const list = h("div", { class: "items" });
  const sync = () => { state = rows.map((r) => r.get()); };
  // Option numbers are referenced as [[n]] in the text: keep the text in step when options move.
  const remap = (mapping) => {
    text.setHtml(text.getHtml().replace(/\[\[(\d+)\]\]/g, (m, n) => (n in mapping ? (mapping[n] ? `[[${mapping[n]}]]` : "") : m)));
  };
  const render = () => {
    list.replaceChildren();
    rows = state.map((o, i) => {
      const n = i + 1;
      const input = h("input", { type: "text", value: o.text, style: { flex: "1", minWidth: "200px" }, placeholder: "Option text" });
      const group = h("select", { title: "Group: a gap offers all options of its group" }, Array.from({ length: 20 }, (_, g) => h("option", { value: g + 1, selected: g + 1 === o.group }, `Group ${g + 1}`)));
      const move = (delta) => () => {
        sync();
        const j = i + delta;
        if (j < 0 || j >= state.length) return;
        [state[i], state[j]] = [state[j], state[i]];
        remap({ [n]: j + 1, [j + 1]: n });
        render();
      };
      const remove = () => {
        sync();
        state.splice(i, 1);
        const mapping = { [n]: null };
        for (let k = n + 1; k <= state.length + 1; k++) mapping[k] = k - 1;
        remap(mapping);
        render();
      };
      list.append(h("div", { class: "item" },
        h("div", { class: "item-head", style: { marginBottom: 0 } },
          h("button", { type: "button", title: "Insert this gap into the question text at the cursor", onmousedown: (e) => e.preventDefault(), onclick: () => text.insertText(`[[${n}]]`) }, `⤵ [[${n}]]`),
          input, group,
          h("button", { type: "button", class: "icon", title: "Move up", disabled: i === 0, onclick: move(-1) }, "↑"),
          h("button", { type: "button", class: "icon", title: "Move down", disabled: i === state.length - 1, onclick: move(1) }, "↓"),
          h("button", { type: "button", class: "icon danger", title: "Remove (its gaps are removed from the text)", onclick: remove }, "✕"))));
      return { get: () => ({ text: input.value, group: Number(group.value) }) };
    });
  };
  render();
  const add = h("button", { type: "button", onclick: () => { sync(); state.push({ text: "", group: state.at(-1)?.group ?? 1 }); render(); list.querySelectorAll("input[type=text]")[state.length - 1]?.focus(); } }, "+ Add option");
  const el = h("fieldset", {}, h("legend", {}, "Options"),
    h("p", { class: "hint" }, "Write [[1]], [[2]], … in the question text where a drop-down should appear; option n is the correct answer for [[n]]. "
      + "Each drop-down lists all options of the same group. Options that are not used in the text are extra wrong choices. "
      + "Click ⤵ [[n]] to insert a gap at the cursor."),
    h("div", { class: "row", style: { marginBottom: "10px" } }, shuffleCb.el), list, h("div", { style: { marginTop: "10px" } }, add));
  return {
    el,
    collect(o) {
      sync();
      o.shuffleanswers = shuffleCb.get();
      o.options = state;
    },
  };
}

const CLOZE_TEMPLATES = [
  ["Short answer", "{1:SHORTANSWER:=answer~%50%half right#feedback}"],
  ["Short answer (case-sensitive)", "{1:SHORTANSWER_C:=Answer}"],
  ["Numerical", "{1:NUMERICAL:=42:0.5}"],
  ["Drop-down", "{1:MULTICHOICE:=right~wrong~wrong}"],
  ["Radio buttons", "{1:MULTICHOICE_V:=right~wrong~wrong}"],
  ["Multiple response", "{1:MULTIRESPONSE:%50%right~%50%also right~%-100%wrong}"],
];

function clozeSection(q, files, { text }) {
  const table = h("div");
  const refresh = () => {
    const html = text.getHtml();
    const gaps = parseGaps(html);
    const problems = clozeProblems(html);
    const answerList = (g, pick) => g.answers.filter(pick).map((a) => (g.kind === "numerical" ? `${a.value}${a.tolerance ? ` ± ${a.tolerance}` : ""}` : a.text) + (a.fraction > 0 && a.fraction < 100 ? ` (${a.fraction}%)` : "")).join(" | ");
    table.replaceChildren(
      gaps.length
        ? h("table", { class: "simple" },
          h("thead", {}, h("tr", {}, h("th", {}, "#"), h("th", {}, "Type"), h("th", {}, "Weight"), h("th", {}, "Correct"), h("th", {}, "Other answers"))),
          h("tbody", {}, gaps.map((g, i) => h("tr", {},
            h("td", {}, i + 1), h("td", {}, KIND_LABELS[g.kind] || g.type, g.caseSensitive ? " (case-sensitive)" : "", g.shuffle ? " (shuffled)" : ""),
            h("td", {}, g.weight), h("td", {}, answerList(g, (a) => a.fraction > 0) || "–"), h("td", { class: "muted" }, answerList(g, (a) => a.fraction <= 0) || "–")))))
        : null,
      ...problems.map((p) => h("div", { class: "errors" }, "• " + p)),
      h("div", { class: "muted small", style: { marginTop: "6px" } }, `Total mark: ${gaps.reduce((s, g) => s + g.weight, 0)} (sum of the gap weights)`));
  };
  let timer;
  text.onChange(() => { clearTimeout(timer); timer = setTimeout(refresh, 250); });
  setTimeout(refresh);
  const el = h("fieldset", {}, h("legend", {}, "Gaps"),
    h("p", { class: "hint" }, "Write the gaps directly into the question text: {weight:TYPE:=correct~%50%partly correct~wrong#feedback}. "
      + "= marks the correct answer, %n% gives partial credit, # starts feedback, * is a wildcard in short answers, and numerical answers take value:tolerance. "
      + "Escape } ~ # inside answers with a backslash."),
    h("div", { class: "row", style: { marginBottom: "10px" } }, h("span", { class: "muted small" }, "Insert at cursor:"),
      CLOZE_TEMPLATES.map(([label, code]) => h("button", { type: "button", onmousedown: (e) => e.preventDefault(), onclick: () => text.insertText(code) }, label))),
    table);
  return { el, collect() { /* the gaps are part of the question text */ } };
}

const RESPONSE_FORMATS = { editor: "HTML editor", editorfilepicker: "HTML editor with file picker", plain: "Plain text", monospaced: "Plain text, monospaced font", noinline: "No online text" };

function essaySection(q, files) {
  const sel = (opts, value) => h("select", {}, Object.entries(opts).map(([v, l]) => h("option", { value: v, selected: String(value) === String(v) }, l)));
  const format = sel(RESPONSE_FORMATS, q.responseformat ?? "editor");
  const required = sel({ 1: "Require the student to enter text", 0: "Text input is optional" }, q.responserequired ?? 1);
  const lines = sel(Object.fromEntries([5, 10, 15, 20, 25, 30, 35, 40].map((n) => [n, `${n} lines`])), q.responsefieldlines ?? 10);
  const minw = h("input", { type: "number", min: 0, value: q.minwordlimit || "", placeholder: "none" });
  const maxw = h("input", { type: "number", min: 0, value: q.maxwordlimit || "", placeholder: "none" });
  const attach = sel({ 0: "No", 1: "1", 2: "2", 3: "3", "-1": "Unlimited" }, q.attachments ?? 0);
  const attachReq = sel({ 0: "Attachments are optional", 1: "1", 2: "2", 3: "3" }, q.attachmentsrequired ?? 0);
  const types = h("input", { type: "text", value: q.filetypeslist || "", placeholder: "e.g. .pdf, .png (empty = any)" });
  const template = richEditor(q.responsetemplate, files, { small: true });
  const grader = richEditor(q.graderinfo, files, { small: true });
  const el = h("div", {},
    h("fieldset", {}, h("legend", {}, "Response options"),
      h("div", { class: "grid-4" }, field("Response format", format), field("Require text", required), field("Input box size", lines), field("Minimum word limit", minw), field("Maximum word limit", maxw)),
      h("div", { class: "grid-4" }, field("Allow attachments", attach), field("Required attachments", attachReq), field("Accepted file types", types))),
    h("fieldset", {}, h("legend", {}, "Response template"), h("p", { class: "muted small" }, "Pre-filled into the answer box."), template.el),
    h("fieldset", {}, h("legend", {}, "Information for graders"), h("p", { class: "muted small" }, "Model answer or grading notes (shown in the answer key and the solution view)."), grader.el));
  return {
    el,
    collect(o) {
      Object.assign(o, {
        responseformat: format.value, responserequired: Number(required.value), responsefieldlines: Number(lines.value),
        minwordlimit: Number(minw.value) || 0, maxwordlimit: Number(maxw.value) || 0,
        attachments: Number(attach.value), attachmentsrequired: Number(attachReq.value), filetypeslist: types.value.trim(),
        responsetemplate: template.getHtml(), graderinfo: grader.getHtml(),
      });
      o.maxbytes ??= 0;
    },
  };
}

const SECTIONS = {
  truefalse: trueFalseSection,
  multichoice: multiChoiceSection,
  multichoiceset: multiChoiceSection,
  shortanswer: shortAnswerSection,
  matching: matchingSection,
  ddimageortext: ddSection,
  gapselect: gapSelectSection,
  cloze: clozeSection,
  essay: essaySection,
};

// --------------------------------------------------------------------------- validation

function validate(q) {
  const errors = [], warnings = [];
  if (!stripHtml(q.questiontext) && !/<img/i.test(q.questiontext)) errors.push("The question text is empty.");
  if (!(Number(q.defaultgrade) >= 0)) errors.push("Default mark must be a non-negative number.");
  switch (q.type) {
    case "multichoice":
    case "multichoiceset": {
      if (q.answers.length < 2) errors.push("Provide at least two choices.");
      const correct = q.answers.filter((a) => Number(a.fraction) > 0);
      if (!correct.length) errors.push("At least one choice must be correct.");
      if (q.type === "multichoice" && q.single !== false && !q.answers.some((a) => near(a.fraction, 100))) errors.push("One choice must have a grade of 100%.");
      if (q.type === "multichoice" && q.single === false && Math.abs(correct.reduce((s, a) => s + Number(a.fraction), 0) - 100) > 0.1)
        warnings.push("The positive grades of a multiple-answer question should add up to 100%.");
      break;
    }
    case "shortanswer":
      if (!q.answers.length) errors.push("Provide at least one answer.");
      else if (!q.answers.some((a) => near(a.fraction, 100))) errors.push("One answer must have a grade of 100%.");
      break;
    case "matching": {
      const questions = q.subquestions.filter((s) => stripHtml(s.text) || /<img/i.test(s.text));
      if (questions.length < 2) errors.push("Provide at least two questions.");
      if (questions.some((s) => !s.answer.trim())) errors.push("Every question needs an answer.");
      if (new Set(q.subquestions.map((s) => s.answer.trim()).filter(Boolean)).size < 3) warnings.push("Moodle requires at least 3 different answers for matching questions.");
      break;
    }
    case "gapselect": {
      const refs = [...(q.questiontext || "").matchAll(/\[\[(\d+)\]\]/g)].map((m) => Number(m[1]));
      if (!refs.length) errors.push("The question text contains no gaps. Insert [[1]], [[2]], … where the drop-downs should appear.");
      if (refs.some((n) => n < 1 || n > q.options.length)) errors.push(`A gap refers to an option that does not exist (there are ${q.options.length} options).`);
      if (q.options.some((o) => !o.text.trim())) errors.push("Every option needs a text.");
      break;
    }
    case "cloze":
      errors.push(...clozeProblems(q.questiontext || ""));
      break;
    case "ddimageortext":
      if (!q.background?.data) errors.push("Upload a background image.");
      if (!q.drags.length) errors.push("Add at least one drag item.");
      if (q.drags.some((d) => !d.text.trim() && !d.image)) errors.push("Every drag item needs a text (or image).");
      if (!q.drops.length) errors.push("Add at least one drop zone.");
      if (q.drops.some((d) => !q.drags.some((g) => g.no === d.choice))) errors.push("Every drop zone needs a correct drag item.");
      break;
  }
  return { errors, warnings };
}

function pruneFiles(q) {
  const { files, ...rest } = q;
  const haystack = decodeURIComponent(JSON.stringify(rest).replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
  q.files = Object.fromEntries(Object.entries(files || {}).filter(([name]) => haystack.includes(`@@PLUGINFILE@@/${name}`)));
  return q;
}

// --------------------------------------------------------------------------- dialog

function categoryPicker(selectedId) {
  const sel = h("select", { style: { flex: "1", minWidth: "0" } });
  const fill = (value) => {
    sel.replaceChildren(h("option", { value: "" }, "— choose a category —"),
      ...store.options().map((o) => h("option", { value: o.id, selected: o.id === value }, o.label)));
  };
  fill(selectedId);
  const add = h("button", { type: "button", title: "Create a new category (below the selected one)", onclick: async () => {
    const name = prompt(sel.value ? `New subcategory of "${store.pathString(+sel.value)}":` : "New top-level category:");
    if (!name?.trim()) return;
    const { id } = await api("POST", "/api/categories", { name: name.trim(), parent_id: sel.value ? +sel.value : null });
    await store.load();
    fill(id);
  } }, "+ New…");
  return { el: h("div", { class: "row", style: { flexWrap: "nowrap" } }, sel, add), get: () => (sel.value ? +sel.value : null) };
}

/**
 * Open the editor. `question` is either an existing catalog question (with id) or a new template.
 * Options: quizId (add a new question to this quiz), afterPosition or beforeItemId (where in the quiz),
 * categoryId (default category).
 * Resolves with the saved question, or null when cancelled.
 */
export function openEditor(question, { quizId = null, afterPosition = null, beforeItemId = null, categoryId = null } = {}) {
  return new Promise((resolve) => {
    const q = clone(question);
    const files = (q.files = q.files || {});
    const isNew = !q.id;
    const category = categoryPicker(q.category_id ?? categoryId ?? lastCategory());
    const otherQuizzes = (q.quizzes || []).filter((z) => z.id !== quizId);

    const name = h("input", { type: "text", value: q.name, placeholder: "Defaults to the beginning of the question text" });
    const text = richEditor(q.questiontext, files, { placeholder: "Question text" });
    const grade = h("input", { type: "number", value: q.defaultgrade ?? 1, min: 0, step: "any",
      disabled: q.type === "cloze", title: q.type === "cloze" ? "For Cloze questions the mark is the sum of the gap weights" : null });
    const penaltyList = PENALTIES.some((p) => near(p, q.penalty)) ? PENALTIES : [...PENALTIES, q.penalty];
    const penalty = h("select", {}, penaltyList.map((p) => h("option", { value: p, selected: near(p, q.penalty) }, `${(p * 100).toFixed(p === 0.3333333 ? 5 : 0)}%`)));
    const idnumber = h("input", { type: "text", value: q.idnumber || "" });
    const tags = h("input", { type: "text", value: (q.tags || []).join(", "), placeholder: "comma separated" });
    const hidden = checkbox("Hidden", q.hidden);
    const general = richEditor(q.generalfeedback, files, { small: true });

    const typeSection = SECTIONS[q.type](q, files, { text });

    const fbEditors = {};
    const fbFields = [["correctfeedback", "For any correct response"], ["partiallycorrectfeedback", "For any partially correct response"], ["incorrectfeedback", "For any incorrect response"]].filter(([k]) => k in q);
    for (const [k] of fbFields) fbEditors[k] = richEditor(q[k], files, { small: true });
    const shownum = "shownumcorrect" in q && q.type !== "multichoiceset" ? checkbox("Show the number of correct responses once the question has finished", q.shownumcorrect) : null;

    const form = h("div", {},
      !isNew && otherQuizzes.length
        ? h("p", { class: "hint" }, `This catalog question is also used in: ${otherQuizzes.map((z) => z.name).join(", ")}. Changes apply everywhere.`)
        : null,
      h("div", { class: "grid-4" }, field("Catalog category", category.el), field("Question name", name), field("Tags", tags)),
      field("Question text", text.el),
      h("div", { class: "grid-4" }, field("Default mark", grade), field("Penalty for each incorrect try", penalty), field("ID number", idnumber), h("div", { class: "field" }, h("label", {}, "Status"), hidden.el)),
      typeSection.el,
      h("details", { class: "section", open: !!q.generalfeedback }, h("summary", {}, "General feedback"),
        h("p", { class: "muted small" }, "Shown to the student after they have answered, regardless of their answer."), general.el),
      fbFields.length || shownum
        ? h("details", { class: "section" }, h("summary", {}, "Combined feedback"),
          fbFields.map(([k, label]) => field(label, fbEditors[k].el)), shownum?.el)
        : null,
    );

    function collect() {
      const o = clone(q);
      delete o.quizzes;
      o.category_id = category.get();
      o.files = files;
      o.questiontext = text.getHtml();
      o.name = name.value.trim() || stripHtml(o.questiontext).slice(0, 60) || TYPE_LABELS[q.type];
      o.defaultgrade = Number(grade.value);
      o.penalty = Number(penalty.value);
      o.idnumber = idnumber.value.trim();
      o.tags = tags.value.split(",").map((t) => t.trim()).filter(Boolean);
      o.hidden = hidden.get();
      o.generalfeedback = general.getHtml();
      for (const [k] of fbFields) o[k] = fbEditors[k].getHtml();
      if (shownum) o.shownumcorrect = shownum.get();
      typeSection.collect(o);
      if (q.type === "cloze") o.defaultgrade = totalWeight(o.questiontext);
      return o;
    }

    // Preview tab
    const preview = h("div", { class: "hidden" });
    const showPreview = () => {
      const o = collect();
      preview.innerHTML = "";
      const view = renderQuestion(o, { mode: "practice" });
      preview.append(
        h("div", { class: "card" }, h("h3", {}, o.name), view.el,
          h("div", { class: "row", style: { marginTop: "12px" } },
            h("button", { type: "button", class: "primary", onclick: () => view.check() }, "Check"),
            h("button", { type: "button", onclick: showPreview }, "Start again"),
            h("button", { type: "button", onclick: () => { view.solve(); view.check(); } }, "Fill in correct answers"))));
    };
    const tabEdit = h("button", { type: "button", class: "active", onclick: () => switchTab(false) }, "Edit");
    const tabPrev = h("button", { type: "button", onclick: () => switchTab(true) }, "Preview");
    function switchTab(toPreview) {
      tabEdit.classList.toggle("active", !toPreview);
      tabPrev.classList.toggle("active", toPreview);
      form.classList.toggle("hidden", toPreview);
      preview.classList.toggle("hidden", !toPreview);
      if (toPreview) showPreview();
    }

    const errorsEl = h("div", { class: "errors" });
    const initial = JSON.stringify(pruneFiles(collect()));
    let saved = null;

    async function save() {
      const o = pruneFiles(collect());
      const { errors, warnings } = validate(o);
      if (!o.category_id) errors.unshift("Choose a catalog category.");
      errorsEl.innerHTML = "";
      if (errors.length) {
        errorsEl.append(...errors.map((e) => h("div", {}, "• " + e)));
        switchTab(false);
        return;
      }
      try {
        saved = isNew
          ? await api("POST", "/api/questions", { ...o, quiz_id: quizId, after_position: afterPosition, before_item_id: beforeItemId })
          : await api("PUT", `/api/questions/${q.id}`, o);
        rememberCategory(o.category_id);
        for (const w of warnings) toast(w);
        toast("Question saved");
        m.close();
      } catch (e) {
        toast(e.message, "error");
      }
    }

    const m = modal({
      title: `${isNew ? "New" : "Edit"} question · ${TYPE_LABELS[q.type]}`,
      body: h("div", {}, form, preview),
      footer: [errorsEl, h("span", { class: "spacer" }),
        h("button", { type: "button", onclick: () => m.dlg.dispatchEvent(new Event("cancel", { cancelable: true })) }, "Cancel"),
        h("button", { type: "button", class: "primary", onclick: save }, "Save")],
      onClose: () => {
        if (JSON.stringify(pruneFiles(collect())) === initial) return true;
        confirmDialog("Discard unsaved changes?", "Discard").then((ok) => ok && m.close());
        return false;
      },
    });
    m.head.querySelector("h2").after(h("div", { class: "tabs" }, tabEdit, tabPrev));
    m.dlg.addEventListener("close", () => resolve(saved));
    setTimeout(() => (isNew ? text.el.querySelector(".rte-content").focus() : null), 50);
  });
}
