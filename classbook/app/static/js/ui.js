// Small DOM helpers. Everything is built with h(), never innerHTML, so a name
// typed into the app can never turn into markup.

import * as db from './db.js';
import { initials } from './model.js';

export function h(tag, props, ...kids) {
  if (props == null || props instanceof Node || typeof props !== 'object' || Array.isArray(props)) {
    kids.unshift(props);
    props = {};
  }
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && !['list', 'form'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

// Per-device display settings. Storage can be unavailable (private mode); then
// the defaults simply apply.
const storage = (() => { try { return window.localStorage; } catch { return null; } })();
export const prefs = {
  get(key, fallback) {
    try {
      const v = storage?.getItem(`classbook.${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { storage?.setItem(`classbook.${key}`, JSON.stringify(value)); } catch { /* not kept */ }
  },
};

export const display = () => ({
  names: prefs.get('showNames', true),
  photos: prefs.get('showPhotos', true),
  // As seen from the teacher's desk: board at the bottom, the plan turned round.
  boardBottom: prefs.get('boardBottom', true),
});

// Photo and/or name, as the display settings say. With both switched off a
// student is still told apart by initials.
export function face(s, { names, photos }) {
  const avatar = photos || !names;
  return [
    avatar && h('div', { class: 'avatar', 'aria-hidden': 'true' },
      photos && s.photo ? h('img', { src: s.photo, alt: '', draggable: false }) : initials(s)),
    names && h('div', { class: 'name' },
      h('span', { class: 'first' }, s.firstName),
      h('span', { class: 'last' }, s.lastName)),
  ];
}

export function toggle(label, key, onChange) {
  return h('label', { class: 'switch' },
    h('input', {
      type: 'checkbox',
      checked: prefs.get(key, true),
      onchange: (e) => { prefs.set(key, e.target.checked); onChange?.(); },
    }),
    h('span', label));
}

let toastTimer;
export function toast(message, action) {
  const root = document.getElementById('toast');
  root.replaceChildren(h('div', { class: 'toast' },
    h('span', message),
    action && h('button', {
      class: 'link',
      onclick: () => { root.replaceChildren(); action.run(); },
    }, action.label)));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => root.replaceChildren(), action ? 5000 : 2500);
}

export function field(label, input) {
  return h('label', { class: 'field' }, h('span', label), input);
}

// --- navigation and the page frame -------------------------------------------

// app.js sets these, so screens in other modules can ask for a redraw.
export const hooks = { render: () => {} };

export const go = (hash) => { location.hash = hash; };
export const link = (hash, ...kids) => h('a', { href: `#${hash}` }, ...kids);

export function syncPill() {
  const s = db.status;
  const label = {
    idle: 'Not synced yet', syncing: 'Syncing…', ok: 'Synced', offline: 'Offline', unpaired: 'Not paired', error: 'Sync error',
  }[s.state];
  const pending = s.pending ? ` · ${s.pending} to send` : '';
  const when = s.state === 'ok' && s.lastSync ? ` ${new Date(s.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  return h('button', {
    class: `pill ${s.state}`,
    title: s.message || 'Sync now',
    onclick: () => (s.state === 'unpaired' ? go('/pair') : db.sync()),
  }, h('span', { class: 'dot' }), `${label}${when}${pending}`);
}

export function page(title, back, ...body) {
  return h('div', { class: 'page' },
    h('header', { class: 'top' },
      h('div', { class: 'crumb' }, back ? link(back.href, '‹ ', back.label) : h('span', { class: 'brand' }, 'Classbook')),
      h('div', { class: 'actions' }, syncPill(), h('a', { href: '#/settings', class: 'icon', title: 'Settings', 'aria-label': 'Settings' }, '⚙'))),
    title && h('h1', title),
    ...body);
}

// A document or PDF made by the server, in a new tab. Offline there is nothing
// to open, so say so instead of showing the browser's error page.
export function serverLink(href, label, props = {}) {
  return h('a', {
    class: 'button', href, target: '_blank', rel: 'noopener', ...props,
    onclick: (e) => {
      if (db.status.state === 'offline') {
        e.preventDefault();
        toast('This needs your computer — it is not reachable right now.');
      }
    },
  }, label);
}

// Ask for a .json file and parse it. Resolves to null if nothing was picked.
export function pickJson() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'application/json,.json', class: 'hidden' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      input.remove();
      if (!file) return resolve(null);
      try {
        resolve({ name: file.name, doc: JSON.parse(await file.text()) });
      } catch {
        toast('That file is not valid JSON.');
        resolve(null);
      }
    });
    document.body.append(input);
    input.click();
  });
}

// --- images from the clipboard -------------------------------------------------

// The image in a paste event (⌘V / long-press → Paste), or null when what is
// pasted is text — which then goes into the field as usual.
export function pastedImage(e) {
  const item = [...(e.clipboardData?.items || [])].find((i) => i.kind === 'file' && i.type.startsWith('image/'));
  return item ? item.getAsFile() : null;
}

// For a "Paste" button: read the clipboard directly. The browser may ask for
// permission first (Safari shows a small "Paste" bubble to tap).
export async function readClipboardImage() {
  if (!navigator.clipboard?.read) {
    toast('This browser cannot read images from the clipboard — press ⌘V instead.');
    return null;
  }
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return await item.getType(type);
    }
    toast('There is no image on the clipboard.');
  } catch {
    toast('The clipboard could not be read. Allow it when asked — or press ⌘V.');
  }
  return null;
}
