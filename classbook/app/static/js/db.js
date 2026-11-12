// The device's own copy of everything, and the sync that keeps it level with the computer running Classbook.
//
// All screens read from memory (`mem`), which mirrors IndexedDB. A write goes
// to memory, to IndexedDB and to the outbox in one step, so it survives the app
// being closed with no network. `sync()` sends the outbox and pulls whatever
// changed on the server; when two devices changed the same record the later
// (updated_at, device) wins — the same rule the server applies, so both ends agree.

export const TABLES = [
  'classes', 'students', 'courses', 'entries', 'absences',
  'years', 'holidays', 'cancellations', 'extras', 'topics', 'files',   // planning
  'settings',   // shared by all devices, e.g. the symbols for the marks
  'categories', 'submissions', 'scores',   // grading
];

const mem = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
const listeners = new Set();
let idb;
let device;
let running = null;   // the sync in progress, if any (a promise)
let again = false;    // something asked for a sync while one was running

export const status = {
  state: 'idle',        // idle | syncing | ok | offline | unpaired | error
  message: '',
  lastSync: null,
  pending: 0,
};

// --- IndexedDB plumbing ------------------------------------------------------

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (t) => new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });

export async function open() {
  idb = await new Promise((res, rej) => {
    const r = indexedDB.open('classbook', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('records', { keyPath: ['tbl', 'id'] });
      d.createObjectStore('outbox', { keyPath: ['tbl', 'id'] });
      d.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const t = idb.transaction(['records', 'outbox'], 'readonly');
  const [records, outbox] = await Promise.all([
    req(t.objectStore('records').getAll()),
    req(t.objectStore('outbox').count()),
  ]);
  for (const r of records) if (mem[r.tbl]) mem[r.tbl].set(r.id, r);
  status.pending = outbox;
  device = await getMeta('device');
  if (!device) {
    device = crypto.randomUUID();
    await setMeta('device', device);
  }
  status.lastSync = await getMeta('lastSync');
  // An update that brings new kinds of record: an older version of the app
  // skipped them while its sync position moved on, so ask for everything once.
  const known = (await getMeta('tables')) || [];
  if (TABLES.some((t) => !known.includes(t))) {
    if ((await getMeta('since')) > 0) await setMeta('since', 0);   // only if it has synced before
    await setMeta('tables', TABLES);
  }
}

export async function getMeta(key) {
  return req(idb.transaction('meta').objectStore('meta').get(key));
}

export async function setMeta(key, value) {
  const t = idb.transaction('meta', 'readwrite');
  t.objectStore('meta').put(value, key);
  await done(t);
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { for (const fn of listeners) fn(what); }

// --- reading -----------------------------------------------------------------

const view = (r) => ({ id: r.id, ...r.data });

export function get(tbl, id) {
  const r = mem[tbl].get(id);
  return r && !r.deleted ? view(r) : null;
}

export function all(tbl, pred) {
  const out = [];
  for (const r of mem[tbl].values()) {
    if (r.deleted) continue;
    const v = view(r);
    if (!pred || pred(v)) out.push(v);
  }
  return out;
}

// --- writing -----------------------------------------------------------------

// ops: [{tbl, id?, data} | {tbl, id, delete: true}]. Returns the ids written.
export async function write(ops) {
  const now = Date.now();
  const t = idb.transaction(['records', 'outbox'], 'readwrite');
  const ids = [];
  for (const op of ops) {
    const id = op.id || crypto.randomUUID();
    const prev = mem[op.tbl].get(id);
    const rec = {
      tbl: op.tbl,
      id,
      data: op.delete ? {} : op.data,
      // Strictly later than what is there, even if this clock is behind.
      updated_at: Math.max(now, (prev?.updated_at ?? 0) + 1),
      device,
      deleted: !!op.delete,
    };
    mem[op.tbl].set(id, rec);
    t.objectStore('records').put(rec);
    t.objectStore('outbox').put({ tbl: op.tbl, id });
    ids.push(id);
  }
  await done(t);
  status.pending = await req(idb.transaction('outbox').objectStore('outbox').count());
  emit('local');
  scheduleSync(800);
  return ids;
}

export const put = (tbl, data, id) => write([{ tbl, id, data }]).then((ids) => ids[0]);
export const remove = (tbl, id) => write([{ tbl, id, delete: true }]);

// Update some fields of an existing record.
export function patch(tbl, id, fields) {
  const cur = get(tbl, id);
  if (!cur) return Promise.resolve();
  const { id: _, ...data } = cur;
  return put(tbl, { ...data, ...fields }, id);
}

// --- sync --------------------------------------------------------------------

let timer = null;
export function scheduleSync(ms = 0) {
  clearTimeout(timer);
  timer = setTimeout(() => sync(), ms);
}

const newer = (a, b) => a.updated_at > b.updated_at || (a.updated_at === b.updated_at && a.device > b.device);

async function post(path, body, code) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${code}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const err = new Error((await r.json().catch(() => ({}))).detail || r.statusText);
      err.status = r.status;
      throw err;
    }
    return await r.json();   // the timeout covers reading the body too
  } finally {
    clearTimeout(t);
  }
}

export async function checkCode(code) {
  return post('/api/check', {}, code);
}

// Put every record this device holds back into the outbox (after the server was reset).
async function requeueAll() {
  const t = idb.transaction('outbox', 'readwrite');
  for (const tbl of TABLES) for (const id of mem[tbl].keys()) t.objectStore('outbox').put({ tbl, id });
  await done(t);
}

// One sync at a time. Asked while one runs, it runs once more afterwards, and
// the promise returned settles only when all of that is done — so
// `await sync()` really means "the server has everything now" (file uploads
// rely on it).
export function sync() {
  if (!idb) return Promise.resolve();
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do { again = false; await syncOnce(); } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncOnce() {
  const code = await getMeta('code');
  if (!code) { status.state = 'unpaired'; emit('status'); return; }
  status.state = 'syncing';
  emit('status');
  let applied = 0;
  const rejected = [];
  try {
    for (let round = 0; round < 2; round++) {
      const keys = await req(idb.transaction('outbox').objectStore('outbox').getAll());
      const outgoing = keys.map((k) => mem[k.tbl]?.get(k.id)).filter(Boolean);
      let since = (await getMeta('since')) || 0;
      const knownStore = await getMeta('storeId');
      const chunks = [];
      for (let i = 0; i < outgoing.length; i += 100) chunks.push(outgoing.slice(i, i + 100));
      let more = true;
      let reset = false;
      while (chunks.length || more) {
        const batch = chunks.shift() || [];
        const res = await post('/api/sync', { since, changes: batch.map(({ tbl, id, data, updated_at, device, deleted }) => ({ tbl, id, data, updated_at, device, deleted })) }, code);
        // A different database, or one that went back in time: start over from 0
        // and send everything, so nothing this device knows is lost.
        if ((knownStore && res.store_id !== knownStore) || res.rev < since) {
          await setMeta('storeId', res.store_id);
          await setMeta('since', 0);
          await requeueAll();
          reset = true;
          break;
        }
        applied += await apply(res.changes);
        rejected.push(...(res.rejected || []));
        since = res.rev;
        more = res.more;
        await setMeta('since', since);
        if (!knownStore) await setMeta('storeId', res.store_id);
        await clearSent(batch);
      }
      if (!reset) break;
    }
    // Records the server turned away (too large, say) stay on this device; it
    // is said once, and they are not sent again and again.
    status.state = rejected.length ? 'error' : 'ok';
    status.message = rejected.length
      ? `${rejected.length} ${rejected.length === 1 ? 'change' : 'changes'} could not be saved on your computer: ${rejected[0].reason}`
      : '';
    status.lastSync = Date.now();
    await setMeta('lastSync', status.lastSync);
  } catch (e) {
    status.state = e.status === 401 ? 'unpaired' : e.status ? 'error' : 'offline';
    status.message = e.status ? e.message : 'Your computer is not reachable — changes are kept on this device.';
  } finally {
    status.pending = await req(idb.transaction('outbox').objectStore('outbox').count());
    emit(applied ? 'remote' : 'status');
  }
}

async function apply(changes) {
  if (!changes.length) return 0;
  const t = idb.transaction('records', 'readwrite');
  let n = 0;
  for (const c of changes) {
    if (!mem[c.tbl]) {
      // From a newer version of the app: kept, so that it is there once this
      // device is updated too.
      t.objectStore('records').put({ tbl: c.tbl, id: c.id, data: c.data, updated_at: c.updated_at, device: c.device, deleted: c.deleted });
      continue;
    }
    const cur = mem[c.tbl].get(c.id);
    if (cur && !newer(c, cur)) continue;
    const rec = { tbl: c.tbl, id: c.id, data: c.data, updated_at: c.updated_at, device: c.device, deleted: c.deleted };
    mem[c.tbl].set(c.id, rec);
    t.objectStore('records').put(rec);
    n++;
  }
  await done(t);
  return n;
}

// Drop outbox entries that went out — unless the record changed again meanwhile.
async function clearSent(batch) {
  if (!batch.length) return;
  const t = idb.transaction('outbox', 'readwrite');
  for (const sent of batch) {
    const now = mem[sent.tbl].get(sent.id);
    if (!now || !newer(now, sent)) t.objectStore('outbox').delete([sent.tbl, sent.id]);
  }
  await done(t);
}

// A record as this device knows it — including a deletion (a tombstone),
// which get() hides: {data, deleted} or undefined if never seen here.
export function peek(tbl, id) {
  const r = mem[tbl]?.get(id);
  return r ? { data: r.data, deleted: r.deleted } : undefined;
}

// Everything, for the JSON backup made on the device itself.
export function dump() {
  return Object.fromEntries(TABLES.map((t) => [t, all(t)]));
}

export async function wipe() {
  const t = idb.transaction(['records', 'outbox', 'meta'], 'readwrite');
  for (const s of ['records', 'outbox', 'meta']) t.objectStore(s).clear();
  await done(t);
  for (const t of TABLES) mem[t].clear();
}

// A request to the computer with the pairing code, for what only it can do
// (rendering notes, storing files). Throws with .status on an HTTP error.
export async function authFetch(path, opts = {}) {
  const code = await getMeta('code');
  const r = await fetch(path, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${code}` } });
  if (!r.ok) {
    const err = new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    err.status = r.status;
    throw err;
  }
  return r;
}
