// Client-side cache of the catalog: category tree + question summaries.
import { api } from "./util.js";

export const store = {
  categories: [],
  questions: [],
  byId: new Map(),
  children: new Map(),
  counts: new Map(),

  async load() {
    const [categories, questions] = await Promise.all([api("GET", "/api/categories"), api("GET", "/api/questions")]);
    this.categories = categories;
    this.questions = questions;
    this.byId = new Map(categories.map((c) => [c.id, c]));
    this.children = new Map();
    for (const c of categories) {
      const key = c.parent_id ?? 0;
      if (!this.children.has(key)) this.children.set(key, []);
      this.children.get(key).push(c);
    }
    for (const list of this.children.values()) list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, undefined, { numeric: true }));
    this.counts = new Map();
    for (const q of questions) this.counts.set(q.category_id, (this.counts.get(q.category_id) || 0) + 1);
    return this;
  },

  kids(id) { return this.children.get(id ?? 0) || []; },

  path(id) {
    const names = [];
    for (let c = this.byId.get(id); c; c = this.byId.get(c.parent_id)) names.unshift(c.name);
    return names;
  },

  pathString(id) { return this.path(id).join(" / "); },

  descendants(id) {
    const out = [id];
    for (const c of this.kids(id)) out.push(...this.descendants(c.id));
    return out;
  },

  total(id) {
    return this.descendants(id).reduce((s, cid) => s + (this.counts.get(cid) || 0), 0);
  },

  /** Depth-first list of categories for <select>s: [{id, label, depth}] */
  options(parent = 0, depth = 0, out = []) {
    for (const c of this.kids(parent || 0)) {
      out.push({ id: c.id, label: " ".repeat(depth) + c.name, depth });
      this.options(c.id, depth + 1, out);
    }
    return out;
  },
};

export function lastCategory() {
  try { const v = Number(localStorage.getItem("qm.lastCategory")); return store.byId.has(v) ? v : null; } catch { return null; }
}

export function rememberCategory(id) {
  try { localStorage.setItem("qm.lastCategory", String(id)); } catch { /* ignore */ }
}
