// Parser for Moodle's Cloze ("embedded answers") syntax; mirrors quizmaster/cloze.py.

export const GAP_RE = /\{(\d*):([A-Za-z_]+):((?:\\.|[^\\}])*)\}/gs;

const TYPES = {};
for (const [names, kind, cs, sh] of [
  [["SHORTANSWER", "SA", "MW"], "shortanswer", false, false],
  [["SHORTANSWER_C", "SAC", "MWC"], "shortanswer", true, false],
  [["NUMERICAL", "NM"], "numerical", false, false],
  [["MULTICHOICE", "MC"], "select", false, false],
  [["MULTICHOICE_S", "MCS"], "select", false, true],
  [["MULTICHOICE_V", "MCV"], "radio_v", false, false],
  [["MULTICHOICE_VS", "MCVS"], "radio_v", false, true],
  [["MULTICHOICE_H", "MCH"], "radio_h", false, false],
  [["MULTICHOICE_HS", "MCHS"], "radio_h", false, true],
  [["MULTIRESPONSE", "MR"], "checkbox_v", false, false],
  [["MULTIRESPONSE_S", "MRS"], "checkbox_v", false, true],
  [["MULTIRESPONSE_H", "MRH"], "checkbox_h", false, false],
  [["MULTIRESPONSE_HS", "MRHS"], "checkbox_h", false, true],
]) for (const n of names) TYPES[n] = { kind, caseSensitive: cs, shuffle: sh };

export const KIND_LABELS = {
  shortanswer: "Short answer", numerical: "Numerical", select: "Drop-down", radio_v: "Radio buttons (vertical)",
  radio_h: "Radio buttons (horizontal)", checkbox_v: "Multiple response (vertical)", checkbox_h: "Multiple response (horizontal)",
};

function split(s, sep) {
  const parts = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
    if (s[i] === sep) { parts.push(cur); cur = ""; } else cur += s[i];
  }
  parts.push(cur);
  return parts;
}

const decoder = document.createElement("textarea");
function unescape(s) {
  decoder.innerHTML = s.replace(/\\(.)/gs, "$1");
  return decoder.value.trim();
}

export function parseGap(weight, type, body) {
  const t = TYPES[type.toUpperCase()] || { kind: "unknown", caseSensitive: false, shuffle: false };
  const answers = [];
  for (const raw of split(body, "~")) {
    if (!raw.trim()) continue;
    const m = raw.match(/^\s*(=|%(-?[\d.]+)%)?([\s\S]*)$/);
    const fraction = m[1] === "=" ? 100 : m[2] ? Number(m[2]) : 0;
    const [text, ...fb] = split(m[3], "#");
    const a = { text: unescape(text), fraction, feedback: fb.length ? unescape(fb[0]) : "" };
    if (t.kind === "numerical") {
      const [value, tol] = a.text.split(":");
      a.value = Number(value);
      a.tolerance = Number(tol || 0);
    }
    answers.push(a);
  }
  return { weight: weight ? Number(weight) : 1, type: type.toUpperCase(), ...t, answers };
}

export function parseGaps(text) {
  return [...(text || "").matchAll(GAP_RE)].map((m) => parseGap(m[1], m[2], m[3]));
}

export function totalWeight(text) {
  return parseGaps(text).reduce((s, g) => s + g.weight, 0) || 1;
}

export function bestAnswer(gap) {
  return [...gap.answers].sort((a, b) => b.fraction - a.fraction)[0];
}

/** Problems with the gaps in a Cloze text (for the editor). */
export function clozeProblems(text) {
  const problems = [];
  const gaps = parseGaps(text);
  if (!gaps.length) problems.push("The text contains no gaps. Use e.g. {1:SHORTANSWER:=answer}.");
  gaps.forEach((g, i) => {
    if (g.kind === "unknown") problems.push(`Gap ${i + 1}: unknown type "${g.type}".`);
    else if (!g.answers.length) problems.push(`Gap ${i + 1}: no answers.`);
    else if (!g.answers.some((a) => a.fraction >= 100) && !g.kind.startsWith("checkbox")) problems.push(`Gap ${i + 1}: no answer with 100% (mark it with =).`);
    if (g.kind === "numerical" && g.answers.some((a) => Number.isNaN(a.value))) problems.push(`Gap ${i + 1}: numerical answers must be numbers.`);
  });
  const opened = (text.match(/\{\d*:[A-Za-z_]+:/g) || []).length;
  if (opened > gaps.length) problems.push("A gap is not closed with }. Escape a literal } inside an answer as \\}.");
  return problems;
}
