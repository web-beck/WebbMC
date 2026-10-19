'use strict';
/* WebbMC panel UI. Vanilla JS, hash-routed, talks to the JSON API in server.js. */

// ================================================================ helpers

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const enc = encodeURIComponent;
const joinPath = (a, b) => (a ? `${a}/${b}` : b);
const parentPath = (p) => p.split('/').slice(0, -1).join('/');

async function api(method, url, body, { raw = false } = {}) {
  const opts = { method, headers: { 'X-WebMC': '1' } };
  if (body !== undefined) {
    if (raw) opts.body = body;
    else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, opts);
  // Signed out (or the session ended elsewhere): reloading shows the sign-in page.
  if (res.status === 401) location.reload();
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new Error((isJson && data?.error) || data || res.statusText);
  return data;
}

const pref = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(`webmc:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`webmc:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};

function fmtBytes(b) {
  if (!b || b < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
}
const fmtMB = (mb) => (mb >= 1024 ? `${+(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
function fmtDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
function fmtAgo(t) {
  if (!t) return 'never';
  const diff = Date.now() - t;
  if (diff < 0) return `in ${fmtDuration(-diff)}`;
  if (diff < 45000) return 'just now';
  return `${fmtDuration(diff)} ago`;
}
const fmtDate = (t) => (t ? new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtTime = (t) => new Date(t).toLocaleTimeString(undefined, { hour12: false });
const pct = (v, max) => (max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0);

const ICONS = {
  play: 'M8 5v14l11-7z',
  stop: 'M6 6h12v12H6z',
  restart: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4z',
  bolt: 'M7 2v11h3v9l7-12h-4l4-8z',
  terminal:
    'M20 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 14H4V8h16zm-2-1h-6v-2h6zM7.5 17l-1.41-1.41L8.67 13l-2.59-2.59L7.5 9l4 4z',
  chart: 'M3 13h2v8H3zm4-5h2v13H7zm4-5h2v18h-2zm4 9h2v9h-2zm4-4h2v13h-2z',
  people:
    'M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-8 0a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5C15 14.17 10.33 13 8 13zm8 0c-.29 0-.62.02-.97.05A4.22 4.22 0 0 1 17 16.5V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
  folder: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm-1 7V3.5L18.5 9z',
  tune: 'M3 17v2h6v-2zM3 5v2h10V5zm10 16v-2h8v-2h-8v-2h-2v6zM7 9v2H3v2h4v2h2V9zm14 4v-2H11v2zm-6-4h2V7h4V5h-4V3h-2z',
  archive:
    'M20.54 5.23 19.15 3.55A1.45 1.45 0 0 0 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23A2 2 0 0 0 3 6.5V19a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5 6.5 12H10v-2h4v2h3.5zM5.12 5l.81-1h12l.94 1z',
  clock:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z',
  cog: 'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.4-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.6a7 7 0 0 0-1.7 1l-2.5-1-2 3.4L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.4 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.6a7 7 0 0 0 1.7-1l2.5 1 2-3.4zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z',
  copy: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z',
  trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6zM19 4h-3.5l-1-1h-5l-1 1H5v2h14z',
  download: 'M19 9h-4V3H9v6H5l7 7zM5 18v2h14v-2z',
  upload: 'M9 16h6v-6h4l-7-7-7 7h4zm-4 2h14v2H5z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75z',
  plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z',
  back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20z',
  arrow: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
  puzzle:
    'M20.5 11H19V7a2 2 0 0 0-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4a2 2 0 0 0-2 2v3.8h1.5a2.7 2.7 0 0 1 0 5.4H2V20a2 2 0 0 0 2 2h3.8v-1.5a2.7 2.7 0 0 1 5.4 0V22H17a2 2 0 0 0 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z',
  link: 'M3.9 12A3.1 3.1 0 0 1 7 8.9h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z',
  star: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
  starOutline:
    'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28z',
  search:
    'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  signal: 'M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8 3 3 3-3a4.24 4.24 0 0 0-6 0zm-4-4 2 2a7.07 7.07 0 0 1 10 0l2-2C15.14 9.14 8.87 9.14 5 13z',
  image: 'M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5z',
  external: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7h-2zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3z',
  key: 'M12.65 10A6 6 0 1 0 12.65 14H17v4h4v-4h2v-4zM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4z',
  info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16z',
  warn: 'M1 21h22L12 2zm12-3h-2v-2h2zm0-4h-2v-4h2z',
  save: 'M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10z',
  newFolder: 'M20 6h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3z',
  newFile: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zm2 14h-3v3h-2v-3H8v-2h3v-3h2v3h3zm-3-7V3.5L18.5 9z',
  restore:
    'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 7 7 6.97 6.97 0 0 1-4.94-2.06l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8z',
  server:
    'M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 12h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2zm3-9.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3zm0 12a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z',
  shield: 'M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5zm-2 16-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9z',
  ban: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM4 12a8 8 0 0 1 12.9-6.32L5.68 16.9A7.93 7.93 0 0 1 4 12zm8 8a7.93 7.93 0 0 1-4.9-1.68L18.32 7.1A8 8 0 0 1 12 20z',
  grip: 'M9 4.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2zM15 4.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2zM9 10.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2zM15 10.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2zM9 16.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2zM15 16.4a1.6 1.6 0 1 0 0 3.2a1.6 1.6 0 1 0 0-3.2z',
  logout: 'M10.09 15.59 11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67zM19 3H5a2 2 0 0 0-2 2v4h2V5h14v14H5v-4H3v4a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${ICONS[name]}"/></svg>`;

function toast(message, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'bad' ? 6500 : 3500);
}

function modal({ title, body = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false, wide = false, onOpen, onConfirm }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <form class="modal ${wide ? 'wide' : ''}" novalidate>
        <h2>${esc(title)}</h2>
        <div class="form">${body}</div>
        <div class="form-actions">
          ${cancelText ? `<button type="button" class="btn btn-ghost" data-cancel>${esc(cancelText)}</button>` : ''}
          <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-accent'}">${esc(confirmText)}</button>
        </div>
      </form>`;
    $('#modal-root').append(wrap);
    const form = $('form', wrap);
    const onKey = (e) => e.key === 'Escape' && close(null);
    const close = (value) => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      resolve(value);
    };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('mousedown', (e) => e.target === wrap && close(null));
    if (cancelText) $('[data-cancel]', wrap).onclick = () => close(null);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      try {
        const value = onConfirm ? await onConfirm(form) : true;
        close(value ?? true);
      } catch (err) {
        toast(err.message, 'bad');
        btn.disabled = false;
      }
    };
    onOpen?.(form);
    setTimeout(() => {
      const target = $('[autofocus]', form) || $('button[type=submit]', form);
      target.focus();
      if (target.select) target.select();
    }, 30);
  });
}

const confirmBox = (title, message, opts = {}) => modal({ title, body: `<p>${esc(message)}</p>`, ...opts }).then(Boolean);

const promptBox = (title, label, value = '', opts = {}) =>
  modal({
    title,
    confirmText: 'Save',
    ...opts,
    body: `<div class="field"><label>${esc(label)}</label><input class="input" name="v" value="${esc(value)}" autofocus autocomplete="off"></div>`,
    onConfirm: (f) => {
      const v = f.elements.v.value.trim();
      if (!v) throw new Error('Enter a value');
      return v;
    },
  });

// RAM inputs with an MB/GB switch. The form always submits megabytes (hidden input); the unit
// choice is remembered and shared by every RAM field.
const RAM_STEP = { MB: 256, GB: 0.5 };
const ramUnit = () => (pref.get('ramUnit', 'GB') === 'MB' ? 'MB' : 'GB');

function ramField(name, label, mb, hint = '') {
  return `
    <div class="field"><label>${label}</label>
      <div class="ram" data-ram>
        <input class="input" type="number" min="0" data-ram-shown aria-label="${esc(label)}">
        <div class="seg" role="group" aria-label="Unit"><button type="button" data-unit="MB">MB</button><button type="button" data-unit="GB">GB</button></div>
        <input type="hidden" name="${name}" value="${Number(mb) || 0}">
      </div>
      ${hint ? `<span class="hint">${hint}</span>` : ''}
    </div>`;
}

function showRam(box) {
  const unit = ramUnit();
  const mb = Number($('input[type=hidden]', box).value) || 0;
  const shown = $('[data-ram-shown]', box);
  shown.value = unit === 'GB' ? +(mb / 1024).toFixed(2) : mb;
  shown.step = RAM_STEP[unit];
  $$('[data-unit]', box).forEach((b) => {
    b.classList.toggle('active', b.dataset.unit === unit);
    b.setAttribute('aria-pressed', String(b.dataset.unit === unit));
  });
}

function wireRam(root) {
  $$('[data-ram]', root).forEach((box) => {
    showRam(box);
    $('[data-ram-shown]', box).addEventListener('input', (e) => {
      const v = Number(e.target.value) || 0;
      $('input[type=hidden]', box).value = Math.round(ramUnit() === 'GB' ? v * 1024 : v);
    });
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-unit]');
      if (!b) return;
      pref.set('ramUnit', b.dataset.unit);
      $$('[data-ram]').forEach(showRam);
    });
  });
}

function setRam(root, name, mb) {
  const hidden = $(`[data-ram] input[name="${name}"]`, root);
  if (!hidden) return;
  hidden.value = mb;
  showRam(hidden.closest('[data-ram]'));
}

const notice = (html, kind = '') => `<div class="notice ${kind}">${icon(kind === 'warn' ? 'warn' : 'info')}<div>${html}</div></div>`;
const switchHtml = (name, checked, label) =>
  `<label class="switch"><input type="checkbox" name="${name}" ${checked ? 'checked' : ''}><span class="track"></span><span>${label}</span></label>`;

// ================================================================ server helpers

const state = { overview: null, connected: true, updating: false };
const findServer = (id) => state.overview?.servers.find((s) => s.id === id);
/** The signed-in account. id is its username, or its Google email when it has no username. */
const me = () => state.overview?.me || { admin: false, id: null };
/** Servers that belong to you or were shared with you. Servers without an owner belong to the admins. */
const isMine = (s) => s.owner === me().id || (!s.owner && me().admin) || Boolean(me().id && s.shared?.includes(me().id));
/** Your servers, in the order you arranged them in the sidebar (servers you have not placed go at the end). */
const myServers = () => {
  const list = (state.overview?.servers || []).filter(isMine);
  // A move just made wins for a few seconds, so a refresh that was already on its way does not undo it.
  const order = state.serverOrder && Date.now() - state.serverOrder.at < 8000 ? state.serverOrder.ids : me().serverOrder || [];
  const at = new Map(order.map((id, i) => [id, i]));
  return list
    .map((s, i) => ({ s, k: at.has(s.id) ? at.get(s.id) : order.length + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.s);
};
/** Who a server belongs to: on servers shared with you, and for admins on servers that are not theirs. */
const ownerChip = (s) =>
  s.access === 'shared'
    ? `<span class="owner-chip" title="Shared with you">${icon('people')}Shared by ${esc(s.owner || 'the admins')}</span>`
    : me().admin && !isMine(s)
      ? `<span class="owner-chip" title="Owner">${icon('people')}${esc(s.owner || 'Admins')}</span>`
      : '';
const mePic = (u) =>
  u.picture
    ? `<img class="me-pic" src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="me-pic">${esc((u.name || u.id || '?')[0].toUpperCase())}</span>`;

/** Suggestions for "owner" fields: every account the admin knows about. */
async function fillUserList() {
  let list = $('#user-list');
  if (!list) {
    list = document.createElement('datalist');
    list.id = 'user-list';
    document.body.append(list);
  }
  try {
    const users = await api('GET', '/api/users');
    list.innerHTML = users.map((u) => `<option value="${esc(u.id)}">${esc(u.name && u.name !== u.id ? u.name : u.email || 'Username')}</option>`).join('');
  } catch {
    /* suggestions are optional */
  }
}

const TYPE_LABEL = { paper: 'Paper', purpur: 'Purpur', fabric: 'Fabric', vanilla: 'Vanilla', custom: 'Custom jar', import: 'Imported', velocity: 'Velocity', bungeecord: 'BungeeCord' };
const softwareLabel = (s) => `${TYPE_LABEL[s.type] || s.type}${s.version === 'latest' ? ' (latest build)' : s.version ? ` ${s.version}` : ''}`;
const serverAddress = (s) => s.publicAddress || `${location.hostname || 'localhost'}:${s.port}`;

function statusInfo(s) {
  if (s.busy) return { label: s.busy, cls: 'warn' };
  return (
    {
      running: { label: 'Online', cls: 'ok' },
      starting: { label: 'Starting', cls: 'warn' },
      stopping: { label: 'Stopping', cls: 'warn' },
      crashed: { label: 'Crashed', cls: 'bad' },
    }[s.status] || { label: 'Offline', cls: '' }
  );
}
const statusPill = (s) => {
  const i = statusInfo(s);
  return `<span class="pill ${i.cls}"><span class="dot ${i.cls}"></span>${esc(i.label)}</span>`;
};
/** The server's server-icon.png (the URL changes whenever the icon does), or a placeholder. */
const srvIcon = (s, cls = '') =>
  s.icon
    ? `<img class="srv-icon ${cls}" src="/api/servers/${s.id}/icon?v=${s.icon}" alt="" width="64" height="64">`
    : `<span class="srv-icon empty ${cls}" aria-hidden="true">${icon('server')}</span>`;

const addrChip = (s) => {
  const a = serverAddress(s);
  return `<span class="addr">${esc(a)}<button type="button" data-copy="${esc(a)}" title="Copy address">${icon('copy')}</button></span>`;
};

function powerButtons(s, size = '') {
  const running = Boolean(s.pid);
  const busy = Boolean(s.busy && s.busy !== 'Backing up');
  const stopping = s.status === 'stopping';
  return `
    <button class="btn btn-accent ${size}" data-power="start" ${running || s.busy ? 'disabled' : ''}>${icon('play')}Start</button>
    <button class="btn ${size}" data-power="restart" ${!running || busy || stopping ? 'disabled' : ''}>${icon('restart')}Restart</button>
    <button class="btn btn-danger ${size}" data-power="stop" ${!running || stopping ? 'disabled' : ''}>${icon('stop')}Stop</button>`;
}

const POWER_MSG = { start: 'Starting server', stop: 'Stopping server', restart: 'Restarting server', kill: 'Process killed' };

document.addEventListener('click', async (e) => {
  if (e.target.closest('[data-logout]')) {
    try {
      await api('POST', '/auth/logout');
    } finally {
      location.href = '/';
    }
    return;
  }
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      toast(`Copied ${copy.dataset.copy}`, 'ok');
    } catch {
      toast('Could not copy to the clipboard', 'bad');
    }
    return;
  }
  const btn = e.target.closest('[data-power]');
  if (!btn) return;
  const id = btn.closest('[data-server]')?.dataset.server;
  const action = btn.dataset.power;
  if (
    action === 'kill' &&
    !(await confirmBox('Kill this server?', 'This ends the Java process immediately without saving the world. Only use it if the server is frozen.', {
      danger: true,
      confirmText: 'Kill process',
    }))
  )
    return;
  btn.disabled = true;
  try {
    await api('POST', `/api/servers/${id}/power`, { action });
    toast(POWER_MSG[action], 'ok');
    poll();
  } catch (err) {
    toast(err.message, 'bad');
    btn.disabled = false;
  }
});

// ================================================================ chrome (sidebar)

function renderChrome() {
  const { host, panel } = state.overview;
  const servers = myServers();
  const nameHtml = panel.name === 'WebbMC' ? 'Webb<span class="text-gradient">MC</span>' : esc(panel.name);
  $$('.brand-name').forEach((el) => (el.innerHTML = nameHtml));
  document.title = `${panel.name} Server Panel`;

  const navHtml = servers.length
    ? servers
        .map(
          (s) => `
      <a href="#/server/${s.id}" data-sid="${s.id}" draggable="false">
        ${servers.length > 1 ? `<span class="grip" data-grip tabindex="0" role="button" title="Drag to move" aria-label="Move ${esc(s.name)}: drag, or press the up and down arrow keys">${icon('grip')}</span>` : ''}
        <span class="nm"><span class="dot ${statusInfo(s).cls}"></span><span>${esc(s.name)}</span></span>
        <span class="faint small">${s.pid ? `${s.playerCount}/${s.maxPlayers}` : ''}</span>
      </a>`,
        )
        .join('')
    : `<div class="empty">${me().admin && state.overview.servers.length ? 'None of your own. See All servers.' : 'No servers yet'}</div>`;
  // Rebuild only when something changed, and never in the middle of a drag; keep the keyboard focus where it was.
  if (!reorder.active && navHtml !== serverNavHtml) {
    const nav = $('#server-nav');
    const focusSid = document.activeElement?.closest?.('#server-nav [data-sid]')?.dataset.sid;
    const onGrip = Boolean(document.activeElement?.closest?.('#server-nav [data-grip]'));
    nav.innerHTML = navHtml;
    serverNavHtml = navHtml;
    if (focusSid) $(`#server-nav [data-sid="${focusSid}"]${onGrip ? ' [data-grip]' : ''}`)?.focus();
  }

  const u = me();
  $('[data-nav="settings"]').classList.toggle('hidden', !u.admin);
  $('[data-nav="all"]').classList.toggle('hidden', !u.admin);
  $('[data-nav="ports"]').classList.toggle('hidden', !u.admin);
  renderNotifCount();
  $('#pending-badge').textContent = u.pending || '';
  $('#pending-badge').classList.toggle('hidden', !u.pending);
  $('#nav-toggle').classList.toggle('pending', Boolean(u.pending)); // a dot on the folded menu
  $('#side-foot').innerHTML = `
    <div class="me-row">
      <a class="me-link" href="#/account" title="Your account">${mePic(u)}
        <span class="me-who"><strong>${esc(u.name || u.id)}</strong><span>${u.admin ? 'Admin' : esc(u.username || u.email || '')}</span></span></a>
      <button class="icon-btn" data-logout title="Sign out" aria-label="Sign out">${icon('logout')}</button>
    </div>
    <div class="row"><span>Host CPU</span><span class="mono">${host.cpu.toFixed(0)}%</span></div>
    <div class="bar"><i style="width:${host.cpu}%"></i></div>
    <div class="row"><span>Host RAM</span><span class="mono">${fmtBytes(host.memUsed)} / ${fmtBytes(host.memTotal)}</span></div>
    <div class="bar lime"><i style="width:${pct(host.memUsed, host.memTotal)}%"></i></div>
    <div class="faint">${esc(panel.name)} v${esc(panel.version)} · ${esc(host.hostname)}</div>`;
  highlightNav();
}

function highlightNav() {
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const top = parts[0] || 'dashboard';
  // Someone else's server (admins) lives under All servers.
  const other = top === 'server' && findServer(parts[1]) && !isMine(findServer(parts[1]));
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === (other ? 'all' : top)));
  $$('#server-nav a').forEach((a) => a.classList.toggle('active', top === 'server' && a.dataset.sid === parts[1]));
  // The folded menu says which page you are on.
  const active = $('.nav a.active');
  $('#nav-current').textContent = active ? [...active.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim() : '';
}

const sidebar = $('#sidebar');
const scrim = $('#scrim');
const closeMenu = () => {
  sidebar.classList.remove('open');
  scrim.classList.remove('open');
};
$('#menu-btn').onclick = () => {
  sidebar.classList.add('open');
  scrim.classList.add('open');
};
scrim.onclick = closeMenu;

// The menu (Dashboard to Panel settings) folds away under its label, remembered in this browser.
function setNavCollapsed(collapsed) {
  sidebar.classList.toggle('nav-collapsed', collapsed);
  $('#nav-toggle').setAttribute('aria-expanded', String(!collapsed));
  $('#main-nav').inert = collapsed; // folded links are out of the tab order too
  pref.set('navCollapsed', collapsed);
}
$('#nav-toggle').onclick = () => setNavCollapsed(!sidebar.classList.contains('nav-collapsed'));
setNavCollapsed(pref.get('navCollapsed', false));

// ---------------------------------------------------------------- arranging your servers in the sidebar
// Drag a server by its handle (mouse or touch), or focus the handle and press Up/Down. The order is saved on your
// account, so every device shows it, and the dashboard lists your servers in the same order.
let serverNavHtml = '';
const reorder = { active: false };
const navIds = () => $$('#server-nav [data-sid]').map((a) => a.dataset.sid);

function saveServerOrder(ids) {
  state.serverOrder = { ids, at: Date.now() };
  renderChrome();
  current?.update?.();
  api('PUT', '/api/account/server-order', { order: ids })
    .then((r) => {
      if (state.overview?.me) state.overview.me.serverOrder = r.serverOrder;
    })
    .catch((err) => toast(`Could not save the order: ${err.message}`, 'bad'));
}

const serverNav = $('#server-nav');
serverNav.addEventListener('click', (e) => {
  if (e.target.closest('[data-grip]')) e.preventDefault(); // the handle moves the server; it does not open it
});
serverNav.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('[data-grip]');
  if (!grip || e.button !== 0) return;
  e.preventDefault();
  const item = grip.closest('[data-sid]');
  const before = navIds().join();
  reorder.active = true;
  item.classList.add('dragging');
  serverNav.classList.add('reordering');
  document.body.classList.add('dragging-server');
  const mid = (el) => {
    const r = el.getBoundingClientRect();
    return r.top + r.height / 2;
  };
  // Move the neighbours rather than the dragged item, so the browser never loses track of the pointer.
  const move = (ev) => {
    const sb = sidebar.getBoundingClientRect();
    if (ev.clientY < sb.top + 40) sidebar.scrollTop -= 12;
    else if (ev.clientY > sb.bottom - 40) sidebar.scrollTop += 12;
    let sib;
    while ((sib = item.previousElementSibling) && ev.clientY < mid(sib)) serverNav.insertBefore(sib, item.nextElementSibling);
    while ((sib = item.nextElementSibling) && ev.clientY > mid(sib)) serverNav.insertBefore(sib, item);
  };
  const end = () => {
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
    document.removeEventListener('pointercancel', end);
    item.classList.remove('dragging');
    serverNav.classList.remove('reordering');
    document.body.classList.remove('dragging-server');
    reorder.active = false;
    if (navIds().join() !== before) saveServerOrder(navIds());
  };
  document.addEventListener('pointermove', move);
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
});
serverNav.addEventListener('keydown', (e) => {
  const grip = e.target.closest('[data-grip]');
  if (!grip || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const item = grip.closest('[data-sid]');
  const up = e.key === 'ArrowUp';
  const sib = up ? item.previousElementSibling : item.nextElementSibling;
  if (!sib) return;
  // Move the neighbour past it, so the handle keeps the keyboard focus.
  serverNav.insertBefore(sib, up ? item.nextElementSibling : item);
  saveServerOrder(navIds());
});

// ================================================================ notifications (the bell, top right)

const NOTIF_ICON = { update: 'download', error: 'warn', share: 'people', accounts: 'people' };
const notif = { open: false, data: null };

function renderNotifCount() {
  const n = me().notifications || 0;
  $('#notif-count').textContent = n > 9 ? '9+' : String(n);
  $('#notif-count').classList.toggle('hidden', !n);
  $('#notif-btn').setAttribute('aria-label', n ? `Notifications (${n} new)` : 'Notifications');
}

function notifItem(i) {
  const names = Object.fromEntries((state.overview?.servers || []).map((s) => [s.id, s.name]));
  const sub = [i.serverId && names[i.serverId], i.text, fmtAgo(i.t)].filter(Boolean).join(' · ');
  const body = `<span class="ic">${icon(NOTIF_ICON[i.kind] || 'info')}</span>
    <span><div class="t">${esc(i.title)}</div><div class="s">${esc(sub)}</div>${
      i.kind === 'update'
        ? `<div class="row"><a class="btn btn-sm" href="${i.href}">Details</a>${i.canApply ? `<button class="btn btn-sm btn-accent" data-update-now>${icon('download')}Update now</button>` : ''}</div>`
        : ''
    }</span>`;
  const cls = `notif-item ${i.kind} ${i.unread ? 'unread' : ''}`;
  // The update entry holds buttons, so it is not one big link.
  return i.kind === 'update' ? `<div class="${cls}">${body}</div>` : `<a class="${cls}" href="${esc(i.href)}">${body}</a>`;
}

function renderNotifPanel() {
  const d = notif.data;
  $('#notif-panel').innerHTML = `
    <div class="notif-head"><h3>Notifications</h3><span class="spacer"></span>${
      me().admin ? `<button class="btn btn-sm btn-ghost" data-notif-check>${icon('restart')}Check for updates</button>` : ''
    }</div>
    <div class="notif-list">${
      !d ? '<div class="notif-empty">Loading...</div>' : d.items.length ? d.items.map(notifItem).join('') : '<div class="notif-empty">You are all caught up.</div>'
    }</div>`;
}

async function loadNotif() {
  notif.data = await api('GET', '/api/notifications');
  if (notif.open) renderNotifPanel();
}

async function openNotif() {
  notif.open = true;
  $('#notif-panel').classList.remove('hidden');
  $('#notif-btn').setAttribute('aria-expanded', 'true');
  renderNotifPanel();
  try {
    await loadNotif();
    // Opening the panel marks everything read; the dots stay until it is closed, so you can see what was new.
    if (notif.data.unread) {
      await api('POST', '/api/notifications/seen');
      if (state.overview) state.overview.me.notifications = 0;
      renderNotifCount();
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function closeNotif() {
  notif.open = false;
  $('#notif-panel').classList.add('hidden');
  $('#notif-btn').setAttribute('aria-expanded', 'false');
}

$('#notif-btn').onclick = () => (notif.open ? closeNotif() : openNotif());
$('#notif-panel').addEventListener('click', async (e) => {
  if (e.target.closest('a')) return closeNotif();
  const check = e.target.closest('[data-notif-check]');
  if (!check) return;
  check.disabled = true;
  try {
    const u = await api('POST', '/api/update/check');
    if (u.error) toast(`Could not check for updates: ${u.error}`, 'bad');
    else if (!u.available) toast(u.mode === 'none' ? 'This copy cannot check for updates' : 'WebbMC is up to date', 'ok');
    await loadNotif();
  } catch (err) {
    toast(err.message, 'bad');
    check.disabled = false;
  }
});
document.addEventListener('click', (e) => {
  if (notif.open && !e.target.closest('#notif') && !e.target.closest('.modal-backdrop')) closeNotif();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && notif.open) {
    closeNotif();
    $('#notif-btn').focus();
  }
});

// ---------------------------------------------------------------- panel updates (bell and Panel settings)

/** Ask, pull the update, stop the servers, and reload this page once the restarted panel answers. */
async function updateNow() {
  let u;
  try {
    u = await api('GET', '/api/update');
  } catch (err) {
    return toast(err.message, 'bad');
  }
  if (!u.canApply) return toast(u.applyNote, 'bad');
  const running = (state.overview?.servers || []).filter((s) => s.pid).length;
  const ok = await confirmBox(
    'Stop the servers and update?',
    `WebbMC downloads the update, stops ${running ? `the ${running} running server${running === 1 ? '' : 's'} (players are disconnected)` : 'every server'} and ${
      u.restarts ? 'restarts. Servers that were running start again afterwards.' : 'stops. Start it again with "node server.js" to finish.'
    }`,
    { danger: true, confirmText: 'Stop servers and update' },
  );
  if (!ok) return;
  closeNotif();
  await restartPanel('Updating WebbMC', () => api('POST', '/api/update'), u.restarts, 'The update is installed');
}

/**
 * Run `request` (which makes the panel restart), then show a waiting box and reload once the new panel answers.
 * With `origin` (the panel moves to another port), it waits for that address and opens it.
 */
async function restartPanel(heading, request, restarts, doneText, origin = '') {
  let boot = null;
  try {
    boot = (await fetch('/api/health').then((r) => r.json())).boot;
    state.updating = true;
    await request();
  } catch (err) {
    state.updating = false;
    toast(err.message, 'bad');
    return false;
  }
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `<div class="modal" role="alertdialog" aria-live="polite"><h2>${esc(heading)}</h2><p id="upd-msg">Stopping the servers. This can take up to a minute.</p></div>`;
  document.body.append(wrap);
  if (!restarts) {
    $('#upd-msg').textContent = `${doneText} and the panel is stopping. Start it again with "node server.js"; this page reloads when it is back.`;
  }
  // A new boot id means the restarted panel is answering.
  const wait = async () => {
    if (origin) {
      // Another port is another origin, so only "does it answer" can be seen (no-cors), which is enough.
      try {
        await fetch(`${origin}/api/health`, { mode: 'no-cors', cache: 'no-store' });
        return location.assign(`${origin}/${location.hash}`);
      } catch {
        $('#upd-msg').textContent = `Restarting the panel on ${origin}...`;
      }
      return setTimeout(wait, 2000);
    }
    try {
      const h = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.json());
      if (h.boot && h.boot !== boot) return location.reload();
    } catch {
      $('#upd-msg').textContent = restarts ? 'Restarting the panel...' : $('#upd-msg').textContent;
    }
    setTimeout(wait, 2000);
  };
  setTimeout(wait, 2000);
  return true;
}

/** "stable" for the repository's default branch, "development" for dev, otherwise nothing. */
const branchKind = (name, u) => (name === u.defaultBranch ? 'stable' : /^(dev|develop|development)$/i.test(name) ? 'development' : '');

/** Warn, then switch the panel to another branch and restart it. */
async function switchBranch(name, u) {
  const kind = branchKind(name, u);
  const from = u.branch ? `<span class="mono">${esc(u.branch)}</span>` : 'the version that runs now';
  const running = (state.overview?.servers || []).filter((s) => s.pid).length;
  const risk =
    kind === 'stable'
      ? `<strong>${esc(name)} is the stable version, and it can be older than ${from}.</strong> Features that only exist on ${from} go away, and settings or server data saved by the newer code may not load correctly.`
      : `<strong>${esc(name)} is ${kind === 'development' ? 'the development branch' : 'not the stable branch'}.</strong> It gets changes before they are finished and tested, so parts of the panel can break, and in the worst case data can be lost.${
          u.defaultBranch ? ` You can switch back to <span class="mono">${esc(u.defaultBranch)}</span> here at any time.` : ''
        }`;
  const ok = await modal({
    title: `Switch WebbMC to ${name}?`,
    body: `${notice(risk, 'warn')}
      <p class="muted" style="margin:0">Back up important worlds first (each server's <strong>Backups</strong> tab). WebbMC then switches to <span class="mono">${esc(name)}</span>, stops ${
        running ? `the ${running} running server${running === 1 ? '' : 's'} (players are disconnected)` : 'every server'
      } and ${u.restarts ? 'restarts. Servers that were running start again afterwards.' : 'stops. Start it again with "node server.js" to finish.'}</p>
      <label class="check"><input type="checkbox" name="ack"> <span>I understand the risks of switching to ${esc(name)}</span></label>`,
    danger: true,
    confirmText: `Switch to ${name}`,
    onConfirm: (form) => {
      if (!form.elements.ack.checked) throw new Error('Tick the box to confirm first');
    },
  });
  if (!ok) return;
  await restartPanel(`Switching WebbMC to ${name}`, () => api('POST', '/api/update/branch', { branch: name }), u.restarts, `WebbMC switched to ${name}`);
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-update-now]')) updateNow();
});

// ================================================================ dashboard

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function hostTiles(host, servers) {
  const online = servers.filter((s) => s.pid).length;
  const players = servers.reduce((n, s) => n + s.playerCount, 0);
  const diskUsed = host.disk ? host.disk.total - host.disk.free : 0;
  return `
    <div class="card tile"><div class="label">Host CPU</div><div class="value">${host.cpu.toFixed(0)}<small>%</small></div>
      <div class="bar ${host.cpu > 85 ? 'hot' : ''}"><i style="width:${host.cpu}%"></i></div><div class="faint small">${host.cores} cores</div></div>
    <div class="card tile"><div class="label">Host memory</div><div class="value">${fmtBytes(host.memUsed)}<small>of ${fmtBytes(host.memTotal)}</small></div>
      <div class="bar lime"><i style="width:${pct(host.memUsed, host.memTotal)}%"></i></div><div class="faint small">${pct(host.memUsed, host.memTotal).toFixed(0)}% in use</div></div>
    <div class="card tile"><div class="label">Disk (data folder)</div><div class="value">${host.disk ? fmtBytes(host.disk.free) : '—'}<small>free</small></div>
      <div class="bar"><i style="width:${host.disk ? pct(diskUsed, host.disk.total) : 0}%"></i></div><div class="faint small">${host.disk ? `${fmtBytes(host.disk.total)} total` : 'unavailable'}</div></div>
    <div class="card tile"><div class="label">Servers online</div><div class="value">${online}<small>of ${servers.length}</small></div>
      <div class="bar lime"><i style="width:${pct(online, servers.length)}%"></i></div><div class="faint small">${players} player${players === 1 ? '' : 's'} connected</div></div>`;
}

function serverCard(s, { owner = true } = {}) {
  const maxMem = s.maxRam * 1024 * 1024;
  return `
    <article class="card server-card" data-server="${s.id}">
      <div class="top">
        <div class="who">
          ${srvIcon(s)}
          <div style="min-width:0">
            <h3><a href="#/server/${s.id}">${esc(s.name)}</a></h3>
            <div class="meta"><span class="tag">${esc(softwareLabel(s))}</span>${addrChip(s)}${owner ? ownerChip(s) : ''}</div>
          </div>
        </div>
        ${statusPill(s)}
      </div>
      <div class="mini-stats">
        <div><div class="k">Players</div><div class="v">${s.playerCount} / ${s.maxPlayers || '—'}</div><div class="bar lime"><i style="width:${pct(s.playerCount, s.maxPlayers)}%"></i></div></div>
        <div><div class="k">CPU</div><div class="v">${s.pid ? `${s.stats.cpu.toFixed(1)}%` : '—'}</div><div class="bar"><i style="width:${s.stats.cpu}%"></i></div></div>
        <div><div class="k">Memory</div><div class="v">${s.pid ? fmtBytes(s.stats.mem) : '—'}</div><div class="bar"><i style="width:${pct(s.stats.mem, maxMem)}%"></i></div></div>
      </div>
      <div class="row">${powerButtons(s, 'btn-sm')}<span class="spacer"></span><a class="icon-btn" href="#/server/${s.id}" title="Open server">${icon('arrow')}</a></div>
    </article>`;
}

function Dashboard(root) {
  function render() {
    const { host, panel } = state.overview;
    const servers = myServers();
    const others = state.overview.servers.length - servers.length;
    root.innerHTML = `
      <section class="hero">
        <div class="page-head" style="margin:0"><div>
          <div class="eyebrow" style="color:var(--accent)">Minecraft server panel</div>
          <h1>${greeting()}. Welcome to <span class="text-gradient">${esc(panel.name)}</span></h1>
          <p>Create, run and look after your Minecraft servers from one place: live console, files, backups, schedules and players.</p>
        </div></div>
        <div class="row"><a class="btn btn-accent" href="#/new">${icon('plus')}New server</a><a class="btn" href="#/status">${icon('signal')}Check a server</a><a class="btn" href="#/activity">Recent activity</a></div>
      </section>
      <div class="tiles">${hostTiles(host, servers)}</div>
      <div class="section">
        <div class="row section-head"><h2>${others ? 'Your servers' : 'Servers'}</h2><span class="spacer"></span>${
          others ? `<a class="btn btn-sm" href="#/all">${icon('people')}All servers (${state.overview.servers.length})</a>` : ''
        }</div>
        ${
          servers.length
            ? `<div class="server-grid">${servers.map((s) => serverCard(s)).join('')}</div>`
            : `<div class="card empty-state">
                 <div class="big">${icon('server').replace('<svg', '<svg style="width:64px;height:64px;color:var(--secondary-soft)"')}</div>
                 <h2>No servers yet</h2>
                 <p class="muted">Spin up Paper, Purpur, Fabric or Vanilla in a minute, or import a server you already have.</p>
                 <a class="btn btn-accent" href="#/new">${icon('plus')}Create your first server</a>
               </div>`
        }
      </div>`;
  }
  render();
  return { update: render };
}

// ================================================================ new server

const SOFTWARE = [
  { type: 'paper', name: 'Paper', desc: 'Fast and stable, runs Bukkit/Spigot plugins. Best for most servers.', color: '#39ff14', letter: 'P' },
  { type: 'purpur', name: 'Purpur', desc: 'A Paper fork with extra gameplay and config options.', color: '#c99bff', letter: 'Pu' },
  { type: 'fabric', name: 'Fabric', desc: 'Lightweight mod loader for Fabric mods.', color: '#ffc857', letter: 'F' },
  { type: 'vanilla', name: 'Vanilla', desc: 'The official Mojang server. No plugins or mods.', color: '#ededed', letter: 'V' },
  { type: 'custom', name: 'Custom jar', desc: 'Bring your own jar: Forge, NeoForge, Spigot and others.', color: '#e07ad6', letter: 'J' },
  { type: 'import', name: 'Import folder', desc: 'Manage a server folder that already exists on this machine.', color: '#5ce1e6', letter: 'I' },
  { type: 'velocity', name: 'Velocity', desc: 'Modern proxy: link several servers behind one address. Velocity plugins.', color: '#09add3', letter: 'Ve', proxy: true },
  { type: 'bungeecord', name: 'BungeeCord', desc: 'The classic proxy for linking servers. BungeeCord plugins.', color: '#f2a93b', letter: 'B', proxy: true },
];
const DOWNLOADABLE = ['paper', 'purpur', 'fabric', 'vanilla', 'velocity', 'bungeecord'];
const PROXY_TYPES = ['velocity', 'bungeecord'];

async function fillVersions(select, type) {
  select.disabled = true;
  select.innerHTML = '<option>Loading versions...</option>';
  try {
    const versions = await api('GET', `/api/versions?type=${enc(type)}`);
    select.innerHTML = versions.map((v, i) => `<option value="${esc(v)}">${v === 'latest' ? 'Latest build' : esc(v)}${i === 0 && v !== 'latest' ? ' (latest)' : ''}</option>`).join('');
    select.disabled = false;
  } catch (err) {
    select.innerHTML = '<option value="">Could not load versions</option>';
    toast(`Could not load ${TYPE_LABEL[type]} versions: ${err.message}`, 'bad');
  }
}

function NewServer(root) {
  const s = state.overview;
  let type = 'paper';
  const totalMb = Math.floor(s.host.memTotal / 1048576);
  api('GET', '/api/settings').then(({ settings }) => {
    const f = $('#ns-form');
    if (!f) return;
    setRam(f, 'minRam', settings.defaultMinRam);
    setRam(f, 'maxRam', settings.defaultMaxRam);
  });

  root.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Create</div><h1>New server</h1><p>Pick the software, choose a version and WebbMC downloads and sets it up for you.</p></div></div>
    <form class="form" id="ns-form" novalidate>
      <section class="card panel-card">
        <h2>1. Software</h2><p class="sub">What should this server run?</p>
        <div class="software">${SOFTWARE.filter((x) => x.type !== 'import' || me().admin).map(
          (x) => `
          <button type="button" class="soft ${x.type === type ? 'selected' : ''}" data-type="${x.type}">
            <span class="ico" style="background:${x.color}">${x.letter}</span><strong>${x.name}</strong><span>${x.desc}</span>
          </button>`,
        ).join('')}</div>
      </section>

      <section class="card panel-card">
        <h2>2. Basics</h2><p class="sub">Name it and choose where it lives.</p>
        <div class="form-grid">
          <div class="field"><label for="ns-name">Server name</label><input class="input" id="ns-name" name="name" placeholder="Survival SMP" maxlength="64" required></div>
          <div class="field" data-for="download"><label for="ns-version" id="ns-version-label">Minecraft version</label><select class="input" id="ns-version" name="version"></select></div>
          <div class="field" data-not="import"><label for="ns-port">Port</label><input class="input" id="ns-port" name="port" type="number" min="1" max="65535"><span class="hint" id="ns-port-hint">Players connect to this port. 25565 is the default.</span></div>
          <div class="field" data-for="import"><label for="ns-dir">Existing server folder</label><input class="input mono" id="ns-dir" name="importDir" placeholder="C:\\Minecraft\\my-server"><span class="hint">Full path on the machine running WebbMC.</span></div>
          <div class="field" data-for="import"><label for="ns-jar">Jar file (optional)</label><input class="input mono" id="ns-jar" name="jar" placeholder="Detected automatically"></div>
          ${
            me().admin
              ? `<div class="field"><label for="ns-owner">Owner</label><input class="input" id="ns-owner" name="owner" list="user-list" value="${esc(me().id)}" autocomplete="off" spellcheck="false">
                  <span class="hint">The account (email or username) that manages this server. As an admin you can always manage it too.</span></div>`
              : ''
          }
        </div>
      </section>

      <section class="card panel-card">
        <h2>3. Memory</h2><p class="sub">This machine has ${fmtMB(totalMb)} of RAM. Leave some for the operating system.</p>
        <div class="form-grid">
          ${ramField('maxRam', 'Maximum RAM', 4096, '-Xmx. 2 to 4 GB suits most small servers.')}
          ${ramField('minRam', 'Starting RAM', 1024, '-Xms. 0 lets Java decide.')}
        </div>
      </section>

      <section class="card panel-card" data-not="import">
        <h2 id="ns-world-title">4. World</h2><p class="sub" id="ns-world-sub">Starting values for server.properties. You can change all of these later.</p>
        <div class="form-grid">
          <div class="field"><label for="ns-motd">MOTD</label><input class="input" id="ns-motd" name="motd" placeholder="Shown in the multiplayer list" maxlength="200"><span class="hint">&amp; color codes work, like &amp;aGreen &amp;lBold. The full editor is in the Properties tab.</span></div>
          <div class="field"><label for="ns-players">Max players</label><input class="input" id="ns-players" name="maxPlayers" type="number" min="1" value="20"></div>
          <div class="field" data-game><label for="ns-gm">Game mode</label><select class="input" id="ns-gm" name="gamemode">${['survival', 'creative', 'adventure', 'spectator'].map((g) => `<option>${g}</option>`).join('')}</select></div>
          <div class="field" data-game><label for="ns-diff">Difficulty</label><select class="input" id="ns-diff" name="difficulty">${['peaceful', 'easy', 'normal', 'hard'].map((g) => `<option ${g === 'normal' ? 'selected' : ''}>${g}</option>`).join('')}</select></div>
          <div class="field" data-game><label for="ns-seed">Seed (optional)</label><input class="input mono" id="ns-seed" name="seed" placeholder="Random"></div>
          <div class="field" data-game><span class="lbl">Online mode</span>${switchHtml('onlineMode', true, 'Verify accounts with Mojang')}<span class="hint">Turn off only for LAN or proxy setups.</span></div>
          <div class="field" data-game><span class="lbl">Whitelist</span>${switchHtml('whitelist', true, 'Only listed players can join')}<span class="hint">Add players in the Players tab once the server is running.</span></div>
        </div>
      </section>

      <section class="card panel-card">
        <h2 id="ns-last">5. Finish</h2>
        <div class="stack" style="margin-top:14px">
          <label class="check" data-not="import" data-game><input type="checkbox" name="eula"> <span>I agree to the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">Minecraft End User License Agreement</a>. A server will not start without this.</span></label>
          <label class="check"><input type="checkbox" name="startAfter" checked> <span>Start the server as soon as it is ready</span></label>
          <label class="check"><input type="checkbox" name="autoStart"> <span>Start automatically whenever the panel starts</span></label>
          <label class="check"><input type="checkbox" name="autoRestart" checked> <span>Restart automatically if it crashes</span></label>
        </div>
        <div class="form-actions" style="margin-top:18px"><a class="btn btn-ghost" href="#/">Cancel</a><button class="btn btn-accent" type="submit" id="ns-submit">${icon('plus')}Create server</button></div>
      </section>
    </form>`;

  const form = $('#ns-form');
  const versionSel = $('#ns-version');
  wireRam(form);
  if (form.elements.owner) fillUserList();
  api('GET', '/api/servers/next-port').then(({ port }) => {
    if (!form.elements.port.value) form.elements.port.value = port;
  });

  function applyType() {
    $$('.soft', form).forEach((b) => b.classList.toggle('selected', b.dataset.type === type));
    $$('[data-for="download"]', form).forEach((el) => el.classList.toggle('hidden', !DOWNLOADABLE.includes(type)));
    $$('[data-for="import"]', form).forEach((el) => el.classList.toggle('hidden', type !== 'import'));
    $$('[data-not="import"]', form).forEach((el) => el.classList.toggle('hidden', type === 'import'));
    const proxy = PROXY_TYPES.includes(type);
    $$('[data-game]', form).forEach((el) => el.classList.toggle('hidden', proxy));
    $('#ns-last').textContent = type === 'import' ? '4. Finish' : '5. Finish';
    $('#ns-version-label').textContent = proxy ? `${TYPE_LABEL[type]} version` : 'Minecraft version';
    $('#ns-world-title').textContent = proxy ? '4. Proxy' : '4. World';
    $('#ns-world-sub').textContent = proxy
      ? 'Players join the proxy, which sends them on to your other servers. Add those servers to its config file once it is created.'
      : 'Starting values for server.properties. You can change all of these later.';
    $('#ns-port-hint').textContent = proxy ? 'Players connect to the proxy on this port. Give the servers behind it other ports.' : 'Players connect to this port. 25565 is the default.';
    if (proxy && form.elements.maxPlayers.value === '20') form.elements.maxPlayers.value = '500';
    if (!proxy && form.elements.maxPlayers.value === '500') form.elements.maxPlayers.value = '20';
    if (DOWNLOADABLE.includes(type)) fillVersions(versionSel, type);
  }
  form.addEventListener('click', (e) => {
    const b = e.target.closest('.soft');
    if (!b) return;
    type = b.dataset.type;
    applyType();
  });
  applyType();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const body = {
      type,
      name: f.name.value,
      version: DOWNLOADABLE.includes(type) ? versionSel.value : '',
      port: f.port.value,
      maxRam: f.maxRam.value,
      minRam: f.minRam.value,
      motd: f.motd.value,
      maxPlayers: f.maxPlayers.value,
      gamemode: f.gamemode.value,
      difficulty: f.difficulty.value,
      seed: f.seed.value.trim(),
      onlineMode: f.onlineMode.checked,
      whitelist: f.whitelist.checked,
      eula: f.eula.checked,
      startAfter: f.startAfter.checked,
      autoStart: f.autoStart.checked,
      autoRestart: f.autoRestart.checked,
      importDir: f.importDir.value,
      jar: f.jar.value,
      ...(f.owner ? { owner: f.owner.value.trim() } : {}),
    };
    if (!body.name.trim()) return toast('Give the server a name', 'bad');
    if (type !== 'import' && !PROXY_TYPES.includes(type) && !body.eula) return toast('You need to accept the Minecraft EULA', 'bad');
    const btn = $('#ns-submit');
    btn.disabled = true;
    try {
      const srv = await api('POST', '/api/servers', body);
      toast(`Created ${srv.name}`, 'ok');
      await poll();
      location.hash = `#/server/${srv.id}/console`;
    } catch (err) {
      toast(err.message, 'bad');
      btn.disabled = false;
    }
  };
  return {};
}

// ================================================================ server view

const TABS = [
  ['console', 'Console', 'terminal'],
  ['metrics', 'Metrics', 'chart'],
  ['players', 'Players', 'people'],
  ['addons', 'Plugins', 'puzzle'],
  ['files', 'Files', 'folder'],
  ['properties', 'Properties', 'tune'],
  ['backups', 'Backups', 'archive'],
  ['schedules', 'Schedules', 'clock'],
  ['settings', 'Settings', 'cog'],
];

function ServerView(root, id, initialTab) {
  root.innerHTML = `
    <div data-server="${id}">
      <section class="card server-head" id="sv-head"></section>
      <div class="tiles" id="sv-tiles"></div>
      <nav class="tabs" id="sv-tabs">${TABS.map(
        ([k, label, ic]) => `<a href="#/server/${id}/${k}" data-tab="${k}">${icon(ic)}${k === 'addons' ? addonLabel(findServer(id)) : label}</a>`,
      ).join('')}</nav>
      <div id="sv-body"></div>
    </div>`;
  let srv = findServer(id);
  let ctl = null;
  const ctx = {
    id,
    get srv() {
      return srv;
    },
  };

  function renderHead() {
    const s = srv;
    $('#sv-head').innerHTML = `
      ${srvIcon(s, 'lg')}
      <div class="title">
        <h1>${esc(s.name)} ${statusPill(s)}</h1>
        <div class="meta"><span class="tag">${esc(softwareLabel(s))}</span>${addrChip(s)}${ownerChip(s)}${s.ping?.motd ? `<span class="faint">${esc(s.ping.motd)}</span>` : ''}</div>
      </div>
      <div class="power">${powerButtons(s)}${s.pid ? `<button class="btn btn-ghost" data-power="kill" title="Force-kill the Java process">${icon('bolt')}Kill</button>` : ''}</div>`;
    const maxMem = s.maxRam * 1048576;
    $('#sv-tiles').innerHTML = `
      <div class="card tile"><div class="label">CPU</div><div class="value">${s.pid ? s.stats.cpu.toFixed(1) : '0'}<small>%</small></div><div class="bar ${s.stats.cpu > 85 ? 'hot' : ''}"><i style="width:${s.stats.cpu}%"></i></div></div>
      <div class="card tile"><div class="label">Memory</div><div class="value">${s.pid ? fmtBytes(s.stats.mem) : '0 B'}<small>/ ${fmtMB(s.maxRam)}</small></div><div class="bar"><i style="width:${pct(s.stats.mem, maxMem)}%"></i></div></div>
      <div class="card tile"><div class="label">Players</div><div class="value">${s.playerCount}<small>/ ${s.maxPlayers || '—'}</small></div><div class="bar lime"><i style="width:${pct(s.playerCount, s.maxPlayers)}%"></i></div></div>
      <div class="card tile"><div class="label">Uptime</div><div class="value">${s.startedAt ? fmtDuration(Date.now() - s.startedAt) : '—'}</div><div class="faint small">${s.pid ? `PID ${s.pid}` : 'Not running'}</div></div>`;
  }

  function setTab(tab) {
    if (!TAB_VIEWS[tab]) tab = 'console';
    ctl?.destroy?.();
    $$('#sv-tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
    const body = $('#sv-body');
    body.innerHTML = '';
    ctl = TAB_VIEWS[tab](body, ctx);
  }

  renderHead();
  setTab(initialTab);
  return {
    serverId: id,
    setTab,
    update() {
      srv = findServer(id);
      if (!srv) {
        location.hash = '#/';
        return;
      }
      renderHead();
      ctl?.update?.();
    },
    destroy() {
      ctl?.destroy?.();
    },
  };
}

// ---------------------------------------------------------------- console tab

const ANSI = {
  30: '#6d6785', 31: '#ff6b8b', 32: '#39ff14', 33: '#ffc857', 34: '#7aa2ff', 35: '#e07ad6', 36: '#5ce1e6', 37: '#ededed',
  90: '#8f89a6', 91: '#ff8fa6', 92: '#7dff5e', 93: '#ffe08a', 94: '#9db8ff', 95: '#f19be6', 96: '#8ff0f3', 97: '#ffffff',
};
const MC_COLORS = {
  0: '#6d6785', 1: '#6b74ff', 2: '#2fcc2f', 3: '#22c4c4', 4: '#e0475f', 5: '#c45ac4', 6: '#ffaa00', 7: '#bdbdbd',
  8: '#8f89a6', 9: '#7d7dff', a: '#55ff55', b: '#55ffff', c: '#ff5555', d: '#ff55ff', e: '#ffff55', f: '#ffffff',
};
const ANSI_BASIC = Object.values(ANSI);
function xterm256(n) {
  if (n < 16) return ANSI_BASIC[n] || null;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const c = (x) => (x ? 55 + x * 40 : 0);
  return `rgb(${c(Math.floor(i / 36))},${c(Math.floor(i / 6) % 6)},${c(i % 6)})`;
}

function colorize(raw) {
  const s = raw.replace(/\r/g, '').replace(/\x1b\[[0-9;?]*[A-Za-ln-z]/g, '');
  const re = /\x1b\[([0-9;]*)m|§([0-9a-fk-orx])/gi;
  let html = '';
  let color = null;
  let bold = false;
  let last = 0;
  const text = (t) => {
    if (!t) return;
    const style = (color ? `color:${color};` : '') + (bold ? 'font-weight:700;' : '');
    html += style ? `<span style="${style}">${esc(t)}</span>` : esc(t);
  };
  let m;
  while ((m = re.exec(s))) {
    text(s.slice(last, m.index));
    last = re.lastIndex;
    if (m[2]) {
      const c = m[2].toLowerCase();
      if (MC_COLORS[c]) {
        color = MC_COLORS[c];
        bold = false;
      } else if (c === 'l') bold = true;
      else if (c === 'r') {
        color = null;
        bold = false;
      }
      continue;
    }
    const codes = (m[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) {
        color = null;
        bold = false;
      } else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c === 39) color = null;
      else if (ANSI[c]) color = ANSI[c];
      else if (c === 38 && codes[i + 1] === 2) {
        color = `rgb(${codes[i + 2] | 0},${codes[i + 3] | 0},${codes[i + 4] | 0})`;
        i += 4;
      } else if (c === 38 && codes[i + 1] === 5) {
        color = xterm256(codes[i + 2] | 0);
        i += 2;
      }
    }
  }
  text(s.slice(last));
  return html;
}

const QUICK_COMMANDS = ['list', 'save-all', 'time set day', 'weather clear', 'say '];

function ConsoleTab(el, ctx) {
  el.innerHTML = `
    <div class="card console-card">
      <div class="console-bar">
        ${QUICK_COMMANDS.map((c) => `<button type="button" class="chip" data-quick="${esc(c)}">${esc(c.trim())}${c.endsWith(' ') ? '...' : ''}</button>`).join('')}
        <span class="spacer"></span>
        <label class="switch small"><input type="checkbox" id="c-ts"><span class="track"></span>Timestamps</label>
        <label class="switch small"><input type="checkbox" id="c-auto" checked><span class="track"></span>Auto-scroll</label>
        <button type="button" class="btn btn-sm btn-ghost" id="c-clear">Clear</button>
      </div>
      <div class="console" id="c-out" role="log" aria-live="off"></div>
      <form class="console-input" id="c-form">
        <span class="prompt">&gt;</span>
        <input id="c-in" autocomplete="off" spellcheck="false" aria-label="Console command">
        <button class="btn btn-accent btn-sm" type="submit">Send</button>
      </form>
    </div>`;
  const out = $('#c-out', el);
  const input = $('#c-in', el);
  const auto = $('#c-auto', el);
  const ts = $('#c-ts', el);
  ts.checked = pref.get('consoleTs', false);
  out.classList.toggle('show-ts', ts.checked);
  ts.onchange = () => {
    pref.set('consoleTs', ts.checked);
    out.classList.toggle('show-ts', ts.checked);
  };

  let queue = [];
  let frame = 0;
  function lineEl(entry) {
    const d = document.createElement('div');
    const plain = entry.line.replace(/\x1b\[[0-9;]*m|§./g, '');
    let cls = '';
    if (entry.kind === 'panel') cls = 'panel';
    else if (entry.kind === 'cmd') cls = 'cmd';
    else if (/\b(ERROR|SEVERE|FATAL)\b|Exception\b|^\s+at [\w.$]+\(/.test(plain)) cls = 'error';
    else if (/\bWARN(ING)?\b/.test(plain)) cls = 'warn';
    d.className = `ln ${cls}`;
    d.innerHTML = `<span class="ts">${fmtTime(entry.t)}</span>${colorize(entry.line)}`;
    return d;
  }
  function flush() {
    frame = 0;
    if (!queue.length) return;
    const stick = auto.checked;
    const frag = document.createDocumentFragment();
    for (const entry of queue) frag.append(lineEl(entry));
    queue = [];
    out.append(frag);
    while (out.childElementCount > 2000) out.firstElementChild.remove();
    if (stick) out.scrollTop = out.scrollHeight;
  }
  const schedule = () => frame || (frame = requestAnimationFrame(flush));

  const es = new EventSource(`/api/servers/${ctx.id}/console`);
  es.addEventListener('backlog', (e) => {
    out.innerHTML = '';
    queue = JSON.parse(e.data);
    flush();
  });
  es.addEventListener('line', (e) => {
    queue.push(JSON.parse(e.data));
    schedule();
  });

  const histKey = `history:${ctx.id}`;
  const history = pref.get(histKey, []);
  let cursor = history.length;
  async function send(command) {
    try {
      await api('POST', `/api/servers/${ctx.id}/command`, { command });
      if (history[history.length - 1] !== command) history.push(command);
      if (history.length > 100) history.splice(0, history.length - 100);
      pref.set(histKey, history);
      cursor = history.length;
      return true;
    } catch (err) {
      toast(err.message, 'bad');
      return false;
    }
  }
  $('#c-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const command = input.value.trim();
    if (command && (await send(command))) input.value = '';
  };
  input.onkeydown = (e) => {
    if (e.key === 'ArrowUp' && cursor > 0) {
      e.preventDefault();
      input.value = history[--cursor];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      cursor = Math.min(history.length, cursor + 1);
      input.value = history[cursor] ?? '';
    }
  };
  el.querySelector('.console-bar').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-quick]');
    if (!chip) return;
    const c = chip.dataset.quick;
    if (c.endsWith(' ')) {
      input.value = c;
      input.focus();
    } else send(c);
  });
  $('#c-clear', el).onclick = () => (out.innerHTML = '');

  function sync() {
    const live = Boolean(ctx.srv.pid);
    input.disabled = !live;
    input.placeholder = live ? 'Type a command, e.g. op Steve (Up/Down for history)' : 'Start the server to send commands';
    $$('.chip', el).forEach((c) => (c.disabled = !live));
  }
  sync();
  if (ctx.srv.pid) input.focus({ preventScroll: true });
  return {
    update: sync,
    destroy() {
      es.close();
      cancelAnimationFrame(frame);
    },
  };
}

// ---------------------------------------------------------------- metrics tab

function hexA(hex, a) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function drawChart(canvas, points, { color, max, fmt }) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const padL = 60;
  const padR = 8;
  const padT = 8;
  const padB = 20;
  const cw = w - padL - padR;
  const ch = h - padT - padB;
  g.font = '11px Inter, system-ui, sans-serif';
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = Math.round(padT + (ch * i) / 4) + 0.5;
    g.strokeStyle = 'rgba(237,237,237,0.08)';
    g.beginPath();
    g.moveTo(padL, y);
    g.lineTo(w - padR, y);
    g.stroke();
    g.fillStyle = '#8f89a6';
    g.textAlign = 'right';
    g.fillText(fmt(max * (1 - i / 4)), padL - 8, y + 4);
  }
  g.textAlign = 'left';
  g.fillText('10 min ago', padL, h - 4);
  g.textAlign = 'right';
  g.fillText('now', w - padR, h - 4);
  if (points.length < 2) {
    g.textAlign = 'center';
    g.fillStyle = '#a49fb5';
    g.fillText(points.length ? 'Collecting data...' : 'No data while the server is offline', padL + cw / 2, padT + ch / 2);
    return;
  }
  const t1 = Date.now();
  const t0 = t1 - 10 * 60 * 1000;
  const x = (t) => padL + (cw * (t - t0)) / (t1 - t0);
  const y = (v) => padT + ch * (1 - Math.min(v, max) / max);
  const pts = points.filter((p) => p.t >= t0);
  if (pts.length < 2) return;
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.v)) : g.moveTo(x(p.t), y(p.v))));
  const grad = g.createLinearGradient(0, padT, 0, padT + ch);
  grad.addColorStop(0, hexA(color, 0.35));
  grad.addColorStop(1, hexA(color, 0));
  g.save();
  g.lineTo(x(pts[pts.length - 1].t), padT + ch);
  g.lineTo(x(pts[0].t), padT + ch);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.restore();
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.v)) : g.moveTo(x(p.t), y(p.v))));
  g.strokeStyle = color;
  g.lineWidth = 2;
  g.lineJoin = 'round';
  g.stroke();
}

function MetricsTab(el, ctx) {
  el.innerHTML = `
    <div class="cols-2">
      <div class="card chart-card"><div class="head"><h3>CPU</h3><span class="value" id="m-cpu">—</span></div><canvas id="ch-cpu"></canvas><div class="faint small">Share of all host CPU cores</div></div>
      <div class="card chart-card"><div class="head"><h3>Memory</h3><span class="value" id="m-mem">—</span></div><canvas id="ch-mem"></canvas><div class="faint small">Resident memory of the Java process (can exceed -Xmx slightly)</div></div>
      <div class="card chart-card"><div class="head"><h3>Players</h3><span class="value" id="m-pl">—</span></div><canvas id="ch-pl"></canvas><div class="faint small">Players online</div></div>
      <div class="card panel-card"><h3 style="margin-bottom:14px">Details</h3><dl class="kv" id="m-kv"></dl></div>
    </div>`;
  let history = [];
  let size = null;
  api('GET', `/api/servers/${ctx.id}/size`)
    .then((r) => {
      size = r.bytes;
      details();
    })
    .catch(() => {});

  function details() {
    const s = ctx.srv;
    const rows = [
      ['Status', statusInfo(s).label],
      ['Software', softwareLabel(s)],
      ['Reported version', s.ping?.version || '—'],
      ['Address', serverAddress(s)],
      ['Started', s.startedAt ? fmtDate(s.startedAt) : '—'],
      ['Process ID', s.pid || '—'],
      ['Size on disk', size == null ? 'Calculating...' : fmtBytes(size)],
      ['Folder', `<span class="mono small">${esc(s.dir)}</span>`],
    ];
    $('#m-kv', el).innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${k === 'Folder' ? v : esc(v)}</dd>`).join('');
  }

  function draw() {
    const s = ctx.srv;
    const peakMem = Math.max(s.maxRam * 1048576 * 1.15, ...history.map((p) => p.mem));
    const maxPl = Math.max(s.maxPlayers || 1, ...history.map((p) => p.players));
    const last = history[history.length - 1];
    $('#m-cpu', el).textContent = s.pid && last ? `${last.cpu.toFixed(1)}%` : '—';
    $('#m-mem', el).textContent = s.pid && last ? fmtBytes(last.mem) : '—';
    $('#m-pl', el).textContent = `${s.playerCount} / ${s.maxPlayers || '—'}`;
    const cpuMax = Math.max(20, Math.ceil(Math.max(...history.map((p) => p.cpu), 0) / 20) * 20);
    const memAxis = (v) => (v >= 1073741824 ? `${(v / 1073741824).toFixed(1)} GB` : `${Math.round(v / 1048576)} MB`);
    drawChart($('#ch-cpu', el), history.map((p) => ({ t: p.t, v: p.cpu })), { color: '#c12aab', max: Math.min(100, cpuMax), fmt: (v) => `${v.toFixed(0)}%` });
    drawChart($('#ch-mem', el), history.map((p) => ({ t: p.t, v: p.mem })), { color: '#39ff14', max: peakMem, fmt: memAxis });
    drawChart($('#ch-pl', el), history.map((p) => ({ t: p.t, v: p.players })), { color: '#e07ad6', max: maxPl, fmt: (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1)) });
  }

  async function load() {
    try {
      history = (await api('GET', `/api/servers/${ctx.id}/metrics`)).history;
      draw();
    } catch {
      /* next tick retries */
    }
  }
  load();
  details();
  const timer = setInterval(load, 3000);
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  return {
    update: details,
    destroy() {
      clearInterval(timer);
      window.removeEventListener('resize', onResize);
    },
  };
}

// ---------------------------------------------------------------- players tab

const avatar = (name) =>
  `<span class="avatar">${esc(name[0]?.toUpperCase() || '?')}<img src="https://mc-heads.net/avatar/${enc(name)}/64" alt="" loading="lazy" onload="this.parentNode.firstChild.remove()" onerror="this.remove()"></span>`;

function PlayersTab(el, ctx) {
  const LISTS = [
    { key: 'ops', title: 'Operators', add: 'op', remove: 'deop', placeholder: 'Player name', hint: 'Operators can use every command.' },
    { key: 'whitelist', title: 'Whitelist', add: 'whitelist add', remove: 'whitelist remove', placeholder: 'Player name', hint: '' },
    { key: 'banned', title: 'Banned players', add: 'ban', remove: 'pardon', placeholder: 'Player name', hint: 'Banned players cannot join.' },
    { key: 'bannedIps', title: 'Banned IPs', add: 'ban-ip', remove: 'pardon-ip', placeholder: 'IP address or player', hint: '' },
  ];
  el.innerHTML = `
    <div id="pl-notice"></div>
    <section>
      <div class="row" style="margin-bottom:14px"><h2>Online now</h2><span class="tag" id="pl-count">0</span></div>
      <div id="pl-online"></div>
    </section>
    <section class="section" id="pl-lists">
      <div class="cols-2">
        ${LISTS.map(
          (l) => `
          <div class="card list-card" data-list="${l.key}">
            <div class="row"><h3>${l.title}</h3><span class="tag" data-count>0</span><span class="spacer"></span>${
              l.key === 'whitelist' ? `<span data-wl-toggle></span>` : ''
            }</div>
            ${l.hint ? `<p class="faint small">${l.hint}</p>` : ''}
            <ul data-items></ul>
            <form class="input-group" data-add><input class="input" name="v" placeholder="${l.placeholder}" autocomplete="off"><button class="btn btn-sm" style="height:40px">${icon('plus')}Add</button></form>
          </div>`,
        ).join('')}
      </div>
    </section>`;

  let data = null;
  const live = () => Boolean(ctx.srv.pid);
  const run = async (command, msg) => {
    try {
      await api('POST', `/api/servers/${ctx.id}/command`, { command });
      if (msg) toast(msg, 'ok');
      setTimeout(load, 800);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  function render() {
    if (!data) return;
    const isLive = live();
    const proxy = ctx.srv.proxy;
    $('#pl-lists', el).classList.toggle('hidden', proxy);
    $('#pl-notice', el).innerHTML = !isLive
      ? `${notice('The server is offline. Start it to manage players: actions here are sent as console commands.', 'warn')}<div style="height:16px"></div>`
      : data.pingError
        ? `${notice(
            `The player count may be off: ${esc(data.pingError)}. WebbMC is counting joins from the console instead. ${proxy ? `Check the listening address in <span class="mono">${esc(ctx.srv.configFile)}</span>.` : 'Check <span class="mono">server-ip</span> and <span class="mono">enable-status</span> in Properties.'}`,
            'warn',
          )}<div style="height:16px"></div>`
        : proxy
          ? `${notice(`This is a ${esc(TYPE_LABEL[ctx.srv.kind] || 'proxy')} proxy. Operators, the whitelist and bans live on the servers behind it, so manage them there (or with a proxy plugin).`)}<div style="height:16px"></div>`
          : '';
    const ops = new Set(data.ops.map((o) => o.name.toLowerCase()));
    $('#pl-count', el).textContent = `${data.count}${data.ping ? ` / ${data.ping.max}` : ''}`;
    const hidden = Math.max(0, data.count - data.online.length);
    const hiddenNote = hidden ? `<div class="faint small" style="margin-top:8px">+${hidden} more online. The server hides their names.</div>` : '';
    $('#pl-online', el).innerHTML = data.online.length
      ? `<div class="player-grid">${data.online
          .map((n) => {
            const op = ops.has(n.toLowerCase());
            return `
            <div class="card player">
              ${avatar(n)}
              <div class="who"><strong>${esc(n)}</strong><span class="faint small">${proxy ? 'Connected' : op ? 'Operator' : 'Player'}</span></div>
              ${proxy ? '' : `<button class="btn btn-sm btn-ghost" data-cmd="${op ? 'deop' : 'op'} ${esc(n)}" title="${op ? 'Remove operator' : 'Make operator'}">${icon('shield')}</button>
              <button class="btn btn-sm btn-ghost" data-cmd="kick ${esc(n)}" title="Kick">${icon('logout')}</button>
              <button class="btn btn-sm btn-ghost" data-ban="${esc(n)}" title="Ban">${icon('ban')}</button>`}
            </div>`;
          })
          .join('')}</div>${hiddenNote}`
      : hidden
      ? `<div class="card panel-card muted">${hidden} player${hidden === 1 ? '' : 's'} online. The server hides their names.</div>`
      : `<div class="card panel-card muted">${isLive ? 'Nobody is online right now.' : 'Server is offline.'}</div>`;

    for (const l of LISTS) {
      const card = $(`[data-list="${l.key}"]`, el);
      const items = data[l.key] || [];
      $('[data-count]', card).textContent = items.length;
      $('[data-items]', card).innerHTML = items.length
        ? items
            .map((it) => {
              const label = it.name || it.ip || '?';
              return `<li><span class="nm">${it.name ? avatar(it.name) : ''}<span>${esc(label)}</span>${
                it.reason && l.key.startsWith('banned') ? `<span class="faint small">· ${esc(it.reason)}</span>` : ''
              }</span><button class="icon-btn danger" data-cmd="${l.remove} ${esc(label)}" title="Remove" ${isLive ? '' : 'disabled'}>${icon('trash')}</button></li>`;
            })
            .join('')
        : '<li class="faint small" style="background:none;padding:2px 0">Empty</li>';
      $$('[data-add] input, [data-add] button', card).forEach((x) => (x.disabled = !isLive));
      if (l.key === 'whitelist') {
        $('[data-wl-toggle]', card).innerHTML = `<label class="switch small" title="Turn the whitelist on or off"><input type="checkbox" data-wl ${
          data.whitelistEnabled ? 'checked' : ''
        } ${isLive ? '' : 'disabled'}><span class="track"></span>${data.whitelistEnabled ? 'On' : 'Off'}</label>`;
      }
    }
  }

  el.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-cmd]');
    if (c) return run(c.dataset.cmd, `Sent: ${c.dataset.cmd}`);
    const b = e.target.closest('[data-ban]');
    if (b) {
      const name = b.dataset.ban;
      const reason = await modal({
        title: `Ban ${name}?`,
        confirmText: 'Ban player',
        danger: true,
        body: `<div class="field"><label>Reason (optional)</label><input class="input" name="reason" autofocus autocomplete="off"></div>`,
        onConfirm: (f) => f.elements.reason.value.trim() || ' ',
      });
      if (reason) run(`ban ${name}${reason.trim() ? ` ${reason.trim()}` : ''}`, `${name} banned`);
    }
  });
  el.addEventListener('change', (e) => {
    if (e.target.matches('[data-wl]')) run(`whitelist ${e.target.checked ? 'on' : 'off'}`, `Whitelist turned ${e.target.checked ? 'on' : 'off'}`);
  });
  el.addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target.closest('[data-add]');
    const l = LISTS.find((x) => x.key === form.closest('[data-list]').dataset.list);
    const v = form.elements.v.value.trim();
    if (!v) return;
    form.elements.v.value = '';
    run(`${l.add} ${v}`, `Sent: ${l.add} ${v}`);
  });

  async function load() {
    try {
      data = await api('GET', `/api/servers/${ctx.id}/players`);
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }
  load();
  const timer = setInterval(load, 5000);
  return { update: render, destroy: () => clearInterval(timer) };
}

// ---------------------------------------------------------------- plugins / mods tab

const addonLabel = (s) =>
  s.type === 'fabric' ? 'Mods' : s.type === 'vanilla' ? 'Datapacks' : ['custom', 'import'].includes(s.type) ? 'Add-ons' : 'Plugins';
const LOADER_NAME = { paper: 'Paper', purpur: 'Purpur', fabric: 'Fabric', velocity: 'Velocity', bungeecord: 'BungeeCord' };

const SOURCE_LABEL = { modrinth: 'Modrinth', hangar: 'Hangar', essentialsx: 'EssentialsX', geysermc: 'GeyserMC', github: 'GitHub', link: 'Link' };
const fmtCount = (n) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${+(n / 1e3).toFixed(1)}k` : String(n || 0));

function AddonsTab(el, ctx) {
  el.innerHTML = `
    <div class="card panel-card">
      <div class="row" style="margin-bottom:6px"><h3 id="a-head">Add plugins</h3><span class="spacer"></span>
        <div class="seg" id="a-inst" role="tablist" aria-label="Installed"><button type="button" data-src="installed" role="tab">Installed<span class="seg-count hidden" id="a-upd-count"></span></button></div>
        <select class="input a-ver hidden" id="a-ver" aria-label="Minecraft version to search for"></select>
        <div class="seg" id="a-src" role="tablist" aria-label="Where to get them from"></div></div>
      <p class="sub" id="a-sub">Loading...</p>
      <div id="a-pane"></div>
      <div id="a-result"></div>
    </div>
    <div id="a-restart"></div>
    <section class="section" id="a-main">
      <div class="row" style="margin-bottom:14px"><h2 id="a-title">Installed</h2><span class="tag" id="a-count">0</span></div>
      <div class="card table-wrap" id="a-list"><p class="muted" style="padding:16px">Loading...</p></div>
    </section>
    <section class="section hidden" id="a-dp-wrap">
      <div class="row" style="margin-bottom:14px"><h2>Datapacks</h2><span class="tag" id="a-dp-count">0</span></div>
      <div class="card table-wrap" id="a-dp"></div>
    </section>`;

  let info = null; // last /addons response: kind, loaders, gameVersion, sources, installed files
  let source = null;
  let changed = false;
  let searchTimer = null;
  let searchSeq = 0;
  // Minecraft version Modrinth and Hangar results must support: '' = this server's, 'all' = any, or e.g. '1.21.4'.
  let versionPick = '';
  const VERSIONED = ['modrinth', 'hangar', 'installed'];
  const what = () => (info.kind === 'mods' ? 'mod' : info.kind === 'datapacks' ? 'datapack' : 'plugin');
  const fileKind = () => (info.kind === 'datapacks' ? '.zip' : '.jar');
  const target = () => {
    const l = info.loaders[0];
    const base = info.kind === 'datapacks' ? 'Vanilla' : LOADER_NAME[l] || l;
    if (info.proxy) return `${base} (proxy plugins work on any Minecraft version)`;
    if (versionPick === 'all') return `${base} (any Minecraft version)`;
    const gv = versionPick || info.gameVersion;
    return `${base}${gv ? ` ${gv}` : ''}`;
  };

  async function fillVersionPicker() {
    const sel = $('#a-ver', el);
    const current = `Current version${info.gameVersion ? ` (${info.gameVersion})` : ''}`;
    sel.innerHTML = `<option value="all">All versions</option><option value="" selected>${esc(current)}</option>`;
    try {
      const versions = await api('GET', '/api/versions?type=vanilla');
      sel.insertAdjacentHTML('beforeend', versions.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join(''));
    } catch {
      /* the two built-in choices still work */
    }
    sel.value = versionPick;
  }
  const sub = (html) => ($('#a-sub', el).innerHTML = html);
  const pane = (html) => {
    $('#a-pane', el).innerHTML = html;
    return $('#a-pane', el);
  };

  const rows = (items, label) =>
    items.length
      ? `<table class="table"><thead><tr><th>${label}</th><th class="num">Size</th><th class="num">Modified</th><th>On</th><th></th></tr></thead><tbody>
          ${items
            .map(
              (a) => `<tr>
              <td><div class="row" style="gap:8px"><span style="font-weight:600">${esc(a.title || a.name.replace(/\.(jar|zip)(\.disabled)?$/i, ''))}</span>${
                a.version ? `<span class="faint small">${esc(a.version)}</span>` : ''
              }${a.source ? `<span class="tag">${esc(SOURCE_LABEL[a.source] || a.source)}</span>` : ''}</div>
                <div class="mono faint small">${esc(a.name)}</div></td>
              <td class="num">${fmtBytes(a.size)}</td>
              <td class="num">${fmtDate(a.mtime)}</td>
              <td><label class="switch" title="${a.enabled ? 'Disable' : 'Enable'}"><input type="checkbox" data-toggle="${esc(a.path)}" ${a.enabled ? 'checked' : ''}><span class="track"></span></label></td>
              <td class="actions">${
                a.page ? `<a class="icon-btn" href="${esc(a.page)}" target="_blank" rel="noopener" title="Open the project page">${icon('external')}</a>` : ''
              }<button class="icon-btn danger" data-del="${esc(a.path)}" data-name="${esc(a.title || a.name)}" title="Delete">${icon('trash')}</button></td>
            </tr>`,
            )
            .join('')}</tbody></table>`
      : `<div class="empty-state"><p class="muted">Nothing installed yet. Add something above.</p></div>`;

  function restartHint() {
    $('#a-restart', el).innerHTML =
      changed && ctx.srv.pid
        ? `<div style="height:16px"></div>${notice(
            `Changes load on the next start. <button class="btn btn-sm" data-power="restart" style="margin-left:8px">${icon('restart')}Restart now</button>`,
          )}`
        : '';
  }

  async function loadList(fetched = null) {
    try {
      info = fetched || (await api('GET', `/api/servers/${ctx.id}/addons`));
    } catch (err) {
      return toast(err.message, 'bad');
    }
    const label = what()[0].toUpperCase() + what().slice(1);
    if (info.kind === 'datapacks') {
      $('#a-title', el).textContent = 'Datapacks';
      $('#a-count', el).textContent = info.datapacks.length;
      $('#a-list', el).innerHTML = rows(info.datapacks, 'Datapack');
      $('#a-dp-wrap', el).classList.add('hidden');
    } else {
      $('#a-title', el).textContent = `Installed ${what()}s`;
      $('#a-count', el).textContent = info.addons.length;
      $('#a-list', el).innerHTML = rows(info.addons, label);
      $('#a-dp-wrap', el).classList.toggle('hidden', !info.datapacks.length);
      $('#a-dp-count', el).textContent = info.datapacks.length;
      $('#a-dp', el).innerHTML = rows(info.datapacks, 'Datapack');
    }
    restartHint();
    syncSections();
  }

  // The Installed tab lists everything itself, so the lists below would only repeat it.
  function syncSections() {
    const inTab = source === 'installed';
    $('#a-main', el).classList.toggle('hidden', inTab);
    if (inTab) $('#a-dp-wrap', el).classList.add('hidden');
    else if (info && info.kind !== 'datapacks') $('#a-dp-wrap', el).classList.toggle('hidden', !info.datapacks.length);
  }

  function setSource(s) {
    source = s;
    searchSeq++;
    pref.set('addonSource', s);
    $('#a-head', el).textContent = s === 'installed' ? `Installed ${what()}s` : `Add ${what()}s`;
    $$('#a-src [data-src], #a-inst [data-src]', el).forEach((b) => {
      b.classList.toggle('active', b.dataset.src === s);
      b.setAttribute('aria-selected', String(b.dataset.src === s));
    });
    $('#a-ver', el).classList.toggle('hidden', !VERSIONED.includes(s) || Boolean(info?.proxy));
    $('#a-result', el).innerHTML = '';
    syncSections();
    PANES[s]();
  }

  // ---- Installed: everything in the plugins/mods folder, with whether a newer build exists
  let updates = []; // last check, for the Update buttons
  const updateCount = (n) => {
    const badge = $('#a-upd-count', el);
    badge.textContent = n || '';
    badge.classList.toggle('hidden', !n);
    badge.title = n ? `${n} update${n === 1 ? '' : 's'} available` : '';
  };
  const statusCell = (u) => {
    if (u.status === 'update' && u.switchTo)
      return `<span class="pill warn" title="This file is built for another server type; ${esc(u.switchTo)} has its own build of the same release"><span class="dot warn"></span>${esc(u.switchTo)} build: ${esc(u.latest)}</span>`;
    if (u.status === 'update') return `<span class="pill warn" title="${esc(u.note || '')}"><span class="dot warn"></span>Update: ${esc(u.latest)}</span>`;
    if (u.status === 'latest') return `<span class="pill ok" title="${esc(u.note || '')}"><span class="dot ok"></span>Latest${u.note ? ' *' : ''}</span>`;
    if (u.status === 'error') return `<span class="pill bad" title="${esc(u.error)}"><span class="dot bad"></span>Could not check</span>`;
    return `<span class="pill" title="${esc(u.note || '')}"><span class="dot"></span>Unknown source</span>`;
  };

  async function installedPane(force = false) {
    sub(
      `Everything installed in <span class="mono">${esc(info.dir)}</span>${info.datapacks.length && info.kind !== 'datapacks' ? ' and the world\'s datapacks' : ''}, checked for newer builds for <strong>${esc(
        target(),
      )}</strong>. Files you added yourself are recognised when they are on Modrinth, and Geyser, Floodgate and MCXboxBroadcast by GeyserMC's own builds.`,
    );
    pane(`
      <div class="row" style="margin-bottom:12px"><span class="faint small" id="up-when"></span><span class="spacer"></span><span id="up-all"></span>
        <button type="button" class="btn btn-sm" id="up-check">${icon('restart')}Check again</button></div>
      <div class="card table-wrap" id="up-list"><p class="muted row" style="padding:14px"><span class="spin"></span>Checking for updates...</p></div>`);
    const seq = ++searchSeq;
    let d;
    try {
      d = await api('GET', `/api/servers/${ctx.id}/addons/updates?version=${enc(versionPick)}${force ? '&force=1' : ''}`);
    } catch (err) {
      if (seq === searchSeq) $('#up-list', el).innerHTML = `<p class="muted" style="padding:14px">${esc(err.message)}</p>`;
      return;
    }
    if (seq !== searchSeq) return;
    updates = d.items;
    const pending = updates.filter((u) => u.status === 'update');
    const unknown = updates.filter((u) => u.status === 'unknown').length;
    updateCount(pending.length);
    $('#up-when', el).textContent = `Checked ${fmtTime(d.checkedAt)} for ${d.target}${unknown ? ` · ${unknown} could not be matched to a project` : ''}`;
    $('#up-all', el).innerHTML = pending.length
      ? `<button type="button" class="btn btn-sm btn-accent" id="up-all-btn">${icon('download')}Update all (${pending.length})</button>`
      : updates.length && !unknown
        ? '<span class="pill ok"><span class="dot ok"></span>Everything is up to date</span>'
        : '';
    $('#up-list', el).innerHTML = updates.length
      ? `<table class="table"><thead><tr><th>${esc(what()[0].toUpperCase() + what().slice(1))}</th><th>Installed</th><th>Status</th><th>On</th><th></th></tr></thead><tbody>${updates
          .map(
            (u, i) => `<tr>
            <td><div class="row" style="gap:10px;flex-wrap:nowrap">${
              u.icon ? `<img class="addon-ico sm" src="${esc(u.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="addon-ico sm empty">${icon('puzzle')}</span>`
            }<div style="min-width:0"><div class="row" style="gap:6px"><strong>${esc(u.title)}</strong>${u.source ? `<span class="tag">${esc(SOURCE_LABEL[u.source] || u.source)}</span>` : ''}${
              u.datapack ? '<span class="tag">datapack</span>' : ''
            }</div><div class="mono faint small ellipsis">${esc(u.name)}</div></div></div></td>
            <td class="mono small">${esc(u.version || '—')}</td>
            <td>${statusCell(u)}${u.note && u.status !== 'unknown' ? `<div class="faint small">${esc(u.note)}</div>` : ''}</td>
            <td><label class="switch" title="${u.enabled ? 'Disable' : 'Enable'}"><input type="checkbox" data-toggle="${esc(u.path)}" ${u.enabled ? 'checked' : ''}><span class="track"></span></label></td>
            <td class="actions">${
              !u.action
                ? ''
                : u.switchTo
                  ? `<button type="button" class="btn btn-sm btn-accent" data-update="${i}" title="Replace ${esc(u.version)} with ${esc(u.latest)}">${icon('download')}Switch to ${esc(u.switchTo)}</button>`
                  : `<button type="button" class="btn btn-sm btn-accent" data-update="${i}" title="Update ${esc(u.version)} to ${esc(u.latest)}">${icon('download')}Update</button>`
            }${u.page ? `<a class="icon-btn" href="${esc(u.page)}" target="_blank" rel="noopener" title="Open the project page">${icon('external')}</a>` : ''}<button class="icon-btn danger" data-del="${esc(
              u.path,
            )}" data-name="${esc(u.title)}" title="Delete">${icon('trash')}</button></td></tr>`,
          )
          .join('')}</tbody></table>`
      : `<div class="empty-state"><p class="muted">Nothing installed yet. Add something from ${esc(info.sources.filter((s) => s !== 'link').map((s) => SOURCE_LABEL[s]).join(', '))}.</p></div>`;
  }

  /** Update one item from the last check. Resolves when done. */
  function runUpdate(u, btn, refresh = true) {
    if (u.action?.essentialsx !== undefined) return install({ modules: [u.action.essentialsx], channel: u.action.channel }, btn, 'essentialsx', { refresh });
    if (u.action?.geysermc) return install({ projects: [u.action.geysermc] }, btn, 'geysermc', { refresh });
    return install({ url: u.action.url, replace: u.path }, btn, 'install', { refresh });
  }

  // ---- Modrinth and Hangar: search
  const hitCard = (h) => `
    <article class="card addon-hit">
      ${h.icon ? `<img class="addon-ico" src="${esc(h.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="addon-ico empty">${icon('puzzle')}</span>`}
      <div class="body">
        <div class="row" style="gap:6px"><a class="ttl" href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a>${
          h.installed ? `<span class="tag">Installed ${esc(h.installed)}</span>` : ''
        }</div>
        <div class="faint small">by ${esc(h.author)} · ${fmtCount(h.downloads)} downloads</div>
        <p class="desc">${esc(h.description)}</p>
      </div>
      <button class="btn btn-sm ${h.installed ? '' : 'btn-accent'}" data-install="${esc(h.url)}">${icon(h.installed ? 'restart' : 'download')}${h.installed ? 'Update' : 'Install'}</button>
    </article>`;

  async function runSearch(q) {
    const seq = ++searchSeq;
    const hits = () => (seq === searchSeq ? $('#a-hits', el) : null);
    if (!hits()) return;
    hits().innerHTML = '<p class="muted row"><span class="spin"></span>Searching...</p>';
    try {
      const list = await api('GET', `/api/servers/${ctx.id}/addons/search?source=${source}&q=${enc(q)}&version=${enc(versionPick)}`);
      if (!hits()) return;
      hits().innerHTML = list.length
        ? list.map(hitCard).join('')
        : `<p class="muted">Nothing found${q ? ` for "${esc(q)}"` : ''} that runs on ${esc(target())}.</p>`;
    } catch (err) {
      if (hits()) hits().innerHTML = `<p class="muted">${esc(err.message)}</p>`;
    }
  }

  function searchPane() {
    const name = SOURCE_LABEL[source];
    sub(
      source === 'hangar'
        ? `Search <a href="https://hangar.papermc.io" target="_blank" rel="noopener">Hangar</a>, PaperMC's plugin site. Only plugins that run on <strong>${esc(
            target(),
          )}</strong> are shown. Downloads are checked and required dependencies are installed too.`
        : `Search <a href="https://modrinth.com" target="_blank" rel="noopener">Modrinth</a> for ${what()}s that run on <strong>${esc(
            target(),
          )}</strong>. WebbMC picks the right build, checks the download and installs required dependencies${
            info.kind === 'datapacks' ? ` into <span class="mono">${esc(info.dir)}</span>` : ''
          }.`,
    );
    const p = pane(`
      <form class="input-group" id="a-search">
        <input class="input" name="q" placeholder="Search ${name}, or paste a ${name} link" autocomplete="off" spellcheck="false" aria-label="Search ${name}">
        <button class="btn" type="submit" style="height:40px">${icon('search')}Search</button>
      </form>
      <div class="addon-grid" id="a-hits"></div>`);
    const form = $('#a-search', p);
    const input = form.elements.q;
    form.onsubmit = (e) => {
      e.preventDefault();
      clearTimeout(searchTimer);
      const v = input.value.trim();
      if (/^https?:\/\//i.test(v)) return install({ url: v }, $('button', form));
      runSearch(v);
    };
    input.oninput = () => {
      clearTimeout(searchTimer);
      const v = input.value.trim();
      if (!/^https?:\/\//i.test(v)) searchTimer = setTimeout(() => runSearch(v), 350);
    };
    runSearch('');
  }

  // ---- EssentialsX: modules from the latest stable release or dev build
  async function essxPane() {
    const channel = pref.get('essxChannel', 'stable') === 'dev' ? 'dev' : 'stable';
    sub(
      `The newest <a href="https://essentialsx.net/downloads" target="_blank" rel="noopener">EssentialsX</a> builds, from the same place as essentialsx.net/downloads. Dev builds are newer and often needed right after a Minecraft update. Updating replaces the old jars.`,
    );
    const p = pane(`
      <div class="row" style="margin-bottom:12px">
        <div class="seg" id="ex-ch" role="group" aria-label="Build"><button type="button" data-ch="stable">Stable</button><button type="button" data-ch="dev">Dev build</button></div>
        <span class="faint small" id="ex-ver"></span><span class="spacer"></span><span id="ex-all"></span>
      </div>
      <div class="card table-wrap" id="ex-list"><p class="muted row" style="padding:14px"><span class="spin"></span>Loading EssentialsX builds...</p></div>`);
    $$('#ex-ch [data-ch]', p).forEach((b) => {
      b.classList.toggle('active', b.dataset.ch === channel);
      b.onclick = () => {
        pref.set('essxChannel', b.dataset.ch);
        essxPane();
      };
    });
    const seq = ++searchSeq;
    let d;
    try {
      d = await api('GET', `/api/servers/${ctx.id}/addons/essentialsx?channel=${channel}`);
    } catch (err) {
      if (seq === searchSeq) $('#ex-list', el).innerHTML = `<p class="muted" style="padding:14px">${esc(err.message)}</p>`;
      return;
    }
    if (seq !== searchSeq) return;
    $('#ex-ver', el).innerHTML = `Latest: <strong class="mono">${esc(d.version)}</strong>${d.published ? ` · ${fmtDate(d.published)}` : ''} · <a href="${esc(
      d.page,
    )}" target="_blank" rel="noopener">${channel === 'dev' ? 'build page' : 'release notes'}</a>`;
    const installed = d.modules.filter((m) => m.installed);
    const outdated = installed.filter((m) => !m.upToDate);
    $('#ex-all', el).innerHTML = outdated.length
      ? `<button class="btn btn-sm btn-accent" data-essx="${esc(outdated.map((m) => m.id).join(','))}">${icon('restart')}Update all (${outdated.length})</button>`
      : installed.length
        ? '<span class="pill ok"><span class="dot ok"></span>Up to date</span>'
        : `<button class="btn btn-sm btn-accent" data-essx=",Chat,Spawn">${icon('download')}Install core, Chat and Spawn</button>`;
    $('#ex-list', el).innerHTML = `<table class="table"><tbody>${d.modules
      .map((m) => {
        const have = m.installed;
        const state = !have
          ? ''
          : `<span class="tag ${m.upToDate ? '' : 'warn'}">${m.upToDate ? 'Up to date' : `Installed ${esc(have.version)}`}</span>${have.enabled ? '' : '<span class="tag">disabled</span>'}`;
        const btn = have
          ? `<button class="btn btn-sm ${m.upToDate ? '' : 'btn-accent'}" data-essx="${esc(m.id)}" title="${
              m.upToDate ? 'Already the latest. Downloads it again.' : `Update ${esc(have.version)} to ${esc(d.version)}`
            }">${icon('restart')}Update</button>`
          : `<button class="btn btn-sm" data-essx="${esc(m.id)}">${icon('download')}Install</button>`;
        return `<tr><td><div class="row" style="gap:8px"><strong>${esc(m.name)}</strong>${state}</div><div class="faint small">${esc(m.desc)}</div></td>
          <td class="num">${m.size ? fmtBytes(m.size) : ''}</td><td class="actions">${btn}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  }

  // ---- GeyserMC: Geyser, Floodgate and MCXboxBroadcast, from GeyserMC's own downloads
  const GEYSER_PLATFORM = { spigot: 'Paper and Spigot', velocity: 'Velocity', bungeecord: 'BungeeCord', fabric: 'Fabric', neoforge: 'NeoForge' };
  async function geyserPane() {
    sub(
      `<a href="https://geysermc.org" target="_blank" rel="noopener">GeyserMC</a> lets Bedrock Edition players (phones, consoles, Windows) join. Geyser and Floodgate come from geysermc.org's own downloads, MCXboxBroadcast from its GitHub releases, and every file is checked against its published checksum. Updating replaces the old jar.`,
    );
    pane(`
      <div class="row" style="margin-bottom:12px"><span class="faint small" id="gm-plat"></span><span class="spacer"></span><span id="gm-all"></span></div>
      <div class="card table-wrap" id="gm-list"><p class="muted row" style="padding:14px"><span class="spin"></span>Loading GeyserMC builds...</p></div>`);
    const seq = ++searchSeq;
    let d;
    try {
      d = await api('GET', `/api/servers/${ctx.id}/addons/geysermc`);
    } catch (err) {
      if (seq === searchSeq) $('#gm-list', el).innerHTML = `<p class="muted" style="padding:14px">${esc(err.message)}</p>`;
      return;
    }
    if (seq !== searchSeq) return;
    $('#gm-plat', el).textContent = `Builds for ${GEYSER_PLATFORM[d.platform] || d.platform}`;
    const outdated = d.projects.filter((p) => p.installed && p.available && !p.upToDate);
    $('#gm-all', el).innerHTML = outdated.length
      ? `<button class="btn btn-sm btn-accent" data-geyser="${esc(outdated.map((p) => p.id).join(','))}">${icon('restart')}Update all (${outdated.length})</button>`
      : d.projects.some((p) => p.installed)
        ? '<span class="pill ok"><span class="dot ok"></span>Up to date</span>'
        : `<button class="btn btn-sm btn-accent" data-geyser="geyser,floodgate">${icon('download')}Install Geyser and Floodgate</button>`;
    $('#gm-list', el).innerHTML = `<table class="table"><tbody>${d.projects
      .map((p) => {
        const have = p.installed;
        const state = !have
          ? ''
          : `<span class="tag ${p.upToDate ? '' : 'warn'}">${p.upToDate ? 'Up to date' : `Installed ${esc(have.build || 'an older build')}`}</span>${have.enabled ? '' : '<span class="tag">disabled</span>'}`;
        const btn = !p.available
          ? `<span class="faint small">${esc(p.error || 'No build for this kind of server')}</span>`
          : have
            ? `<button class="btn btn-sm ${p.upToDate ? '' : 'btn-accent'}" data-geyser="${esc(p.id)}" title="${
                p.upToDate ? 'Already the latest. Downloads it again.' : `Update to ${esc(p.latest.label)}`
              }">${icon('restart')}Update</button>`
            : `<button class="btn btn-sm" data-geyser="${esc(p.id)}">${icon('download')}Install</button>`;
        const ico = p.icon ? `<img class="addon-ico" src="${esc(p.icon)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span class="addon-ico empty">${icon('puzzle')}</span>`;
        return `<tr><td><div class="row" style="gap:12px;flex-wrap:nowrap;align-items:flex-start">${ico}<div style="min-width:0">
            <div class="row" style="gap:8px"><a href="${esc(p.page)}" target="_blank" rel="noopener"><strong>${esc(p.name)}</strong></a>${state}</div>
            <div class="faint small">${esc(p.desc)}${p.requires && !have ? ' Installs Geyser too when it is missing.' : ''}</div>
            ${p.latest ? `<div class="faint small">Latest: <span class="mono">${esc(p.latest.label)}</span>${p.latest.published ? ` · ${fmtDate(p.latest.published)}` : ''}</div>` : ''}
          </div></div></td><td class="actions">${btn}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  }

  // ---- GitHub: latest release of a repository
  const assetRows = (repoUrl, assets, suggested, installed) =>
    `<ul class="asset-list">${assets
      .map((a) => {
        const best = a.name === suggested || assets.length === 1;
        return `<li><span class="mono small nm">${esc(a.name)}</span>${a.name === suggested && assets.length > 1 ? '<span class="tag">best match</span>' : ''}
          <span class="spacer"></span><span class="faint small nowrap">${fmtBytes(a.size)}</span>
          <button class="btn btn-sm ${best ? 'btn-accent' : ''}" data-gh-url="${esc(repoUrl)}" data-gh-asset="${esc(a.name)}">${icon(installed ? 'restart' : 'download')}${
            installed ? 'Update' : 'Install'
          }</button></li>`;
      })
      .join('')}</ul>`;

  async function lookup(repo) {
    if (!repo) return;
    pref.set('ghRepo', repo);
    const seq = ++searchSeq;
    const box = () => (seq === searchSeq ? $('#gh-rel', el) : null);
    box().innerHTML = '<p class="muted row"><span class="spin"></span>Looking up the latest release...</p>';
    try {
      const r = await api('GET', `/api/servers/${ctx.id}/addons/github?repo=${enc(repo)}`);
      if (!box()) return;
      box().innerHTML = `
        <div class="card gh-release">
          <div class="row"><strong>${esc(r.repo)}</strong><span class="tag">${esc(r.tag)}</span>${r.prerelease ? '<span class="tag warn">pre-release</span>' : ''}${
            r.installed ? `<span class="faint small">Installed: ${esc(r.installed.version)}</span>` : ''
          }<span class="spacer"></span><span class="faint small">${fmtDate(Date.parse(r.published))}</span>
            <a class="icon-btn" href="${esc(r.htmlUrl)}" target="_blank" rel="noopener" title="Open on GitHub">${icon('external')}</a></div>
          ${r.name && r.name !== r.tag ? `<div class="muted small">${esc(r.name)}</div>` : ''}
          ${r.assets.length ? assetRows(r.url, r.assets, r.suggested, r.installed) : `<p class="muted small">This release has no ${fileKind()} file to install.</p>`}
        </div>`;
    } catch (err) {
      if (box()) box().innerHTML = notice(esc(err.message), 'warn');
    }
  }

  function githubPane() {
    sub(
      `Install the newest release of a ${what()} published on GitHub. Enter the repository (for example <span class="mono">MilkBowl/Vault</span>), then pick the ${fileKind()} file. Downloads are verified when GitHub lists a checksum.`,
    );
    const p = pane(`
      <form class="input-group" id="gh-form">
        <input class="input mono" name="repo" placeholder="https://github.com/owner/repo" value="${esc(pref.get('ghRepo', ''))}" autocomplete="off" spellcheck="false" aria-label="GitHub repository">
        <button class="btn" type="submit" style="height:40px">${icon('search')}Look up</button>
      </form>
      <div id="gh-rel" style="margin-top:14px"></div>`);
    const form = $('#gh-form', p);
    form.onsubmit = (e) => {
      e.preventDefault();
      lookup(form.elements.repo.value.trim());
    };
    if (form.elements.repo.value) lookup(form.elements.repo.value.trim());
  }

  // ---- any link
  function linkPane() {
    sub(`Paste a Modrinth, Hangar or GitHub project link, or a direct download link to a ${fileKind()} file.`);
    const p = pane(`
      <form class="input-group" id="ln-form">
        <input class="input mono" name="url" placeholder="https://modrinth.com/plugin/luckperms" autocomplete="off" spellcheck="false" aria-label="Link">
        <button class="btn btn-accent" type="submit" style="height:40px">${icon('download')}Install</button>
      </form>`);
    const form = $('#ln-form', p);
    form.onsubmit = (e) => {
      e.preventDefault();
      const v = form.elements.url.value.trim();
      if (v) install({ url: v }, $('button', form));
    };
  }

  const PANES = { installed: () => installedPane(), modrinth: searchPane, hangar: searchPane, essentialsx: essxPane, geysermc: geyserPane, github: githubPane, link: linkPane };
  const REFRESH = {
    installed: () => installedPane(),
    modrinth: () => runSearch($('#a-search', el)?.elements.q.value.trim() || ''),
    hangar: () => runSearch($('#a-search', el)?.elements.q.value.trim() || ''),
    essentialsx: essxPane,
    geysermc: geyserPane,
    github: () => lookup(pref.get('ghRepo', '')),
    link: () => {},
  };

  function showResult(r) {
    $('#a-result', el).innerHTML = `
      <ul class="steps" style="margin-top:14px;list-style:none;padding:0">
        ${r.results
          .map(
            (x) =>
              `<li><span style="color:var(--accent)">&#10003;</span> <strong>${esc(x.title)}</strong> ${esc(x.version || '')} ${
                x.dependency ? '<span class="tag">dependency</span> ' : ''
              }<span class="faint">${esc(x.status)}</span></li>`,
          )
          .join('')}
      </ul>
      ${r.warnings.map((w) => `<div style="height:10px"></div>${notice(esc(w), 'warn')}`).join('')}`;
  }

  async function install(body, btn, endpoint = 'install', { refresh = true } = {}) {
    const label = btn?.innerHTML;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spin"></span>Installing...';
    }
    $('#a-result', el).innerHTML = '';
    // Install the build for the version that was searched for, not only the server's own.
    if (endpoint === 'install' && VERSIONED.includes(source) && versionPick) body = { ...body, version: versionPick };
    try {
      const r = await api('POST', `/api/servers/${ctx.id}/addons/${endpoint}`, body);
      if (r.choose) {
        $('#a-result', el).innerHTML = `<div class="card gh-release" style="margin-top:14px">
          <div><strong>${esc(r.choose.repo)} ${esc(r.choose.tag)}</strong> has several files. Pick the one for ${esc(target())}:</div>
          ${assetRows(body.url, r.choose.assets, null, false)}</div>`;
        return;
      }
      showResult(r);
      if (r.results.some((x) => x.status !== 'already installed')) changed = true;
      const main = r.results.find((x) => !x.dependency) || r.results[0];
      toast(main ? `${main.title} ${main.status}` : 'Done', 'ok');
      await loadList();
      if (refresh) REFRESH[source]?.();
    } catch (err) {
      toast(err.message, 'bad');
      $('#a-result', el).innerHTML = `<div style="height:14px"></div>${notice(esc(err.message), 'warn')}`;
    } finally {
      if (btn?.isConnected) {
        btn.disabled = false;
        btn.innerHTML = label;
      }
    }
  }

  el.addEventListener('change', async (e) => {
    const t = e.target.closest('[data-toggle]');
    if (!t) return;
    try {
      await api('POST', `/api/servers/${ctx.id}/addons/toggle`, { path: t.dataset.toggle });
      changed = true;
      await loadList();
      if (source === 'installed') installedPane();
    } catch (err) {
      toast(err.message, 'bad');
      t.checked = !t.checked;
    }
  });
  el.addEventListener('click', async (e) => {
    const src = e.target.closest('[data-src]');
    if (src) return setSource(src.dataset.src);
    if (e.target.closest('#up-check')) return installedPane(true);
    const upd = e.target.closest('[data-update]');
    if (upd) return runUpdate(updates[Number(upd.dataset.update)], upd);
    const all = e.target.closest('#up-all-btn');
    if (all) {
      const pending = updates.filter((u) => u.status === 'update' && u.action);
      all.disabled = true;
      let done = 0;
      // One at a time: each install rewrites the folder's install record.
      for (const u of pending) {
        all.innerHTML = `<span class="spin"></span>Updating ${++done} of ${pending.length}...`;
        await runUpdate(u, null, false); // the list is checked again once, at the end
      }
      toast(`Updated ${pending.length} ${what()}${pending.length === 1 ? '' : 's'}`, 'ok');
      return installedPane();
    }
    const ins = e.target.closest('[data-install]');
    if (ins) return install({ url: ins.dataset.install }, ins);
    const ex = e.target.closest('[data-essx]');
    if (ex) return install({ modules: ex.dataset.essx.split(','), channel: pref.get('essxChannel', 'stable') }, ex, 'essentialsx');
    const gm = e.target.closest('[data-geyser]');
    if (gm) return install({ projects: gm.dataset.geyser.split(',') }, gm, 'geysermc');
    const gh = e.target.closest('[data-gh-asset]');
    if (gh) return install({ url: gh.dataset.ghUrl, asset: gh.dataset.ghAsset }, gh);
    const d = e.target.closest('[data-del]');
    if (!d) return;
    if (!(await confirmBox(`Delete ${d.dataset.name}?`, 'The file is removed from the server folder.', { danger: true, confirmText: 'Delete' }))) return;
    try {
      await api('DELETE', `/api/servers/${ctx.id}/files?path=${enc(d.dataset.del)}`);
      changed = true;
      toast('Deleted', 'ok');
      await loadList();
      REFRESH[source]?.();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  loadList().then(() => {
    if (!info) return;
    $('#a-head', el).textContent = `Add ${what()}s`;
    $('#a-src', el).innerHTML = info.sources.map((s) => `<button type="button" data-src="${s}" role="tab">${SOURCE_LABEL[s]}</button>`).join('');
    const saved = pref.get('addonSource', 'modrinth');
    setSource(info.sources.includes(saved) || saved === 'installed' ? saved : info.sources[0]);
    fillVersionPicker();
  });
  $('#a-ver', el).onchange = (e) => {
    versionPick = e.target.value;
    const q = $('#a-search', el)?.elements.q.value || '';
    PANES[source]();
    if ($('#a-search', el)) {
      $('#a-search', el).elements.q.value = q;
      runSearch(q.trim());
    }
  };
  // Plugins added or removed outside this page (Files tab, SSH, another admin) show up without a reload. Only the
  // local folder is read; the update check against Modrinth and the others runs again only when files changed.
  let relooking = false;
  const relook = async () => {
    if (relooking || document.hidden || !info || $('.modal-backdrop')) return;
    relooking = true;
    try {
      const next = await api('GET', `/api/servers/${ctx.id}/addons`);
      const files = (d) => JSON.stringify([d.addons, d.datapacks]);
      if (files(next) === files(info)) return;
      await loadList(next);
      if (source === 'installed') installedPane();
    } catch {
      /* try again next time */
    } finally {
      relooking = false;
    }
  };
  const timer = setInterval(relook, 8000);
  return {
    update: restartHint,
    destroy: () => {
      clearTimeout(searchTimer);
      clearInterval(timer);
    },
  };
}

// ---------------------------------------------------------------- files tab

const BINARY_EXT = /\.(jar|zip|gz|tgz|tar|7z|rar|dat|dat_old|mca|mcr|nbt|png|jpe?g|gif|webp|ico|db|sqlite|lock|exe|dll|so|class|ogg|mp3|wav)$/i;

function uploadFile(id, path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/servers/${id}/files/upload?path=${enc(path)}`);
    xhr.setRequestHeader('X-WebMC', '1');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status < 300) return resolve();
      let msg = `Upload failed (HTTP ${xhr.status})`;
      try {
        msg = JSON.parse(xhr.responseText).error || msg;
      } catch {
        /* not JSON */
      }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('Upload failed: connection lost'));
    xhr.send(file);
  });
}

function FilesTab(el, ctx) {
  el.innerHTML = `<div id="f-main"></div><div class="card hidden" id="f-uploads" style="margin-top:12px"><div class="progress-list" style="border:0"></div></div>`;
  const main = $('#f-main', el);
  const uploadsCard = $('#f-uploads', el);
  let cwd = pref.get(`cwd:${ctx.id}`, '');
  let entries = [];
  let editor = null;
  const dlUrl = (p) => `/api/servers/${ctx.id}/files/download?path=${enc(p)}`;

  async function load() {
    try {
      entries = await api('GET', `/api/servers/${ctx.id}/files?path=${enc(cwd)}`);
    } catch (err) {
      if (cwd) {
        cwd = '';
        return load();
      }
      toast(err.message, 'bad');
      entries = [];
    }
    pref.set(`cwd:${ctx.id}`, cwd);
    renderList();
  }

  function crumbs() {
    const parts = cwd ? cwd.split('/') : [];
    let acc = '';
    return [`<a href="#" data-cd="">${esc(ctx.srv.name)}</a>`]
      .concat(
        parts.map((p) => {
          acc = joinPath(acc, p);
          return `<span class="sep">/</span><a href="#" data-cd="${esc(acc)}">${esc(p)}</a>`;
        }),
      )
      .join('');
  }

  function renderList() {
    editor = null;
    main.innerHTML = `
      <div class="card drop-hint" id="f-card">
        <div class="console-bar">
          <div class="crumbs">${crumbs()}</div>
          <span class="spacer"></span>
          <button class="btn btn-sm" data-act="newfile">${icon('newFile')}New file</button>
          <button class="btn btn-sm" data-act="newdir">${icon('newFolder')}New folder</button>
          <button class="btn btn-sm" data-act="fetch">${icon('link')}From link</button>
          <label class="btn btn-sm btn-magenta">${icon('upload')}Upload<input type="file" multiple hidden id="f-up"></label>
          <button class="icon-btn" data-act="refresh" title="Refresh">${icon('restart')}</button>
        </div>
        <div class="table-wrap"><table class="table">
          <thead><tr><th>Name</th><th class="num">Size</th><th class="num">Modified</th><th></th></tr></thead>
          <tbody>
            ${cwd ? `<tr><td colspan="4"><button class="file-name is-dir" data-act="up">${icon('back')}<span>Up one level</span></button></td></tr>` : ''}
            ${entries
              .map(
                (f, i) => `
              <tr>
                <td><button class="file-name ${f.dir ? 'is-dir' : ''}" data-open="${i}">${icon(f.dir ? 'folder' : 'file')}<span>${esc(f.name)}</span></button></td>
                <td class="num">${f.dir ? '' : fmtBytes(f.size)}</td>
                <td class="num">${fmtDate(f.mtime)}</td>
                <td class="actions">
                  ${f.dir ? '' : `<a class="icon-btn" href="${dlUrl(joinPath(cwd, f.name))}" title="Download">${icon('download')}</a>`}
                  <button class="icon-btn" data-rename="${i}" title="Rename">${icon('edit')}</button>
                  <button class="icon-btn danger" data-del="${i}" title="Delete">${icon('trash')}</button>
                </td>
              </tr>`,
              )
              .join('')}
            ${entries.length ? '' : '<tr><td colspan="4" class="muted" style="padding:28px 14px;text-align:center">This folder is empty. Drop files here to upload them.</td></tr>'}
          </tbody>
        </table></div>
      </div>
      <p class="faint small" style="margin-top:10px">Drag files onto the list to upload them into this folder. Edit text files (configs, logs, JSON) by clicking them.</p>`;
    $('#f-up', main).onchange = (e) => {
      uploadAll([...e.target.files]);
      e.target.value = '';
    };
    const card = $('#f-card', main);
    card.ondragover = (e) => {
      e.preventDefault();
      card.classList.add('dragging');
    };
    card.ondragleave = (e) => !card.contains(e.relatedTarget) && card.classList.remove('dragging');
    card.ondrop = (e) => {
      e.preventDefault();
      card.classList.remove('dragging');
      uploadAll([...e.dataTransfer.files]);
    };
  }

  async function uploadAll(list) {
    if (!list.length) return;
    uploadsCard.classList.remove('hidden');
    const box = $('.progress-list', uploadsCard);
    const dir = cwd;
    await Promise.all(
      list.map(async (file) => {
        const row = document.createElement('div');
        row.className = 'item';
        row.innerHTML = `<div class="row"><span class="mono">${esc(file.name)}</span><span class="spacer"></span><span class="faint" data-p>0%</span></div><div class="bar lime"><i style="width:0"></i></div>`;
        box.append(row);
        try {
          await uploadFile(ctx.id, joinPath(dir, file.name), file, (p) => {
            $('[data-p]', row).textContent = `${Math.round(p * 100)}%`;
            $('i', row).style.width = `${p * 100}%`;
          });
          $('[data-p]', row).textContent = 'Done';
        } catch (err) {
          $('[data-p]', row).textContent = err.message;
          $('[data-p]', row).style.color = 'var(--danger)';
          toast(`${file.name}: ${err.message}`, 'bad');
        }
        setTimeout(() => row.remove(), 4000);
      }),
    );
    setTimeout(() => !$('.progress-list', uploadsCard).childElementCount && uploadsCard.classList.add('hidden'), 4200);
    toast(`Uploaded ${list.length} file${list.length > 1 ? 's' : ''}`, 'ok');
    if (cwd === dir && !editor) load();
  }

  async function openFile(path) {
    if (BINARY_EXT.test(path)) {
      location.href = dlUrl(path);
      return;
    }
    let content;
    try {
      content = (await api('GET', `/api/servers/${ctx.id}/files/content?path=${enc(path)}`)).content;
    } catch (err) {
      if (/binary|larger/i.test(err.message)) {
        if (await confirmBox('This file cannot be edited here', err.message, { confirmText: 'Download' })) location.href = dlUrl(path);
      } else toast(err.message, 'bad');
      return;
    }
    let saved = content;
    main.innerHTML = `
      <div class="card">
        <div class="console-bar">
          <button class="btn btn-sm btn-ghost" data-act="close">${icon('back')}Back</button>
          <span class="mono small" style="overflow-wrap:anywhere">${esc(path)}</span>
          <span class="faint small" id="e-state"></span>
          <span class="spacer"></span>
          <a class="btn btn-sm btn-ghost" href="${dlUrl(path)}">${icon('download')}Download</a>
          <button class="btn btn-sm btn-accent" data-act="save">${icon('save')}Save</button>
        </div>
        <textarea class="editor" id="e-text" spellcheck="false" wrap="off"></textarea>
      </div>
      <p class="faint small" style="margin-top:10px">Ctrl+S saves. Most config changes need a server restart to apply.</p>`;
    const ta = $('#e-text', main);
    const status = $('#e-state', main);
    ta.value = content;
    const dirty = () => ta.value !== saved;
    const mark = () => (status.textContent = dirty() ? 'Unsaved changes' : '');
    async function save() {
      try {
        await api('PUT', `/api/servers/${ctx.id}/files/content?path=${enc(path)}`, ta.value, { raw: true });
        saved = ta.value;
        mark();
        toast(`Saved ${path.split('/').pop()}`, 'ok');
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
    ta.oninput = mark;
    ta.onkeydown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
        mark();
      }
    };
    editor = { save, dirty };
    ta.focus();
  }

  main.addEventListener('click', async (e) => {
    const t = e.target;
    const cd = t.closest('[data-cd]');
    if (cd) {
      e.preventDefault();
      cwd = cd.dataset.cd;
      return load();
    }
    const open = t.closest('[data-open]');
    if (open) {
      const f = entries[open.dataset.open];
      if (f.dir) {
        cwd = joinPath(cwd, f.name);
        return load();
      }
      return openFile(joinPath(cwd, f.name));
    }
    const ren = t.closest('[data-rename]');
    if (ren) {
      const f = entries[ren.dataset.rename];
      const name = await promptBox(`Rename ${f.name}`, 'New name', f.name, { confirmText: 'Rename' });
      if (!name || name === f.name) return;
      try {
        await api('POST', `/api/servers/${ctx.id}/files/rename`, { from: joinPath(cwd, f.name), to: joinPath(cwd, name) });
        toast('Renamed', 'ok');
        load();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }
    const del = t.closest('[data-del]');
    if (del) {
      const f = entries[del.dataset.del];
      const ok = await confirmBox(`Delete ${f.name}?`, f.dir ? 'This deletes the folder and everything inside it. It cannot be undone.' : 'This cannot be undone.', {
        danger: true,
        confirmText: 'Delete',
      });
      if (!ok) return;
      try {
        await api('DELETE', `/api/servers/${ctx.id}/files?path=${enc(joinPath(cwd, f.name))}`);
        toast(`Deleted ${f.name}`, 'ok');
        load();
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }
    const act = t.closest('[data-act]')?.dataset.act;
    if (act === 'up') {
      cwd = parentPath(cwd);
      load();
    } else if (act === 'refresh') load();
    else if (act === 'fetch') {
      const url = await promptBox('Download from a link', `Link to a file. It is saved in /${cwd || ''}`, '', { confirmText: 'Download' });
      if (!url) return;
      toast('Downloading...', 'info');
      try {
        const r = await api('POST', `/api/servers/${ctx.id}/files/fetch`, { url, path: cwd });
        toast(`Saved ${r.file} (${fmtBytes(r.size)})`, 'ok');
        load();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
    else if (act === 'newdir' || act === 'newfile') {
      const name = await promptBox(act === 'newdir' ? 'New folder' : 'New file', 'Name', '', { confirmText: 'Create' });
      if (!name) return;
      try {
        if (act === 'newdir') await api('POST', `/api/servers/${ctx.id}/files/mkdir`, { path: joinPath(cwd, name) });
        else await api('PUT', `/api/servers/${ctx.id}/files/content?path=${enc(joinPath(cwd, name))}`, '', { raw: true });
        await load();
        if (act === 'newfile') openFile(joinPath(cwd, name));
      } catch (err) {
        toast(err.message, 'bad');
      }
    } else if (act === 'save') editor?.save();
    else if (act === 'close') {
      if (editor?.dirty() && !(await confirmBox('Discard changes?', 'You have unsaved changes in this file.', { danger: true, confirmText: 'Discard' }))) return;
      load();
    }
  });

  load();
  // The folder changes while you look at it (the server writes logs and worlds, files are copied in over SSH or
  // uploaded by someone else), so look again every few seconds. Not while a file is open, a dialog is up, or
  // files are being dragged in; and only redraw when something changed.
  let looking = false;
  const relook = async () => {
    if (editor || looking || document.hidden || $('.modal-backdrop') || !$('#f-card', main) || $('#f-card.dragging', main)) return;
    looking = true;
    const at = cwd;
    try {
      const next = await api('GET', `/api/servers/${ctx.id}/files?path=${enc(at)}`);
      if (editor || at !== cwd || $('.modal-backdrop') || JSON.stringify(next) === JSON.stringify(entries)) return;
      const y = scrollY;
      entries = next;
      renderList();
      scrollTo(0, y);
    } catch {
      /* the next try, or the Refresh button, will tell */
    } finally {
      looking = false;
    }
  };
  const timer = setInterval(relook, 4000);
  return { destroy: () => clearInterval(timer) };
}

// ---------------------------------------------------------------- properties tab: server list look + server.properties

const PROP_HINTS = {
  motd: 'Message shown in the multiplayer server list (easier with the MOTD editor above)',
  'server-port': 'Port players connect to',
  'max-players': 'How many players can be online at once',
  gamemode: 'Default game mode for new players',
  difficulty: 'World difficulty',
  hardcore: 'Players are banned/spectators after death',
  pvp: 'Allow players to fight each other',
  'online-mode': 'Verify accounts with Mojang. Turn off only behind a proxy or for LAN',
  'white-list': 'Only whitelisted players can join',
  'enforce-whitelist': 'Kick players who are not on the whitelist when it reloads',
  'view-distance': 'Chunks sent to each player (3 to 32)',
  'simulation-distance': 'Chunks around players that tick (3 to 32)',
  'spawn-protection': 'Radius around spawn only operators can build in',
  'level-name': 'World folder name',
  'level-seed': 'World seed (only used when a new world is generated)',
  'level-type': 'World generator for new worlds',
  'allow-flight': 'Do not kick players who fly (needed for some mods)',
  'enable-command-block': 'Allow command blocks to run',
  'server-ip': 'Leave blank to listen on every network interface',
  'allow-nether': 'Allow players to travel to the Nether',
  'spawn-monsters': 'Spawn hostile mobs',
  'force-gamemode': 'Force the default game mode every time players join',
  'max-world-size': 'World border radius in blocks',
  'enable-rcon': 'Remote console protocol',
  'enable-query': 'GameSpy4 query protocol',
  'resource-pack': 'URL of a server resource pack',
  'require-resource-pack': 'Kick players who decline the resource pack',
  'generate-structures': 'Generate villages, temples and other structures',
};
const PROP_SELECT = {
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
  'level-type': ['minecraft:normal', 'minecraft:flat', 'minecraft:large_biomes', 'minecraft:amplified', 'minecraft:single_biome_surface'],
};
const FEATURED_PROPS = [
  'motd', 'server-port', 'max-players', 'gamemode', 'difficulty', 'hardcore', 'pvp', 'online-mode', 'white-list',
  'view-distance', 'simulation-distance', 'spawn-protection', 'level-name', 'level-seed', 'allow-flight', 'enable-command-block',
];

// ---- MOTD helpers. The editor uses & codes and &#rrggbb hex colors for every server type.
const MC_COLOR_NAMES = {
  0: 'Black', 1: 'Dark blue', 2: 'Dark green', 3: 'Dark aqua', 4: 'Dark red', 5: 'Dark purple', 6: 'Gold', 7: 'Gray',
  8: 'Dark gray', 9: 'Blue', a: 'Green', b: 'Aqua', c: 'Red', d: 'Light purple', e: 'Yellow', f: 'White',
};
// Width of each character in Minecraft's font, in pixels with the 1px gap. Most are 6. Bold adds 1.
const MC_WIDTH = { ' ': 4, '!': 2, '"': 5, "'": 3, '(': 5, ')': 5, '*': 5, ',': 2, '.': 2, ':': 2, ';': 2, '<': 5, '>': 5, '@': 7, I: 4, '[': 4, ']': 4, '`': 3, f: 5, i: 2, k: 5, l: 3, t: 4, '{': 5, '|': 2, '}': 5, '~': 7 };
const MOTD_WIDTH = 270; // the multiplayer list cuts MOTD lines at about this width
const CODE_RE = /&#([0-9a-f]{6})|&([0-9a-fk-or])/gi;
const stripCodes = (s) => s.replace(CODE_RE, '');

function motdPixels(line) {
  let w = 0;
  let bold = false;
  const re = /&#[0-9a-f]{6}|&([0-9a-fk-or])|([\s\S])/gi;
  let m;
  while ((m = re.exec(line))) {
    if (m[2] !== undefined) w += (MC_WIDTH[m[2]] ?? 6) + (bold ? 1 : 0);
    else if (m[1] === undefined) bold = false; // a hex color ends bold
    else if (m[1].toLowerCase() === 'l') bold = true;
    else if (/[0-9a-fr]/i.test(m[1])) bold = false;
  }
  return w;
}
function nearestMcCode(hex) {
  const rgb = (h) => [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  const [r, g, b] = rgb(hex);
  return Object.entries(MC_HEX).reduce((best, [c, h]) => {
    const [r2, g2, b2] = rgb(h.slice(1));
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    return d < best.d ? { c, d } : best;
  }, { c: 'f', d: Infinity }).c;
}
/** & syntax to § codes for the preview, as this server type will show it. */
const ampToSection = (text, hex) =>
  text.replace(/&#([0-9a-f]{6})/gi, (_, h) => (hex ? `§x${[...h].map((d) => `§${d}`).join('')}` : `§${nearestMcCode(h)}`)).replace(/&([0-9a-fk-or])/gi, '§$1');
/** The codes that recreate the style in effect at the end of `text`. */
function styleAt(text) {
  let color = '&r';
  const fmts = new Set();
  let m;
  const re = new RegExp(CODE_RE.source, 'gi');
  while ((m = re.exec(text))) {
    if (m[1]) {
      color = `&#${m[1].toLowerCase()}`;
      fmts.clear();
    } else {
      const c = m[2].toLowerCase();
      if (c === 'r' || /[0-9a-f]/.test(c)) {
        color = `&${c}`;
        fmts.clear();
      } else fmts.add(c);
    }
  }
  return color + [...fmts].map((c) => `&${c}`).join('');
}
function lerpColor(stops, t) {
  if (stops.length === 1) return stops[0];
  const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
  const local = t * (stops.length - 1) - seg;
  const rgb = (h) => [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  const [a, b] = [rgb(stops[seg]), rgb(stops[seg + 1])];
  return a.map((v, i) => Math.round(v + (b[i] - v) * local).toString(16).padStart(2, '0')).join('');
}
/** One hex color per character, fading through `stops`. Codes already in the text are dropped. */
function gradientText(text, stops, bold) {
  const chars = [...stripCodes(text)];
  const visible = chars.filter((c) => c.trim()).length;
  let i = 0;
  return chars
    .map((ch) => {
      if (!ch.trim()) return ch;
      const t = visible > 1 ? i++ / (visible - 1) : 0;
      return `&#${lerpColor(stops, t)}${bold ? '&l' : ''}${ch}`;
    })
    .join('');
}
function centerLine(line) {
  const body = line.replace(/^\s+/, '');
  const pad = Math.max(0, Math.floor((MOTD_WIDTH - motdPixels(body)) / 2 / (MC_WIDTH[' '] || 4)));
  return ' '.repeat(pad) + body;
}
const MOTD_TEMPLATES = [
  { id: 'classic', name: 'Classic', make: (n) => [`&6&l${n}`, '&7Survival &8| &aJoin now!'] },
  { id: 'centered', name: 'Centered', make: (n) => [centerLine(`&b&l${n}`), centerLine('&fWelcome, come on in!')] },
  { id: 'gradient', name: 'Gradient title', hex: true, make: (n) => [gradientText(n, ['ff5f6d', 'ffc371'], true), '&7A friendly Minecraft server'] },
  { id: 'neon', name: 'Neon', hex: true, make: (n) => [centerLine(gradientText(n, ['39ff14', '09add3', 'c99bff'], true)), centerLine('&#c99bffNew season &8• &#39ff14Online now')] },
  { id: 'plain', name: 'Plain', make: (n) => [n, ''] },
];

function PropertiesTab(el, ctx) {
  const s = ctx.srv;
  el.innerHTML = `
    <div class="stack">
      <section class="card panel-card look-card" id="look">
        <div class="row" style="gap:10px"><h2>Server list look</h2><span class="spacer"></span><span class="faint small" id="m-where"></span></div>
        <p class="sub" style="margin-top:4px">How your server appears in Minecraft's multiplayer list. Both changes show in game after a restart.</p>
        <div id="look-preview" class="look-preview"></div>
        <div class="look-grid">
          <div class="look-col" id="ss-icon">
            <h3>Icon</h3>
            <div class="icon-editor">
              <div class="icon-col"><span class="lbl">Current</span><div class="icon-current" id="ic-current"></div></div>
              <div class="icon-col grow">
                <span class="lbl">New icon</span>
                <label class="icon-drop" id="ic-drop" tabindex="0"><input type="file" accept="image/*" hidden id="ic-file">${icon('image')}<strong>Choose a picture</strong><span class="faint small">or drop or paste one here: PNG, JPG, GIF, WebP, SVG...</span></label>
                <div class="icon-new hidden" id="ic-new">
                  <canvas width="64" height="64" id="ic-canvas" class="icon-big" aria-label="New icon preview"></canvas>
                  <div class="stack" style="gap:10px;align-content:start">
                    <div class="seg" id="ic-fit" role="group" aria-label="How to fit the picture"><button type="button" data-fit="cover">Crop to fill</button><button type="button" data-fit="contain">Fit inside</button></div>
                    <div class="seg" id="ic-smooth" role="group" aria-label="Scaling"><button type="button" data-smooth="1">Smooth</button><button type="button" data-smooth="0">Pixel art</button></div>
                    <div class="row"><button type="button" class="btn btn-accent btn-sm" id="ic-save">${icon('save')}Save icon</button><button type="button" class="btn btn-ghost btn-sm" id="ic-cancel">Cancel</button></div>
                  </div>
                </div>
              </div>
            </div>
            <p class="hint">Cropped or fitted to 64x64 and saved as <span class="mono">server-icon.png</span>.</p>
          </div>
          <div class="look-col" id="motd-ed"><h3>MOTD</h3><p class="muted">Loading...</p></div>
        </div>
      </section>
      <div id="props"><div class="card panel-card"><p class="muted">Loading...</p></div></div>
    </div>`;

  // ---------------------------------------------------------------- shared live preview
  let iconSrc = null;
  let motdInfo = null;
  let lines = ['', ''];
  const previewHtml = () =>
    mcEntry({
      icon: iconSrc,
      name: ctx.srv.name,
      motdHtml: mcHtml(ampToSection(lines.filter((l, i) => i === 0 || l).join('\n'), motdInfo?.hex)),
      online: true,
      players: ctx.srv.playerCount || 0,
      max: ctx.srv.maxPlayers || 20,
      latency: 30,
    }).replace('class="mc-entry"', 'class="mc-entry exact"');
  const renderPreview = () => ($('#look-preview', el).innerHTML = previewHtml());
  // Obfuscated (&k) text flickers like in game.
  const obf = setInterval(() => {
    for (const span of $$('#look-preview .mc-obf', el)) {
      span.dataset.len ||= String([...span.textContent].length);
      span.textContent = Array.from({ length: Number(span.dataset.len) }, () => String.fromCharCode(33 + Math.floor(Math.random() * 94))).join('');
    }
  }, 90);

  // ---------------------------------------------------------------- icon: resized in the browser, so any picture works
  let picked = null;
  let fit = 'cover';
  let smooth = true;
  let shownIcon;
  const iconUrl = (srv) => (srv.icon ? `/api/servers/${srv.id}/icon?v=${srv.icon}` : null);
  function showCurrent() {
    const srv = ctx.srv;
    if (shownIcon === srv.icon) return;
    shownIcon = srv.icon;
    $('#ic-current', el).innerHTML = srv.icon
      ? `<img class="icon-big" src="${iconUrl(srv)}" alt="Current server icon"><button type="button" class="btn btn-sm btn-ghost" id="ic-remove">${icon('trash')}Remove</button>`
      : `<span class="icon-big empty">${icon('server')}</span><span class="faint small">No icon yet</span>`;
    if (!picked) {
      iconSrc = iconUrl(srv);
      renderPreview();
    }
  }
  const syncSegs = () => {
    $$('#ic-fit [data-fit]', el).forEach((b) => b.classList.toggle('active', b.dataset.fit === fit));
    $$('#ic-smooth [data-smooth]', el).forEach((b) => b.classList.toggle('active', (b.dataset.smooth === '1') === smooth));
  };
  function drawIcon() {
    const canvas = $('#ic-canvas', el);
    const g = canvas.getContext('2d');
    const w = picked.naturalWidth || 64;
    const h = picked.naturalHeight || 64;
    const scale = fit === 'cover' ? Math.max(64 / w, 64 / h) : Math.min(64 / w, 64 / h);
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    let src = picked;
    let sw = w;
    let sh = h;
    // Halve big pictures in steps first: one large jump down to 64px looks jagged in some browsers.
    while (smooth && sw / 2 >= dw && sh / 2 >= dh) {
      const step = document.createElement('canvas');
      step.width = Math.round(sw / 2);
      step.height = Math.round(sh / 2);
      const sg = step.getContext('2d');
      sg.imageSmoothingQuality = 'high';
      sg.drawImage(src, 0, 0, sw, sh, 0, 0, step.width, step.height);
      [src, sw, sh] = [step, step.width, step.height];
    }
    g.clearRect(0, 0, 64, 64);
    g.imageSmoothingEnabled = smooth;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, sw, sh, Math.round((64 - dw) / 2), Math.round((64 - dh) / 2), dw, dh);
    syncSegs();
    iconSrc = canvas.toDataURL('image/png');
    renderPreview();
  }
  function resetIcon() {
    picked = null;
    $('#ic-file', el).value = '';
    $('#ic-new', el).classList.add('hidden');
    $('#ic-drop', el).classList.remove('hidden');
    iconSrc = iconUrl(ctx.srv);
    renderPreview();
  }
  function loadPicture(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast('That file is not a picture', 'bad');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      picked = img;
      // Small pictures are usually pixel art, which should stay crisp.
      smooth = !((img.naturalWidth || 64) <= 128 && (img.naturalHeight || 64) <= 128);
      $('#ic-new', el).classList.remove('hidden');
      $('#ic-drop', el).classList.add('hidden');
      drawIcon();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      toast('Could not read that picture. Try a PNG, JPG, GIF or WebP.', 'bad');
    };
    img.src = url;
  }
  const drop = $('#ic-drop', el);
  $('#ic-file', el).onchange = (e) => loadPicture(e.target.files[0]);
  drop.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), $('#ic-file', el).click());
  drop.ondragover = (e) => {
    e.preventDefault();
    drop.classList.add('dragging');
  };
  drop.ondragleave = () => drop.classList.remove('dragging');
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove('dragging');
    loadPicture([...e.dataTransfer.files].find((f) => f.type.startsWith('image/')) || e.dataTransfer.files[0]);
  };
  const onPaste = (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    loadPicture(file);
    $('#ss-icon', el).scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  document.addEventListener('paste', onPaste);
  $('#ss-icon', el).addEventListener('click', async (e) => {
    const f = e.target.closest('[data-fit]');
    const sm = e.target.closest('[data-smooth]');
    if (f || sm) {
      if (f) fit = f.dataset.fit;
      if (sm) smooth = sm.dataset.smooth === '1';
      return drawIcon();
    }
    if (e.target.closest('#ic-cancel')) return resetIcon();
    if (e.target.closest('#ic-save')) {
      const btn = e.target.closest('#ic-save');
      btn.disabled = true;
      try {
        const blob = await new Promise((resolve) => $('#ic-canvas', el).toBlob(resolve, 'image/png'));
        await api('PUT', `/api/servers/${ctx.id}/icon`, blob, { raw: true });
        toast(ctx.srv.pid ? 'Icon saved. Restart the server to show it in Minecraft.' : 'Icon saved', 'ok');
        await poll();
        resetIcon();
        showCurrent();
      } catch (err) {
        toast(err.message, 'bad');
      } finally {
        btn.disabled = false;
      }
      return;
    }
    if (e.target.closest('#ic-remove')) {
      if (!(await confirmBox('Remove the server icon?', 'server-icon.png is deleted. Minecraft shows its default icon after the next restart.', { danger: true, confirmText: 'Remove' }))) return;
      try {
        await api('DELETE', `/api/servers/${ctx.id}/icon`);
        toast('Icon removed', 'ok');
        await poll();
        showCurrent();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
  });
  showCurrent();

  // ---------------------------------------------------------------- MOTD editor
  let saved = '';
  let focused = 0; // the line the toolbar acts on
  const kindLabel = { vanilla: 'Vanilla / Fabric', spigot: 'Paper / Spigot', velocity: 'Velocity', bungeecord: 'BungeeCord' };

  function renderMotd() {
    const m = motdInfo;
    $('#m-where', el).innerHTML = `${esc(kindLabel[m.kind] || m.kind)} · saved in <span class="mono">${esc(m.file)}</span> as ${esc(m.format)}`;
    $('#motd-ed', el).innerHTML = `
      <h3>MOTD</h3>
      <div class="motd-tools">
        <div class="swatches" role="group" aria-label="Colors">${Object.entries(MC_HEX)
          .map(([c, h]) => `<button type="button" class="swatch" data-code="${c}" style="background:${h}" title="${MC_COLOR_NAMES[c]} (&amp;${c})" aria-label="${MC_COLOR_NAMES[c]}"></button>`)
          .join('')}</div>
        <div class="row motd-row">
          <div class="seg fmt" role="group" aria-label="Formatting">
            <button type="button" data-code="l" title="Bold (&amp;l)"><b>B</b></button>
            <button type="button" data-code="o" title="Italic (&amp;o)"><i>I</i></button>
            <button type="button" data-code="n" title="Underline (&amp;n)"><u>U</u></button>
            <button type="button" data-code="m" title="Strikethrough (&amp;m)"><s>S</s></button>
            <button type="button" data-code="k" title="Obfuscated, flickering text (&amp;k)">?!</button>
            <button type="button" data-code="r" title="Reset to plain gray (&amp;r)">Reset</button>
          </div>
          <label class="hexpick ${m.hex ? '' : 'off'}" title="${m.hex ? 'Any color (&amp;#rrggbb)' : 'This server type shows only the 16 colors above'}"><input type="color" id="m-hex" value="#ff8800" ${m.hex ? '' : 'disabled'}><span>Hex</span></label>
          <button type="button" class="btn btn-sm" id="m-grad-toggle" ${m.hex ? '' : 'disabled title="This server type shows only the 16 standard colors"'}>Gradient</button>
          <button type="button" class="btn btn-sm" id="m-center" title="Pad the line with spaces so it sits in the middle">Center line</button>
          <select class="input input-sm" id="m-template" aria-label="Templates"><option value="">Templates...</option>${MOTD_TEMPLATES.filter((t) => m.hex || !t.hex)
            .map((t) => `<option value="${t.id}">${esc(t.name)}</option>`)
            .join('')}</select>
        </div>
        <div class="row motd-row hidden" id="m-grad">
          <span class="faint small">From</span><input type="color" id="m-g1" value="#ff5f6d"><span class="faint small">via</span><input type="color" id="m-g2" value="#ffc371"><span class="faint small">to</span><input type="color" id="m-g3" value="#c99bff">
          <label class="check"><input type="checkbox" id="m-g3on"> <span>3 colors</span></label>
          <label class="check"><input type="checkbox" id="m-gbold" checked> <span>Bold</span></label>
          <button type="button" class="btn btn-sm btn-accent" id="m-grad-apply">Apply</button>
          <span class="hint">Select text in a line first, or the whole line gets the gradient.</span>
        </div>
      </div>
      <div class="motd-lines">
        ${[0, 1]
          .map(
            (i) => `<div class="motd-line"><span class="lbl">Line ${i + 1}</span><input class="input mono" data-line="${i}" value="${esc(lines[i])}" spellcheck="false" autocomplete="off" maxlength="900"><span class="motd-meter" data-meter="${i}"></span></div>`,
          )
          .join('')}
      </div>
      <p class="hint">Type codes yourself if you like: <span class="mono">&amp;0</span>-<span class="mono">&amp;9</span> and <span class="mono">&amp;a</span>-<span class="mono">&amp;f</span> colors, <span class="mono">&amp;l</span> bold, <span class="mono">&amp;o</span> italic, <span class="mono">&amp;n</span> underline, <span class="mono">&amp;m</span> strikethrough, <span class="mono">&amp;k</span> obfuscated, <span class="mono">&amp;r</span> reset${
        m.hex ? ', <span class="mono">&amp;#rrggbb</span> any color' : ''
      }. A color code also ends bold and the other styles, like in Minecraft.</p>
      ${m.hex ? '' : notice('This server type can only show the 16 standard colors, so hex colors and gradients are saved as the nearest one. Paper, Purpur and Spigot (1.16+), Velocity and BungeeCord show any color.')}
      <details class="raw"><summary class="faint small">Stored value</summary><pre class="mono small" id="m-raw">${esc(m.raw)}</pre></details>
      <div class="form-actions"><button type="button" class="btn btn-ghost btn-sm" id="m-revert" disabled>Undo changes</button><button type="button" class="btn btn-accent btn-sm" id="m-save" disabled>${icon('save')}Save MOTD</button></div>`;
    syncMotd();
  }

  const inputs = () => $$('[data-line]', el);
  function syncMotd() {
    for (const [i, line] of lines.entries()) {
      const meter = $(`[data-meter="${i}"]`, el);
      if (!meter) continue;
      const w = motdPixels(line);
      meter.textContent = `${w} / ${MOTD_WIDTH} px`;
      meter.classList.toggle('over', w > MOTD_WIDTH);
      meter.title = w > MOTD_WIDTH ? 'Longer than the server list shows: the end is cut off in game' : 'Width in the server list (approximate)';
    }
    const dirty = lines.join('\n').replace(/\n$/, '') !== saved;
    if ($('#m-save', el)) {
      $('#m-save', el).disabled = !dirty;
      $('#m-revert', el).disabled = !dirty;
    }
    renderPreview();
  }
  const setLine = (i, value, caret) => {
    lines[i] = value;
    const input = inputs()[i];
    input.value = value;
    input.focus();
    if (caret != null) input.setSelectionRange(caret, caret);
    syncMotd();
  };

  /** Put `code` before the selection (or at the cursor) and restore the earlier style after the selection. */
  function applyCode(code) {
    const input = inputs()[focused];
    const v = input.value;
    const [a, b] = [input.selectionStart ?? v.length, input.selectionEnd ?? v.length];
    if (a === b) return setLine(focused, v.slice(0, a) + code + v.slice(a), a + code.length);
    const after = styleAt(v.slice(0, b));
    const next = v.slice(0, a) + code + v.slice(a, b) + after + v.slice(b);
    setLine(focused, next, a + code.length + (b - a) + after.length);
  }

  function wireMotd() {
    const ed = $('#motd-ed', el);
    ed.addEventListener('mousedown', (e) => {
      // Keep the cursor and selection in the line while clicking toolbar buttons.
      if (e.target.closest('.swatch, .fmt button, #m-center, #m-grad-apply')) e.preventDefault();
    });
    ed.addEventListener('focusin', (e) => {
      if (e.target.matches('[data-line]')) focused = Number(e.target.dataset.line);
    });
    ed.addEventListener('input', (e) => {
      if (!e.target.matches('[data-line]')) return;
      lines[Number(e.target.dataset.line)] = e.target.value.replace(/\n/g, '');
      syncMotd();
    });
    ed.addEventListener('click', async (e) => {
      const code = e.target.closest('[data-code]');
      if (code) return applyCode(`&${code.dataset.code}`);
      if (e.target.closest('#m-center')) return setLine(focused, centerLine(lines[focused]));
      if (e.target.closest('#m-grad-toggle')) return $('#m-grad', el).classList.toggle('hidden');
      if (e.target.closest('#m-grad-apply')) {
        const input = inputs()[focused];
        const v = input.value;
        let [a, b] = [input.selectionStart ?? 0, input.selectionEnd ?? 0];
        if (a === b) [a, b] = [0, v.length];
        const stops = [$('#m-g1', el).value, $('#m-g2', el).value, ...($('#m-g3on', el).checked ? [$('#m-g3', el).value] : [])].map((c) => c.slice(1));
        const g = gradientText(v.slice(a, b), stops, $('#m-gbold', el).checked);
        const after = b < v.length ? styleAt(v.slice(0, b)) : '';
        return setLine(focused, v.slice(0, a) + g + after + v.slice(b));
      }
      if (e.target.closest('#m-revert')) {
        lines = [...saved.split('\n'), ''].slice(0, 2);
        inputs().forEach((inp, i) => (inp.value = lines[i]));
        return syncMotd();
      }
      if (e.target.closest('#m-save')) {
        const btn = e.target.closest('#m-save');
        btn.disabled = true;
        try {
          motdInfo = await api('PUT', `/api/servers/${ctx.id}/motd`, { text: lines.join('\n').replace(/\n$/, '') });
          saved = motdInfo.text;
          $('#m-raw', el).textContent = motdInfo.raw;
          toast(ctx.srv.pid ? `MOTD saved to ${motdInfo.file}. Restart the server to show it.` : `MOTD saved to ${motdInfo.file}`, 'ok');
          if (props) loadProps(); // server.properties changed underneath the editor below
        } catch (err) {
          toast(err.message, 'bad');
        }
        syncMotd();
      }
    });
    ed.addEventListener('change', (e) => {
      if (e.target.id === 'm-hex') applyCode(`&${e.target.value.toLowerCase()}`); // the picker gives #rrggbb
      if (e.target.id === 'm-template' && e.target.value) {
        const t = MOTD_TEMPLATES.find((x) => x.id === e.target.value);
        lines = t.make(ctx.srv.name.slice(0, 40));
        inputs().forEach((inp, i) => (inp.value = lines[i]));
        e.target.value = '';
        syncMotd();
      }
    });
  }

  api('GET', `/api/servers/${ctx.id}/motd`)
    .then((m) => {
      motdInfo = m;
      saved = m.text;
      lines = [...m.text.split('\n'), ''].slice(0, 2);
      renderMotd();
      wireMotd();
    })
    .catch((err) => ($('#motd-ed', el).innerHTML = `<h3>MOTD</h3>${notice(esc(err.message), 'warn')}`));

  // ---------------------------------------------------------------- server.properties (or the proxy's config)
  let props = null;
  function input(key, value) {
    const k = esc(key);
    if (value === 'true' || value === 'false') return `<label class="switch"><input type="checkbox" data-key="${k}" ${value === 'true' ? 'checked' : ''}><span class="track"></span></label>`;
    if (PROP_SELECT[key]) {
      const opts = PROP_SELECT[key].includes(value) ? PROP_SELECT[key] : [value, ...PROP_SELECT[key]];
      return `<select class="input" data-key="${k}">${opts.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    }
    if (/^-?\d+$/.test(value) && !/seed/.test(key)) return `<input class="input" type="number" data-key="${k}" value="${esc(value)}">`;
    return `<input class="input ${/password|seed|ip|url|pack/.test(key) ? 'mono' : ''}" data-key="${k}" value="${esc(value)}" ${/password/.test(key) ? 'type="password"' : ''}>`;
  }
  const row = (key) =>
    `<div class="prop-row" data-row="${esc(key)}"><div class="key">${esc(key)}${PROP_HINTS[key] ? `<small>${esc(PROP_HINTS[key])}</small>` : ''}</div><div>${input(key, props[key])}</div></div>`;

  function renderProps(exists) {
    const box = $('#props', el);
    const keys = Object.keys(props);
    const featured = FEATURED_PROPS.filter((k) => k in props);
    const rest = keys.filter((k) => !FEATURED_PROPS.includes(k)).sort();
    box.innerHTML = `
      ${keys.length < 12 ? `${notice('Start the server once to generate the full list of properties. Values you set here are kept.')}<div style="height:16px"></div>` : ''}
      <div class="card panel-card">
        <div class="row" style="margin-bottom:6px">
          <h2 style="margin-right:6px">server.properties</h2>
          <input class="input" id="p-search" placeholder="Filter properties..." style="max-width:280px">
          <span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" id="p-add">${icon('plus')}Add property</button>
          <button class="btn btn-accent" id="p-save">${icon('save')}Save</button>
        </div>
        <p class="faint small" style="margin-bottom:8px">Changes apply the next time the server starts${ctx.srv.pid ? '. Restart it after saving' : ''}.</p>
        ${featured.length ? `<h3 style="margin-top:16px">Common</h3><div id="p-featured">${featured.map(row).join('')}</div>` : ''}
        ${rest.length ? `<h3 style="margin-top:22px">Everything else</h3><div id="p-rest">${rest.map(row).join('')}</div>` : '<div id="p-rest"></div>'}
        ${!exists && !keys.length ? '<p class="muted">No server.properties file yet.</p>' : ''}
      </div>`;
    $('#p-search', box).oninput = (e) => {
      const q = e.target.value.toLowerCase();
      $$('[data-row]', box).forEach((r) => r.classList.toggle('hidden', q && !r.dataset.row.includes(q)));
    };
    $('#p-save', box).onclick = saveProps;
    $('#p-add', box).onclick = async () => {
      const key = await promptBox('Add property', 'Property name (e.g. enable-rcon)', '', { confirmText: 'Add' });
      if (!key) return;
      if (key in props) return toast('That property already exists', 'bad');
      props[key] = '';
      $('#p-rest', box).insertAdjacentHTML('beforeend', row(key));
      $(`[data-key="${CSS.escape(key)}"]`, box).focus();
    };
  }

  async function saveProps() {
    const out = {};
    $$('#props [data-key]', el).forEach((inp) => (out[inp.dataset.key] = inp.type === 'checkbox' ? String(inp.checked) : inp.value));
    try {
      props = (await api('PUT', `/api/servers/${ctx.id}/properties`, { values: out })).values;
      toast(ctx.srv.pid ? 'Saved. Restart the server to apply.' : 'Saved server.properties', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  function renderProxyHelp() {
    const srv = ctx.srv;
    const velocity = srv.kind === 'velocity';
    const others = state.overview.servers.filter((x) => x.id !== srv.id && !x.proxy);
    $('#props', el).innerHTML = `
      <div class="card panel-card stack-sm">
        <h2>Proxy settings</h2>
        <p class="sub">${esc(TYPE_LABEL[srv.kind])} keeps its settings in <span class="mono">${esc(srv.configFile)}</span>. Edit it in the <a href="#/server/${srv.id}/files">Files</a> tab, then restart the proxy.</p>
        <h3>Add the servers players can reach</h3>
        ${
          velocity
            ? `<p class="sub">Under <span class="mono">[servers]</span>, give each server a name and address, and list where players start in <span class="mono">try</span>:</p>
               <pre class="code-block mono small">[servers]\nlobby = "127.0.0.1:25566"\nsurvival = "127.0.0.1:25567"\ntry = ["lobby"]</pre>`
            : `<p class="sub">Under <span class="mono">servers:</span>, add each server, and put the first one in the listener's <span class="mono">priorities</span>:</p>
               <pre class="code-block mono small">servers:\n  lobby:\n    address: 127.0.0.1:25566\n    motd: Lobby\n    restricted: false</pre>`
        }
        ${
          others.length
            ? `<div class="table-wrap"><table class="table"><thead><tr><th>Your servers on this machine</th><th>Address for the proxy</th></tr></thead><tbody>${others
                .map((x) => `<tr><td>${esc(x.name)} <span class="faint small">${esc(softwareLabel(x))}</span></td><td><span class="addr">127.0.0.1:${x.port}<button type="button" data-copy="127.0.0.1:${x.port}" title="Copy">${icon('copy')}</button></span></td></tr>`)
                .join('')}</tbody></table></div>`
            : ''
        }
        <h3>Keep player accounts and skins working</h3>
        <p class="sub">${
          velocity
            ? 'Set <span class="mono">player-info-forwarding-mode = "modern"</span> in velocity.toml. On each Paper server behind it, open <span class="mono">config/paper-global.yml</span> and under <span class="mono">proxies.velocity</span> set <span class="mono">enabled: true</span>, <span class="mono">online-mode: true</span> and <span class="mono">secret</span> to the text in this proxy\'s <span class="mono">forwarding.secret</span> file. Set <span class="mono">online-mode=false</span> in their server.properties.'
            : 'Set <span class="mono">ip_forward: true</span> in config.yml. On each Spigot or Paper server behind it, set <span class="mono">settings.bungeecord: true</span> in spigot.yml and <span class="mono">online-mode=false</span> in server.properties.'
        } Then make sure only the proxy is reachable from the internet: the servers behind it should not be.</p>
      </div>`;
  }

  function loadProps() {
    if (ctx.srv.proxy) return renderProxyHelp();
    api('GET', `/api/servers/${ctx.id}/properties`)
      .then((r) => {
        props = r.values;
        renderProps(r.exists);
      })
      .catch((err) => ($('#props', el).innerHTML = notice(esc(err.message), 'warn')));
  }
  loadProps();

  return {
    update: () => {
      showCurrent();
      if (motdInfo) renderPreview();
    },
    destroy: () => {
      clearInterval(obf);
      document.removeEventListener('paste', onPaste);
    },
  };
}

// ---------------------------------------------------------------- backups tab

const BACKUP_FORMATS = {
  'tar.gz': { label: '.tar.gz', desc: 'Compressed, the smallest. Opens with 7-Zip, tar or most archive tools.' },
  tar: { label: '.tar', desc: 'Not compressed: the fastest to make, but as big as the folder.' },
  zip: { label: '.zip', desc: 'Opens anywhere, including Windows and macOS without extra tools.' },
};

function BackupsTab(el, ctx) {
  const b = ctx.srv.backup || { keep: 10, exclude: [] };
  const format = b.format || 'tar.gz';
  el.innerHTML = `
    <div class="cols-2" style="align-items:start">
      <div class="card panel-card stack-sm">
        <h3>Create a backup</h3>
        <p class="sub">Archives the server folder, leaving out what you exclude below. If the server is online, auto-save is paused and the world is flushed to disk first, so the backup is consistent.</p>
        <div class="row"><button class="btn btn-accent" id="b-create">${icon('archive')}Back up now</button><span class="tag" id="b-fmt">${esc(BACKUP_FORMATS[format].label)}</span><span class="row muted small" id="b-busy"></span></div>
      </div>
      <form class="card panel-card form" id="b-settings">
        <div><h3>Backup settings</h3><p class="sub" style="margin:4px 0 0">Backups are kept on this machine. Old ones beyond the count are deleted automatically (0 keeps them all).</p></div>
        <div class="form-grid">
          <div class="field"><label for="b-keep">Backups to keep</label><input class="input" id="b-keep" name="keep" type="number" min="0" value="${b.keep}"></div>
          <div class="field"><label for="b-format">Format</label><select class="input" id="b-format" name="format">${Object.entries(BACKUP_FORMATS)
            .map(([k, f]) => `<option value="${k}" ${k === format ? 'selected' : ''}>${f.label}</option>`)
            .join('')}</select></div>
        </div>
        <p class="hint" id="b-format-hint">${esc(BACKUP_FORMATS[format].desc)}</p>
        <div class="form-actions"><button class="btn btn-sm" type="submit">${icon('save')}Save</button></div>
      </form>
    </div>
    <form class="card panel-card form section" id="b-exclude">
      <div class="row"><div><h3>Leave out of backups</h3><p class="sub" style="margin:4px 0 0">Tick folders you do not need to keep, such as logs, caches or map renders. Sizes are what each folder takes up now. Restoring a backup leaves these folders as they are.</p></div><span class="spacer"></span><span class="tag" id="b-ex-sum"></span></div>
      <div class="folder-tree" id="b-tree"><p class="muted">Measuring folders...</p></div>
      <div class="field"><label for="b-patterns">Other rules (optional)</label><textarea class="input mono" id="b-patterns" rows="3" placeholder="*.log&#10;cache&#10;plugins/dynmap/web/tiles"></textarea>
        <span class="hint">One per line. <span class="mono">*.log</span> matches files anywhere, a plain name like <span class="mono">cache</span> matches that folder or file at any depth, and a path with a slash like <span class="mono">plugins/dynmap/web</span> starts at the server folder. <span class="mono">session.lock</span> is always left out.</span></div>
      <div class="form-actions"><button class="btn btn-sm btn-accent" type="submit">${icon('save')}Save exclusions</button></div>
    </form>
    <section class="section">
      <div class="row" style="margin-bottom:14px"><h2>Backups</h2><span class="tag" id="b-count">0</span><span class="spacer"></span><span class="faint small">Schedule automatic backups in the Schedules tab.</span></div>
      <div class="card table-wrap" id="b-list"><p class="muted" style="padding:16px">Loading...</p></div>
    </section>`;

  let wasBusy = ctx.srv.busy;
  // Exclusions: "/path" entries that match a folder are shown as ticks, everything else as rules.
  const norm = (p) => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '/').replace(/\/+$/, '');
  let excluded = new Set();
  let folderList = [];

  function renderTree() {
    const known = new Set(folderList.flatMap((f) => [f.path, ...f.children.map((c) => c.path)]));
    const ticked = (p) => excluded.has(p);
    const item = (f, child) => {
      const parentOff = child && ticked(f.path.split('/')[0]);
      return `<label class="folder ${child ? 'child' : ''}"><input type="checkbox" data-folder="${esc(f.path)}" ${ticked(f.path) || parentOff ? 'checked' : ''} ${parentOff ? 'disabled' : ''}>
        ${icon('folder')}<span class="nm">${esc(f.name)}</span><span class="faint small">${fmtBytes(f.size)}</span></label>`;
    };
    $('#b-tree', el).innerHTML = folderList.length
      ? folderList
          .map(
            (f) => `<div class="folder-group">${item(f, false)}${
              f.children.length
                ? `<details ${f.children.some((c) => ticked(c.path)) ? 'open' : ''}><summary class="faint small">${f.children.length} folder${f.children.length === 1 ? '' : 's'} inside</summary>${f.children
                    .map((c) => item(c, true))
                    .join('')}</details>`
                : ''
            }</div>`,
          )
          .join('')
      : '<p class="muted">This server has no folders yet.</p>';
    const count = [...excluded].filter((p) => known.has(p)).length;
    const total = folderList.reduce((n, f) => n + (ticked(f.path) ? f.size : f.children.filter((c) => ticked(c.path)).reduce((m, c) => m + c.size, 0)), 0);
    $('#b-ex-sum', el).textContent = count ? `${count} folder${count === 1 ? '' : 's'} left out (${fmtBytes(total)})` : 'Nothing left out';
    return known;
  }

  function loadExclusions() {
    const known = new Set();
    api('GET', `/api/servers/${ctx.id}/backups/folders`)
      .then((list) => {
        folderList = list;
        list.forEach((f) => [f, ...f.children].forEach((x) => known.add(x.path)));
        const rules = [];
        excluded = new Set();
        for (const raw of ctx.srv.backup?.exclude || []) {
          const p = norm(raw);
          if (p.startsWith('/') && known.has(p.slice(1))) excluded.add(p.slice(1));
          else rules.push(raw);
        }
        $('#b-patterns', el).value = rules.join('\n');
        renderTree();
      })
      .catch((err) => ($('#b-tree', el).innerHTML = notice(esc(err.message), 'warn')));
  }

  async function load() {
    try {
      const list = await api('GET', `/api/servers/${ctx.id}/backups`);
      $('#b-count', el).textContent = list.length;
      $('#b-list', el).innerHTML = list.length
        ? `<table class="table"><thead><tr><th>Backup</th><th>Format</th><th class="num">Size</th><th class="num">Created</th><th></th></tr></thead><tbody>
            ${list
              .map(
                (x) => `<tr>
                <td><span class="file-name" style="cursor:default">${icon('archive')}<span class="mono small">${esc(x.name)}</span></span></td>
                <td><span class="tag">${esc(BACKUP_FORMATS[x.format]?.label || x.format)}</span></td>
                <td class="num">${fmtBytes(x.size)}</td>
                <td class="num">${fmtDate(x.mtime)}</td>
                <td class="actions">
                  <a class="icon-btn" href="/api/servers/${ctx.id}/backups/download?name=${enc(x.name)}" title="Download">${icon('download')}</a>
                  <button class="icon-btn" data-restore="${esc(x.name)}" title="Restore">${icon('restore')}</button>
                  <button class="icon-btn danger" data-delete="${esc(x.name)}" title="Delete">${icon('trash')}</button>
                </td></tr>`,
              )
              .join('')}</tbody></table>`
        : '<div class="empty-state"><p class="muted">No backups yet. Create one above or schedule them.</p></div>';
    } catch (err) {
      toast(err.message, 'bad');
    }
  }

  function sync() {
    const busy = ctx.srv.busy;
    $('#b-create', el).disabled = Boolean(busy);
    $('#b-busy', el).innerHTML = busy ? `<span class="spin"></span>${esc(busy)}...` : '';
    if (wasBusy && !busy) load();
    wasBusy = busy;
  }

  const saveBackup = (backup, message) =>
    api('PATCH', `/api/servers/${ctx.id}`, { backup })
      .then(async () => {
        toast(message, 'ok');
        await poll();
      })
      .catch((err) => toast(err.message, 'bad'));

  $('#b-create', el).onclick = async () => {
    try {
      await api('POST', `/api/servers/${ctx.id}/backups`);
      toast('Backup started. Progress shows in the console.', 'ok');
      wasBusy = 'Backing up';
      poll();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  $('#b-format', el).onchange = (e) => ($('#b-format-hint', el).textContent = BACKUP_FORMATS[e.target.value].desc);
  $('#b-settings', el).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    await saveBackup({ keep: f.keep.value, format: f.format.value }, 'Backup settings saved');
    $('#b-fmt', el).textContent = BACKUP_FORMATS[f.format.value].label;
  };
  $('#b-tree', el).addEventListener('change', (e) => {
    const box = e.target.closest('[data-folder]');
    if (!box) return;
    const p = box.dataset.folder;
    if (box.checked) {
      excluded.add(p);
      // A ticked folder covers everything in it.
      for (const x of [...excluded]) if (x.startsWith(`${p}/`)) excluded.delete(x);
    } else excluded.delete(p);
    renderTree();
  });
  $('#b-exclude', el).onsubmit = (e) => {
    e.preventDefault();
    const rules = $('#b-patterns', el).value.split('\n').map((x) => x.trim()).filter(Boolean);
    saveBackup({ exclude: [...[...excluded].map((p) => `/${p}`), ...rules] }, 'Exclusions saved. They apply to the next backup.');
  };

  $('#b-list', el).addEventListener('click', async (e) => {
    const r = e.target.closest('[data-restore]');
    const d = e.target.closest('[data-delete]');
    if (r) {
      if (ctx.srv.pid) return toast('Stop the server before restoring a backup', 'bad');
      const ok = await confirmBox(
        'Restore this backup?',
        `Everything in the server folder will be replaced with ${r.dataset.restore}. Anything changed since then is lost. Folders you leave out of backups are kept as they are. Consider making a fresh backup first.`,
        { danger: true, confirmText: 'Restore' },
      );
      if (!ok) return;
      try {
        await api('POST', `/api/servers/${ctx.id}/backups/restore`, { name: r.dataset.restore });
        toast('Restore started', 'ok');
        wasBusy = 'Restoring';
        poll();
      } catch (err) {
        toast(err.message, 'bad');
      }
    } else if (d) {
      if (!(await confirmBox('Delete this backup?', d.dataset.delete, { danger: true, confirmText: 'Delete' }))) return;
      try {
        await api('DELETE', `/api/servers/${ctx.id}/backups?name=${enc(d.dataset.delete)}`);
        toast('Backup deleted', 'ok');
        load();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
  });

  load();
  loadExclusions();
  sync();
  return { update: sync };
}

// ---------------------------------------------------------------- schedules tab

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ACTION_LABEL = { command: 'Run command', restart: 'Restart', start: 'Start', stop: 'Stop', backup: 'Back up' };

function triggerLabel(s) {
  if (s.type === 'interval') return s.every % 60 === 0 ? `Every ${s.every / 60 === 1 ? 'hour' : `${s.every / 60} hours`}` : `Every ${s.every} min`;
  const days = s.days?.length && s.days.length < 7 ? s.days.map((d) => DAYS[d]).join(', ') : 'every day';
  return `${s.time}, ${days}`;
}

function scheduleForm(s) {
  return `
    <div class="field"><label>Name</label><input class="input" name="name" value="${esc(s.name || '')}" placeholder="Nightly restart" autofocus></div>
    <div class="form-grid">
      <div class="field"><label>Action</label><select class="input" name="action">${Object.entries(ACTION_LABEL)
        .map(([k, v]) => `<option value="${k}" ${s.action === k ? 'selected' : ''}>${v}</option>`)
        .join('')}</select></div>
      <div class="field"><label>Trigger</label><select class="input" name="type"><option value="interval" ${s.type === 'interval' ? 'selected' : ''}>Repeat on an interval</option><option value="daily" ${
        s.type === 'daily' ? 'selected' : ''
      }>At a time of day</option></select></div>
    </div>
    <div class="field" data-show="command"><label>Command(s)</label><textarea class="input" name="command" rows="3" placeholder="say Restarting in 5 minutes!&#10;save-all">${esc(
      s.command || '',
    )}</textarea><span class="hint">One command per line, without a slash. Skipped if the server is offline.</span></div>
    <div class="field" data-show="interval"><label>Every (minutes)</label><input class="input" type="number" name="every" min="1" value="${s.every || 60}"></div>
    <div data-show="daily" class="form">
      <div class="field"><label>Time (panel time)</label><input class="input" type="time" name="time" value="${esc(s.time || '04:00')}"></div>
      <div class="field"><span class="lbl">Days</span><div class="row">${DAYS.map(
        (d, i) => `<label class="check"><input type="checkbox" name="day" value="${i}" ${!s.days?.length || s.days.includes(i) ? 'checked' : ''}>${d}</label>`,
      ).join('')}</div></div>
    </div>
    ${switchHtml('enabled', s.enabled !== false, 'Enabled')}`;
}

function wireScheduleForm(f) {
  const sync = () => {
    $$('[data-show]', f).forEach((el) => {
      const k = el.dataset.show;
      el.classList.toggle('hidden', k === 'command' ? f.elements.action.value !== 'command' : f.elements.type.value !== k);
    });
  };
  f.elements.action.onchange = sync;
  f.elements.type.onchange = sync;
  sync();
}

function readScheduleForm(f) {
  const e = f.elements;
  return {
    name: e.name.value,
    action: e.action.value,
    command: e.command.value,
    type: e.type.value,
    every: e.every.value,
    time: e.time.value,
    days: $$('input[name=day]:checked', f).map((x) => Number(x.value)),
    enabled: e.enabled.checked,
  };
}

function SchedulesTab(el, ctx) {
  el.innerHTML = `
    <div class="row" style="margin-bottom:14px"><h2>Schedules</h2><span class="tag" id="s-count">0</span><span class="spacer"></span><button class="btn btn-accent" id="s-new">${icon('plus')}New schedule</button></div>
    <div class="card table-wrap" id="s-list"></div>
    <p class="faint small" style="margin-top:10px" id="s-tz"></p>`;
  let list = [];
  api('GET', '/api/settings').then(({ info }) => ($('#s-tz', el).textContent = `Times use the panel machine's clock (${info.timezone}).`));

  async function load() {
    try {
      list = await api('GET', `/api/schedules?server=${enc(ctx.id)}`);
    } catch (err) {
      return toast(err.message, 'bad');
    }
    $('#s-count', el).textContent = list.length;
    $('#s-list', el).innerHTML = list.length
      ? `<table class="table"><thead><tr><th>Task</th><th>When</th><th class="num">Next run</th><th class="num">Last run</th><th>On</th><th></th></tr></thead><tbody>
        ${list
          .map(
            (s, i) => `<tr>
            <td><strong>${esc(s.name)}</strong><div class="faint small">${ACTION_LABEL[s.action]}${s.action === 'command' ? `: <span class="mono">${esc(s.command.split('\n')[0])}${s.command.includes('\n') ? '...' : ''}</span>` : ''}</div></td>
            <td class="nowrap">${esc(triggerLabel(s))}</td>
            <td class="num">${s.nextRun ? fmtAgo(s.nextRun) : '—'}</td>
            <td class="num">${fmtAgo(s.lastRun)}${s.lastResult && s.lastResult !== 'ok' ? `<div class="small" style="color:var(--warn)">${esc(s.lastResult)}</div>` : ''}</td>
            <td><label class="switch"><input type="checkbox" data-toggle="${i}" ${s.enabled ? 'checked' : ''}><span class="track"></span></label></td>
            <td class="actions">
              <button class="icon-btn" data-run="${i}" title="Run now">${icon('play')}</button>
              <button class="icon-btn" data-edit="${i}" title="Edit">${icon('edit')}</button>
              <button class="icon-btn danger" data-remove="${i}" title="Delete">${icon('trash')}</button>
            </td></tr>`,
          )
          .join('')}</tbody></table>`
      : `<div class="empty-state"><p class="muted">No schedules yet. Automate restarts, backups or announcements.</p></div>`;
  }

  function edit(existing) {
    const s = existing || { action: 'restart', type: 'daily', time: '04:00', every: 60, enabled: true };
    return modal({
      title: existing ? 'Edit schedule' : 'New schedule',
      confirmText: existing ? 'Save' : 'Create',
      wide: true,
      body: scheduleForm(s),
      onOpen: wireScheduleForm,
      onConfirm: async (f) => {
        const body = readScheduleForm(f);
        if (existing) await api('PATCH', `/api/schedules/${existing.id}`, body);
        else await api('POST', '/api/schedules', { ...body, serverId: ctx.id });
        return true;
      },
    }).then((ok) => ok && (toast('Schedule saved', 'ok'), load()));
  }

  $('#s-new', el).onclick = () => edit(null);
  $('#s-list', el).addEventListener('click', async (e) => {
    const t = e.target;
    const get = (attr) => list[t.closest(`[${attr}]`)?.getAttribute(attr)];
    if (t.closest('[data-edit]')) return edit(get('data-edit'));
    if (t.closest('[data-run]')) {
      const s = get('data-run');
      try {
        const { result } = await api('POST', `/api/schedules/${s.id}/run`);
        toast(result === 'ok' ? `Ran "${s.name}"` : `"${s.name}": ${result}`, result === 'ok' ? 'ok' : 'bad');
      } catch (err) {
        toast(err.message, 'bad');
      }
      return load();
    }
    if (t.closest('[data-remove]')) {
      const s = get('data-remove');
      if (!(await confirmBox(`Delete "${s.name}"?`, 'This schedule will stop running.', { danger: true, confirmText: 'Delete' }))) return;
      await api('DELETE', `/api/schedules/${s.id}`).catch((err) => toast(err.message, 'bad'));
      load();
    }
  });
  $('#s-list', el).addEventListener('change', async (e) => {
    const t = e.target.closest('[data-toggle]');
    if (!t) return;
    try {
      await api('PATCH', `/api/schedules/${list[t.dataset.toggle].id}`, { enabled: t.checked });
      load();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });

  load();
  const timer = setInterval(load, 15000);
  return { destroy: () => clearInterval(timer) };
}

// ---------------------------------------------------------------- server settings tab

/** Suggest the Java installs the panel knows about (the Docker image ships 17, 21 and 25). */
async function fillJavaList() {
  let list = $('#java-list');
  if (!list) {
    list = document.createElement('datalist');
    list.id = 'java-list';
    document.body.append(list);
  }
  try {
    const paths = await api('GET', '/api/java/list');
    list.innerHTML = paths.map((p) => `<option value="${esc(p)}">`).join('');
  } catch {
    /* suggestions are optional */
  }
}

const AIKAR_FLAGS =
  '-XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC ' +
  '-XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 ' +
  '-XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 ' +
  '-XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 ' +
  '-Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true';

function ServerSettingsTab(el, ctx) {
  const s = ctx.srv;
  el.innerHTML = `
    <div class="stack">
      <form class="card panel-card form" id="ss-form" novalidate>
        <div><h2>General</h2><p class="sub" style="margin:4px 0 0">Launch options. Changes apply on the next start.</p></div>
        <div class="form-grid">
          <div class="field"><label>Name</label><input class="input" name="name" value="${esc(s.name)}" maxlength="64"></div>
          <div class="field"><label>Server jar</label><input class="input mono" name="jar" value="${esc(s.jar)}"><span class="hint">Relative to the server folder.</span></div>
          ${
            me().admin
              ? `<div class="field"><label>Owner</label><input class="input" name="owner" list="user-list" value="${esc(s.owner || '')}" placeholder="Admins only" autocomplete="off" spellcheck="false"><span class="hint">The account (email or username) that manages this server. Empty means only admins.</span></div>`
              : ''
          }
          <div class="field"><label>Java executable</label>${
            me().admin
              ? `<input class="input mono" name="javaPath" value="${esc(s.javaPath)}" placeholder="Automatic" list="java-list">`
              : `<select class="input mono" name="javaPath"><option value="">Automatic</option>${
                  s.javaPath ? `<option value="${esc(s.javaPath)}" selected>${esc(s.javaPath)}</option>` : ''
                }</select>`
          }<span class="hint" id="ss-java">Checking Java...</span></div>
          ${ramField('maxRam', 'Maximum RAM', s.maxRam)}
          ${ramField('minRam', 'Starting RAM', s.minRam)}
          <div class="field"><label>Stop timeout (seconds)</label><input class="input" type="number" name="stopTimeout" min="10" value="${s.stopTimeout}"><span class="hint">Kill the process if it has not stopped by then.</span></div>
          <div class="field"><label>Address for players</label><input class="input mono" name="publicAddress" value="${esc(s.customAddress || '')}" placeholder="${esc(
            s.publicAddress || `Automatic (${location.hostname}:${s.port})`,
          )}"><span class="hint">Shown on the dashboard. Use it for a domain. Railway TCP proxy and playit.gg tunnel addresses are filled in automatically when this is empty.</span></div>
        </div>
        <div class="field"><div class="row"><label>Extra JVM arguments</label><span class="spacer"></span><button type="button" class="btn btn-sm btn-ghost" id="ss-aikar">Use Aikar's flags</button></div>
          <textarea class="input" name="jvmArgs" rows="3" placeholder="-XX:+UseG1GC">${esc(s.jvmArgs)}</textarea><span class="hint">Memory flags (-Xmx/-Xms) are added from the fields above.</span></div>
        <div class="field"><label>Server arguments</label><input class="input mono" name="serverArgs" value="${esc(s.serverArgs)}"><span class="hint">Passed after -jar. Keep <code>nogui</code> for most servers.</span></div>
        <div class="stack" style="gap:12px">
          ${switchHtml('autoStart', s.autoStart, 'Start this server when the panel starts')}
          ${switchHtml('autoRestart', s.autoRestart, 'Restart automatically after a crash (up to 3 times in 10 minutes)')}
          ${switchHtml('eula', s.eula, 'I accept the <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noopener">Minecraft EULA</a> (writes eula.txt on start)')}
        </div>
        <div class="form-actions"><button class="btn btn-accent" type="submit">${icon('save')}Save settings</button></div>
      </form>

      <form class="card panel-card form" id="ss-soft">
        <div><h2>Software</h2><p class="sub" style="margin:4px 0 0">Currently <strong>${esc(softwareLabel(s))}</strong>. Download a different version or software; this replaces server.jar. Make a backup first, since worlds cannot be downgraded.</p></div>
        <div class="form-grid">
          <div class="field"><label>Software</label><select class="input" name="type">${DOWNLOADABLE.map(
            (t) => `<option value="${t}" ${t === s.type ? 'selected' : ''}>${TYPE_LABEL[t]}</option>`,
          ).join('')}</select></div>
          <div class="field"><label>Version</label><select class="input" name="version"></select></div>
        </div>
        <div class="form-actions"><button class="btn btn-magenta" type="submit" id="ss-install">${icon('download')}Download and install</button></div>
      </form>

      ${
        s.access === 'shared'
          ? `<div class="card panel-card"><h2>Sharing</h2><p class="sub" style="margin:4px 0 0">${esc(s.owner || 'The admins')} shared this server with you. You can run it and change anything on it. Only the owner can delete it or choose who else has access.</p></div>`
          : `<form class="card panel-card form" id="ss-share" novalidate>
               <div><h2>Sharing</h2><p class="sub" style="margin:4px 0 0">Give other accounts access to this server. They can start and stop it and use every tab (console, files, plugins, backups, settings), but cannot delete it or change who it is shared with.</p></div>
               <div class="share-list" id="ss-share-list"></div>
               <div class="input-group"><input class="input" name="who" placeholder="Username${me().admin ? ' or email' : ''}" autocomplete="off" spellcheck="false"${me().admin ? ' list="user-list"' : ''}><button class="btn" type="submit">${icon('plus')}Share</button></div>
             </form>`
      }

      <div class="card panel-card">
        <h2>Location</h2>
        <dl class="kv" style="margin-top:12px"><dt>Server ID</dt><dd class="mono">${esc(s.id)}</dd><dt>Folder</dt><dd class="mono small">${esc(s.dir)}</dd><dt>Created</dt><dd>${fmtDate(s.createdAt)}</dd></dl>
      </div>

      ${
        s.access === 'shared'
          ? ''
          : `<div class="card panel-card danger-zone">
        <h2 style="color:var(--danger)">Delete server</h2>
        <p class="sub" style="margin:4px 0 14px">Removes it from the panel along with its schedules. You choose whether to delete the files too.</p>
        <button class="btn btn-danger" id="ss-delete">${icon('trash')}Delete server</button>
      </div>`
      }
    </div>`;

  const form = $('#ss-form', el);
  const soft = $('#ss-soft', el);
  wireRam(form);
  fillJavaList();
  if (form.elements.owner) fillUserList();
  // Non-admins choose from the Java installs the panel knows about.
  if (form.elements.javaPath.tagName === 'SELECT') {
    api('GET', '/api/java/list').then((paths) => {
      const sel = form.elements.javaPath;
      for (const p of paths) if (![...sel.options].some((o) => o.value === p)) sel.add(new Option(p, p, false, p === s.javaPath));
    });
  }
  // Automatic (empty) picks the Java the server's Minecraft version needs, and downloads it when it is missing.
  const checkJava = async () => {
    const value = form.elements.javaPath.value.trim();
    const hint = $('#ss-java', el);
    if (value) {
      const j = await api('GET', `/api/java?path=${enc(value)}`);
      hint.innerHTML = j.ok ? `Detected: <span class="mono">${esc(j.version)}</span>` : `<span style="color:var(--danger)">${esc(j.error)}</span>`;
      return;
    }
    const j = await api('GET', `/api/servers/${ctx.id}/java`);
    if (!j.need) {
      hint.innerHTML = j.ok
        ? `Could not tell which Java this server needs, so it uses the panel default: <span class="mono">${esc(j.version)}</span>`
        : `<span style="color:var(--danger)">Could not tell which Java this server needs, and the panel default does not work (${esc(j.error)}).</span>`;
    } else if (j.ok) {
      hint.innerHTML = `Needs Java ${j.need}. Using <span class="mono">${esc(j.version)}</span>`;
    } else {
      hint.innerHTML = j.willDownload
        ? `Needs Java ${j.need}. It is not installed, so it will be downloaded on the next start.`
        : `<span style="color:var(--danger)">Needs Java ${j.need}, which is not installed. Install it, or turn on Java downloads in Panel settings.</span>`;
    }
  };
  checkJava().catch(() => {});
  form.elements.javaPath.onchange = () => checkJava().catch(() => {});
  $('#ss-aikar', el).onclick = () => (form.elements.jvmArgs.value = AIKAR_FLAGS);

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    try {
      await api('PATCH', `/api/servers/${ctx.id}`, {
        name: f.name.value,
        jar: f.jar.value,
        javaPath: f.javaPath.value,
        maxRam: f.maxRam.value,
        minRam: f.minRam.value,
        stopTimeout: f.stopTimeout.value,
        publicAddress: f.publicAddress.value,
        jvmArgs: f.jvmArgs.value,
        serverArgs: f.serverArgs.value,
        autoStart: f.autoStart.checked,
        autoRestart: f.autoRestart.checked,
        eula: f.eula.checked,
        ...(f.owner ? { owner: f.owner.value.trim() } : {}),
      });
      toast('Settings saved', 'ok');
      poll();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const versionSel = soft.elements.version;
  const loadVersions = () =>
    fillVersions(versionSel, soft.elements.type.value).then(() => {
      if (soft.elements.type.value === s.type && [...versionSel.options].some((o) => o.value === s.version)) versionSel.value = s.version;
    });
  soft.elements.type.onchange = loadVersions;
  loadVersions();
  soft.onsubmit = async (e) => {
    e.preventDefault();
    const type = soft.elements.type.value;
    const version = versionSel.value;
    if (!version) return;
    const ok = await confirmBox(`Install ${TYPE_LABEL[type]} ${version}?`, 'server.jar will be replaced. Your worlds, plugins and configs stay in place.', { confirmText: 'Install' });
    if (!ok) return;
    try {
      await api('POST', `/api/servers/${ctx.id}/install`, { type, version });
      toast('Installing. Watch progress in the console.', 'ok');
      location.hash = `#/server/${ctx.id}/console`;
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const share = $('#ss-share', el);
  if (share) {
    let shared = [...(s.shared || [])];
    const renderShared = () => {
      $('#ss-share-list', el).innerHTML = shared.length
        ? shared
            .map(
              (id) => `<div class="share-row"><span class="me-pic">${esc(id[0].toUpperCase())}</span><span class="mono">${esc(id)}</span><span class="spacer"></span>
                <button type="button" class="icon-btn danger" data-unshare="${esc(id)}" title="Stop sharing with ${esc(id)}" aria-label="Stop sharing with ${esc(id)}">${icon('trash')}</button></div>`,
            )
            .join('')
        : `<p class="faint small" style="margin:0">Not shared. Only ${s.owner && s.owner !== me().id ? esc(s.owner) + ' and the admins' : me().admin && !s.owner ? 'the admins' : 'you and the admins'} can manage it.</p>`;
    };
    const save = async (next, msg) => {
      try {
        shared = (await api('PATCH', `/api/servers/${ctx.id}`, { shared: next })).shared || [];
        renderShared();
        toast(msg, 'ok');
        poll();
        return true;
      } catch (err) {
        toast(err.message, 'bad');
        return false;
      }
    };
    renderShared();
    if (me().admin) fillUserList();
    share.onsubmit = async (e) => {
      e.preventDefault();
      const who = share.elements.who.value.trim().toLowerCase();
      if (!who) return;
      if (shared.includes(who)) return toast(`Already shared with ${who}`, 'bad');
      if (await save([...shared, who], `Shared with ${who}`)) share.elements.who.value = '';
    };
    share.onclick = async (e) => {
      const btn = e.target.closest('[data-unshare]');
      if (!btn) return;
      const id = btn.dataset.unshare;
      if (await confirmBox(`Stop sharing with ${id}?`, `${id} will no longer see or manage this server.`, { confirmText: 'Stop sharing', danger: true })) {
        save(shared.filter((x) => x !== id), `Stopped sharing with ${id}`);
      }
    };
  }

  if ($('#ss-delete', el)) $('#ss-delete', el).onclick = async () => {
    if (ctx.srv.pid) return toast('Stop the server before deleting it', 'bad');
    const managed = !ctx.srv.type || ctx.srv.type !== 'import';
    const result = await modal({
      title: `Delete ${ctx.srv.name}?`,
      danger: true,
      confirmText: 'Delete server',
      body: `
        <p>This removes the server from WebbMC. Type its name to confirm.</p>
        <input class="input" name="confirm" placeholder="${esc(ctx.srv.name)}" autofocus autocomplete="off">
        ${
          managed
            ? '<label class="check"><input type="checkbox" name="files" checked> <span>Also delete the server folder (worlds, plugins, configs)</span></label>'
            : '<p class="faint small">This server was imported, so its folder is left untouched.</p>'
        }
        <label class="check"><input type="checkbox" name="backups"> <span>Also delete its backups</span></label>`,
      onConfirm: (f) => {
        if (f.elements.confirm.value.trim() !== ctx.srv.name) throw new Error('The name does not match');
        return { files: f.elements.files?.checked, backups: f.elements.backups.checked };
      },
    });
    if (!result) return;
    try {
      await api('DELETE', `/api/servers/${ctx.id}?files=${result.files ? 1 : 0}&backups=${result.backups ? 1 : 0}`);
      toast('Server deleted', 'ok');
      await poll();
      location.hash = '#/';
    } catch (err) {
      toast(err.message, 'bad');
    }
  };

  const sync = () => {
    $('#ss-install', el).disabled = Boolean(ctx.srv.pid || ctx.srv.busy);
  };
  sync();
  return { update: sync };
}

const TAB_VIEWS = {
  console: ConsoleTab,
  metrics: MetricsTab,
  players: PlayersTab,
  addons: AddonsTab,
  files: FilesTab,
  properties: PropertiesTab,
  backups: BackupsTab,
  schedules: SchedulesTab,
  settings: ServerSettingsTab,
};

// ================================================================ activity

function Activity(root) {
  root.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Log</div><h1>Activity</h1><p>Everything the panel and your servers have done recently.</p></div></div>
    <div class="card feed" id="act"></div>`;
  async function load() {
    try {
      const items = await api('GET', '/api/activity');
      const names = Object.fromEntries(state.overview.servers.map((s) => [s.id, s.name]));
      $('#act', root).innerHTML = items.length
        ? items
            .map(
              (a) => `
          <div class="item ${a.level}">
            <span class="faint small nowrap" title="${esc(fmtDate(a.t))}">${fmtAgo(a.t)}</span>
            <span class="nowrap" style="overflow:hidden;text-overflow:ellipsis">${
              names[a.serverId] ? `<a href="#/server/${a.serverId}">${esc(names[a.serverId])}</a>` : `<span class="faint">${a.serverId ? 'Deleted server' : 'Panel'}</span>`
            }</span>
            <span class="msg">${esc(a.message)}</span>
          </div>`,
            )
            .join('')
        : '<div class="empty-state"><p class="muted">Nothing has happened yet.</p></div>';
    } catch (err) {
      toast(err.message, 'bad');
    }
  }
  load();
  const timer = setInterval(load, 5000);
  return { destroy: () => clearInterval(timer) };
}

// ================================================================ server status checker

// Minecraft's own text colors, used for MOTDs (the console uses a softer palette).
const MC_HEX = {
  0: '#000000', 1: '#0000AA', 2: '#00AA00', 3: '#00AAAA', 4: '#AA0000', 5: '#AA00AA', 6: '#FFAA00', 7: '#AAAAAA',
  8: '#555555', 9: '#5555FF', a: '#55FF55', b: '#55FFFF', c: '#FF5555', d: '#FF55FF', e: '#FFFF55', f: '#FFFFFF',
};
const MC_NAMED = {
  black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3', dark_red: '4', dark_purple: '5', gold: '6', gray: '7',
  dark_gray: '8', blue: '9', green: 'a', aqua: 'b', red: 'c', light_purple: 'd', yellow: 'e', white: 'f',
};
const MC_FORMAT = { l: 'bold', o: 'italic', n: 'underlined', m: 'strikethrough', k: 'obfuscated' };

/** A chat component (JSON text) or a string with § codes, as colored HTML. */
function mcHtml(component) {
  let out = '';
  const span = (text, st) => {
    if (!text) return;
    const css = [];
    if (st.color) css.push(`color:${st.color}`);
    if (st.bold) css.push('font-weight:700');
    if (st.italic) css.push('font-style:italic');
    const deco = [st.underlined && 'underline', st.strikethrough && 'line-through'].filter(Boolean);
    if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
    out += `<span${st.obfuscated ? ' class="mc-obf"' : ''}${css.length ? ` style="${css.join(';')}"` : ''}>${esc(text)}</span>`;
  };
  const legacy = (text, base) => {
    let st = { ...base };
    const re = /§x((?:§[0-9a-f]){6})|§([0-9a-fk-or])/gi;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      span(text.slice(last, m.index), st);
      last = re.lastIndex;
      if (m[1]) st = { color: `#${m[1].replace(/§/g, '')}` };
      else {
        const c = m[2].toLowerCase();
        if (MC_HEX[c]) st = { color: MC_HEX[c] }; // a color code also clears bold, italic and so on
        else if (c === 'r') st = { ...base };
        else st = { ...st, [MC_FORMAT[c]]: true };
      }
    }
    span(text.slice(last), st);
  };
  const walk = (c, inherited) => {
    if (c == null) return;
    if (typeof c !== 'object') return legacy(String(c), inherited);
    if (Array.isArray(c)) return c.forEach((x) => walk(x, inherited));
    const st = { ...inherited };
    if (typeof c.color === 'string') {
      if (/^#[0-9a-f]{6}$/i.test(c.color)) st.color = c.color;
      else if (MC_NAMED[c.color]) st.color = MC_HEX[MC_NAMED[c.color]];
    }
    for (const k of Object.values(MC_FORMAT)) if (c[k] !== undefined) st[k] = Boolean(c[k]);
    legacy(String(c.text ?? c.translate ?? ''), st);
    if (Array.isArray(c.extra)) c.extra.forEach((x) => walk(x, st));
  };
  walk(component, { color: MC_HEX[7] });
  return out;
}

function pingBars(latency, online) {
  const n = !online ? 0 : latency == null || latency < 150 ? 5 : latency < 300 ? 4 : latency < 600 ? 3 : latency < 1000 ? 2 : 1;
  const label = online ? (latency != null ? `${latency} ms` : 'Online') : 'No connection';
  return `<span class="mc-bars ${online ? '' : 'off'}" title="${label}" role="img" aria-label="${label}">${[1, 2, 3, 4, 5]
    .map((i) => `<i class="${i <= n ? 'on' : ''}" style="height:${i * 2 + 2}px"></i>`)
    .join('')}</span>`;
}

/** One row of Minecraft's multiplayer server list. */
function mcEntry({ icon: src, name, motdHtml, online, players, max, latency }) {
  return `
    <div class="mc-entry">
      ${src ? `<img class="mc-icon" src="${esc(src)}" alt="" width="64" height="64">` : `<span class="mc-icon empty">${icon('server')}</span>`}
      <div class="mc-body">
        <div class="mc-top"><span class="mc-name">${esc(name)}</span><span class="mc-right">${
          online && players != null ? `<span class="mc-gray">${players}</span><span class="mc-dark">/</span><span class="mc-gray">${max}</span>` : ''
        }${pingBars(latency, online)}</span></div>
        <div class="mc-motd">${online === false ? `<span style="color:${MC_HEX[4]}">Can't connect to server</span>` : motdHtml}</div>
      </div>
    </div>`;
}

const yesNo = (v, yes = 'Yes', no = 'No') => (v == null ? '<span class="faint">Not reported</span>' : v ? yes : no);
const ms = (v) => (v == null ? '—' : `${v} ms`);

function StatusPage(root, args = []) {
  root.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Tools</div><h1>Server status</h1>
      <p>Check any Minecraft server: whether it is up, ping, players, version, MOTD, icon, DNS and SRV records, plugins and more.</p></div></div>
    <form class="card panel-card status-form" id="st-form" novalidate>
      <div class="seg" id="st-ed" role="group" aria-label="Edition"><button type="button" data-ed="java">Java</button><button type="button" data-ed="bedrock">Bedrock</button></div>
      <input class="input mono" name="address" placeholder="play.example.com" autocomplete="off" spellcheck="false" aria-label="Server address">
      <button class="btn btn-accent" type="submit">${icon('search')}Check</button>
    </form>
    <div id="st-result"></div>
    <section class="section">
      <div class="row" style="margin-bottom:14px"><h2>Favorites</h2><span class="tag" id="st-fav-count">0</span><span class="spacer"></span>
        <button class="btn btn-sm btn-ghost" id="st-fav-refresh">${icon('restart')}Refresh</button></div>
      <div class="fav-grid" id="st-favs"><p class="muted">Loading...</p></div>
    </section>`;

  const form = $('#st-form', root);
  let edition = pref.get('statusEdition', 'java') === 'bedrock' ? 'bedrock' : 'java';
  let favorites = [];
  let current = null; // the result on screen
  let seq = 0;
  const favKey = (address, ed) => `${ed}|${address}`;
  const isFav = (r) => favorites.some((f) => favKey(f.address, f.edition) === favKey(r.address, r.edition));
  const statusHash = (ed, address) => `#/status/${ed}/${enc(address)}`;

  function setEdition(ed) {
    edition = ed === 'bedrock' ? 'bedrock' : 'java';
    pref.set('statusEdition', edition);
    $$('#st-ed [data-ed]', root).forEach((b) => b.classList.toggle('active', b.dataset.ed === edition));
    form.elements.address.placeholder = edition === 'bedrock' ? 'play.example.com:19132' : 'play.example.com';
  }

  // Obfuscated (§k) text flickers like in game.
  const obf = setInterval(() => {
    for (const s of $$('.mc-obf', root)) {
      s.dataset.len ||= String(s.textContent.length);
      s.textContent = Array.from({ length: Number(s.dataset.len) }, () => String.fromCharCode(33 + Math.floor(Math.random() * 94))).join('');
    }
  }, 90);

  const kvRows = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

  function renderResult(r) {
    current = r;
    const online = r.online;
    const name = r.address;
    const players = r.players || { online: 0, max: 0, list: [], hover: [] };
    const q = r.query;
    const plugins = q?.plugins || [];
    const blocked = r.blocked;
    const tLine = [
      r.timings.srv != null && `SRV ${ms(r.timings.srv)}`,
      r.timings.lookup != null && `DNS ${ms(r.timings.lookup)}`,
      r.timings.connect != null && `connect ${ms(r.timings.connect)}`,
      r.timings.status != null && `status ${ms(r.timings.status)}`,
      `total ${ms(r.timings.total)}`,
    ]
      .filter(Boolean)
      .join(' · ');

    const connection = kvRows([
      ['Address', `<span class="mono">${esc(r.address)}</span>`],
      ['Edition', r.edition === 'bedrock' ? `Bedrock${r.bedrock?.edition ? ` (${esc(r.bedrock.edition)})` : ''}` : 'Java'],
      ['Connects to', `<span class="mono">${esc(r.srv ? r.srv.target : r.host)}:${r.port}</span>`],
      ['IP address', r.ip ? `<span class="mono">${esc(r.ip)}</span>` : '<span class="faint">Did not resolve</span>'],
      r.edition === 'java' && [
        'SRV record',
        r.srv
          ? `<span class="mono">_minecraft._tcp.${esc(r.host)}</span> → <span class="mono">${esc(r.srv.target)}:${r.srv.port}</span> <span class="faint small">(priority ${r.srv.priority}, weight ${r.srv.weight})</span>`
          : `<span class="faint">${/:\d+$/.test(r.address) ? 'Not used (a port was given)' : 'None'}</span>`,
      ],
      r.reverse && ['Reverse DNS', r.reverse.length ? `<span class="mono">${r.reverse.map(esc).join(', ')}</span>` : '<span class="faint">None</span>'],
      r.edition === 'java' && [
        'Blocked by Mojang',
        blocked == null
          ? '<span class="faint">Could not check</span>'
          : blocked.blocked
            ? `<span style="color:var(--danger);font-weight:600">Yes</span> <span class="faint small">(matches <span class="mono">${esc(blocked.match)}</span>)</span>`
            : 'No',
      ],
      r.latency != null && ['Latency', `${ms(r.latency)} <span class="faint small">(${esc(r.latencyMethod || '')})</span>`],
      ['Timings', `<span class="small">${tLine}</span>`],
      ['Checked', fmtDate(r.checkedAt)],
    ]);

    const details = online
      ? kvRows([
          ['Version', `${esc(r.version?.name || '—')}`],
          r.version?.protocol != null && ['Protocol', `<span class="mono">${r.version.protocol}</span>`],
          ['Software', r.software ? esc(r.software) : '<span class="faint">Not reported</span>'],
          r.edition === 'java' && ['Query', q?.enabled ? 'Enabled' : '<span class="faint">Off (enable-query=false, or the port is blocked)</span>'],
          q?.map && ['Map', esc(q.map)],
          q?.gameType && ['Game type', esc(q.gameType)],
          r.bedrock?.levelName && ['Level name', esc(r.bedrock.levelName)],
          r.bedrock?.gamemode && ['Game mode', esc(r.bedrock.gamemode)],
          r.bedrock?.serverId && ['Server ID', `<span class="mono small">${esc(r.bedrock.serverId)}</span>`],
          r.bedrock && (r.bedrock.portV4 || r.bedrock.portV6) && ['Ports', `IPv4 ${r.bedrock.portV4 ?? '—'} · IPv6 ${r.bedrock.portV6 ?? '—'}`],
          r.flags && ['Secure chat enforced', yesNo(r.flags.enforcesSecureChat)],
          r.flags?.preventsChatReports != null && ['Prevents chat reports', yesNo(r.flags.preventsChatReports)],
          r.modLoader && ['Mod loader', esc(r.modLoader)],
          r.legacy && ['Ping', 'Legacy ping (Minecraft 1.6 or older, or a server that only answers the old protocol)'],
        ])
      : '';

    const playerList = players.list.length
      ? `<div class="player-chips">${players.list
          .map((p) => `<span class="player-chip" title="${esc(p.id || '')}">${avatar(p.name)}<span>${esc(p.name)}</span></span>`)
          .join('')}</div>${
          players.online > players.list.length ? `<p class="faint small" style="margin-top:10px">and ${players.online - players.list.length} more. Servers only share a sample of names.</p>` : ''
        }`
      : `<p class="muted small">${!online ? 'The server is offline.' : players.online ? 'This server does not share player names.' : 'Nobody is online.'}</p>`;

    $('#st-result', root).innerHTML = `
      <section class="card panel-card st-head" data-online="${online}">
        ${mcEntry({ icon: r.favicon, name, motdHtml: r.motd ? mcHtml(r.motd.raw) : '', online, players: players.online, max: players.max, latency: r.latency })}
        <div class="row">
          <span class="pill ${online ? 'ok' : 'bad'}"><span class="dot ${online ? 'ok' : 'bad'}"></span>${online ? 'Online' : 'Offline'}</span>
          <span class="tag">${r.edition === 'bedrock' ? 'Bedrock' : 'Java'}</span>
          <span class="addr">${esc(r.address)}<button type="button" data-copy="${esc(r.address)}" title="Copy address">${icon('copy')}</button></span>
          <span class="spacer"></span>
          <button class="btn btn-sm ${isFav(r) ? '' : 'btn-magenta'}" id="st-star">${icon(isFav(r) ? 'star' : 'starOutline')}${isFav(r) ? 'Favorite' : 'Add to favorites'}</button>
          <button class="btn btn-sm" id="st-again">${icon('restart')}Check again</button>
        </div>
        ${r.error ? notice(esc(r.error), 'warn') : ''}
      </section>
      ${
        online
          ? `<div class="tiles" style="margin-top:16px">
              <div class="card tile"><div class="label">Players</div><div class="value">${players.online.toLocaleString()}<small>/ ${players.max.toLocaleString()}</small></div><div class="bar lime"><i style="width:${pct(players.online, players.max)}%"></i></div></div>
              <div class="card tile"><div class="label">Latency</div><div class="value">${r.latency ?? '—'}<small>ms</small></div><div class="faint small">from this panel's host</div></div>
              <div class="card tile"><div class="label">Version</div><div class="value st-ver" title="${esc(r.version?.name || '')}">${esc(r.version?.name || '—')}</div><div class="faint small">${r.version?.protocol != null ? `protocol ${r.version.protocol}` : ''}</div></div>
              <div class="card tile"><div class="label">Software</div><div class="value st-ver">${esc(r.software || '—')}</div><div class="faint small">${plugins.length ? `${plugins.length} plugins` : r.mods?.length ? `${r.mods.length} mods` : ''}</div></div>
            </div>`
          : ''
      }
      <div class="cols-2" style="margin-top:16px;align-items:start">
        <div class="card panel-card"><h3 style="margin-bottom:12px">Connection</h3>${connection}</div>
        ${online ? `<div class="card panel-card"><h3 style="margin-bottom:12px">Server</h3>${details}</div>` : ''}
      </div>
      ${
        online
          ? `<div class="card panel-card" style="margin-top:16px"><div class="row" style="margin-bottom:12px"><h3>Players</h3><span class="tag">${players.online.toLocaleString()} online</span></div>${playerList}
              ${players.hover?.length ? `<div class="divider" style="margin:14px 0"></div><div class="lbl small faint" style="margin-bottom:6px">Player list text</div><div class="mc-motd mc-box">${players.hover.map((h) => mcHtml(h)).join('<br>')}</div>` : ''}</div>`
          : ''
      }
      ${
        plugins.length
          ? `<div class="card panel-card" style="margin-top:16px"><div class="row" style="margin-bottom:12px"><h3>Plugins</h3><span class="tag">${plugins.length}</span><span class="faint small">from Query</span></div>
              <div class="chips">${plugins.map((p) => `<span class="chip-static">${esc(p)}</span>`).join('')}</div></div>`
          : ''
      }
      ${
        r.mods?.length || r.modsTruncated
          ? `<div class="card panel-card" style="margin-top:16px"><div class="row" style="margin-bottom:12px"><h3>Mods</h3><span class="tag">${r.mods.length}</span></div>
              ${r.mods.length ? `<div class="chips">${r.mods.map((m) => `<span class="chip-static">${esc(m.id)}${m.version ? ` <span class="faint">${esc(m.version)}</span>` : ''}</span>`).join('')}</div>` : ''}
              ${r.modsTruncated ? '<p class="faint small" style="margin-top:8px">This Forge server sends its mod list in a compressed form, so it may be incomplete.</p>' : ''}</div>`
          : ''
      }
      ${
        r.dns
          ? `<div class="card table-wrap" style="margin-top:16px"><div class="row" style="padding:16px 16px 6px"><h3>DNS records</h3><span class="tag">${r.dns.length}</span></div>${
              r.dns.length
                ? `<table class="table"><thead><tr><th>Type</th><th>Name</th><th>Value</th><th class="num">TTL</th></tr></thead><tbody>${r.dns
                    .map(
                      (d) =>
                        `<tr><td><span class="tag">${esc(d.type)}</span></td><td class="mono small">${esc(d.name)}</td><td class="mono small" style="overflow-wrap:anywhere">${esc(
                          d.value,
                        )}</td><td class="num">${d.ttl != null ? `${d.ttl}s` : ''}</td></tr>`,
                    )
                    .join('')}</tbody></table>`
                : `<p class="muted small" style="padding:0 16px 16px">${isIpAddress(r.host) ? 'An IP address has no DNS records.' : 'No records found.'}</p>`
            }</div>`
          : ''
      }
      ${
        r.raw
          ? `<details class="card panel-card" style="margin-top:16px"><summary class="muted" style="cursor:pointer">Raw response</summary><pre class="raw">${esc(JSON.stringify(r.raw, null, 2))}</pre></details>`
          : ''
      }`;
  }

  async function check(ed, address) {
    setEdition(ed);
    form.elements.address.value = address;
    const mySeq = ++seq;
    const btn = $('button[type=submit]', form);
    btn.disabled = true;
    btn.innerHTML = '<span class="spin"></span>Checking...';
    $('#st-result', root).innerHTML = `<div class="card panel-card row muted"><span class="spin"></span>Checking ${esc(address)}...</div>`;
    try {
      const r = await api('GET', `/api/status?address=${enc(address)}&edition=${ed}`);
      if (mySeq === seq) renderResult(r);
    } catch (err) {
      if (mySeq === seq) $('#st-result', root).innerHTML = notice(esc(err.message), 'warn');
    } finally {
      if (mySeq === seq) {
        btn.disabled = false;
        btn.innerHTML = `${icon('search')}Check`;
      }
    }
  }

  async function loadFavorites() {
    try {
      favorites = await api('GET', '/api/status/favorites');
    } catch (err) {
      return toast(err.message, 'bad');
    }
    $('#st-fav-count', root).textContent = favorites.length;
    if (!favorites.length) {
      $('#st-favs', root).innerHTML = `<div class="card empty-state" style="grid-column:1/-1"><p class="muted">No favorites yet. Check a server, then press <strong>Add to favorites</strong> to keep an eye on it here.</p></div>`;
      return;
    }
    $('#st-favs', root).innerHTML = favorites
      .map(
        (f, i) => `
        <div class="card fav" data-fav="${i}">
          <a class="fav-entry" href="${statusHash(f.edition, f.address)}" title="Check ${esc(f.address)}">${mcEntry({
            icon: null,
            name: f.address,
            motdHtml: '<span class="faint">Checking...</span>',
            online: true,
            latency: null,
          })}</a>
          <div class="row small"><span class="tag">${f.edition === 'bedrock' ? 'Bedrock' : 'Java'}</span><span class="faint" data-fav-meta>Checking...</span><span class="spacer"></span>
            <button type="button" class="icon-btn danger" data-unfav="${i}" title="Remove ${esc(f.address)} from favorites">${icon('trash')}</button></div>
        </div>`,
      )
      .join('');
    favorites.forEach(async (f, i) => {
      let r;
      try {
        r = await api('GET', `/api/status?address=${enc(f.address)}&edition=${f.edition}&quick=1`);
      } catch (err) {
        r = { online: false, error: err.message };
      }
      const card = $(`[data-fav="${i}"]`, root);
      if (!card || favorites[i] !== f) return;
      $('.fav-entry', card).innerHTML = mcEntry({
        icon: r.favicon,
        name: f.address,
        motdHtml: r.motd ? mcHtml(r.motd.raw) : '',
        online: r.online,
        players: r.players?.online,
        max: r.players?.max,
        latency: r.latency,
      });
      $('[data-fav-meta]', card).textContent = r.online ? `${r.version?.name || ''}${r.latency != null ? ` · ${r.latency} ms` : ''}` : r.error || 'Offline';
    });
  }

  $('#st-ed', root).onclick = (e) => {
    const b = e.target.closest('[data-ed]');
    if (b) setEdition(b.dataset.ed);
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    const address = form.elements.address.value.trim();
    if (!address) return form.elements.address.focus();
    const hash = statusHash(edition, address);
    if (location.hash === hash) check(edition, address);
    else location.hash = hash;
  };
  $('#st-fav-refresh', root).onclick = loadFavorites;
  root.addEventListener('click', async (e) => {
    const un = e.target.closest('[data-unfav]');
    if (un) {
      e.preventDefault();
      const f = favorites[Number(un.dataset.unfav)];
      try {
        await api('DELETE', `/api/status/favorites?address=${enc(f.address)}&edition=${f.edition}`);
        toast(`Removed ${f.address} from favorites`, 'ok');
        await loadFavorites();
        if (current) renderResult(current);
      } catch (err) {
        toast(err.message, 'bad');
      }
      return;
    }
    if (e.target.closest('#st-again') && current) return check(current.edition, current.address);
    if (e.target.closest('#st-star') && current) {
      try {
        if (isFav(current)) {
          await api('DELETE', `/api/status/favorites?address=${enc(current.address)}&edition=${current.edition}`);
          toast('Removed from favorites', 'ok');
        } else {
          await api('POST', '/api/status/favorites', { address: current.address, edition: current.edition });
          toast('Added to favorites', 'ok');
        }
        await loadFavorites();
        renderResult(current);
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
  });

  function show([ed, address] = []) {
    if (address) check(ed, address);
    else {
      setEdition(edition);
      current = null;
      $('#st-result', root).innerHTML = '';
      form.elements.address.focus();
    }
  }

  setEdition(edition);
  loadFavorites();
  show(args);
  return { statusPage: true, show, destroy: () => clearInterval(obf) };
}

const isIpAddress = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':');

// ================================================================ all servers (admins)

/** Admins: every server on the panel, grouped by the account that owns it. */
function AllServers(root) {
  if (!me().admin) {
    root.innerHTML = `<div class="card empty-state"><h2>Admins only</h2><p class="muted">Only the panel admin can see everyone's servers.</p><a class="btn" href="#/">Back to dashboard</a></div>`;
    return {};
  }
  root.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Admin</div><h1>All servers</h1><p>Every server on this panel, grouped by the account that owns it.</p></div>
      <div class="input-group all-search"><input class="input" id="all-q" type="search" placeholder="Filter by server or account" autocomplete="off" spellcheck="false"></div></div>
    <div id="all-list"><p class="muted">Loading...</p></div>`;
  let people = new Map();
  let ready = false;
  const q = $('#all-q', root);

  function group(owner, list) {
    const u = people.get(owner);
    const online = list.filter((s) => s.pid).length;
    const players = list.reduce((n, s) => n + s.playerCount, 0);
    const who = !owner
      ? { name: 'No owner', sub: 'Belongs to the admins' }
      : { name: u?.name && u.name !== owner ? u.name : owner, sub: [u?.name && u.name !== owner ? owner : '', u ? '' : 'account removed'].filter(Boolean).join(' · ') };
    const tags = [owner === me().id ? '<span class="tag">You</span>' : '', u?.admin ? '<span class="tag">Admin</span>' : '', u?.status === 'blocked' ? '<span class="tag warn">Blocked</span>' : '']
      .filter(Boolean)
      .join('');
    return `
      <section class="section owner-group">
        <div class="row section-head">
          ${u ? mePic(u) : `<span class="me-pic">${owner ? esc(owner[0].toUpperCase()) : icon('people')}</span>`}
          <div class="me-who"><strong>${esc(who.name)} ${tags}</strong><span>${esc(who.sub)}${who.sub ? ' · ' : ''}${list.length} server${list.length === 1 ? '' : 's'}, ${online} online, ${players} player${players === 1 ? '' : 's'}</span></div>
        </div>
        <div class="server-grid">${list.map((s) => serverCard(s, { owner: false })).join('')}</div>
      </section>`;
  }

  function render() {
    if (!ready) return;
    const term = q.value.trim().toLowerCase();
    const groups = new Map();
    for (const s of state.overview.servers) {
      const owner = s.owner || '';
      const u = people.get(owner);
      const hay = `${s.name} ${owner} ${u?.name || ''} ${softwareLabel(s)}`.toLowerCase();
      if (term && !hay.includes(term)) continue;
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push(s);
    }
    // You first, then the servers without an owner, then everyone else by name.
    const rank = (k) => (k === me().id ? 0 : k === '' ? 1 : 2);
    const keys = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || (people.get(a)?.name || a).localeCompare(people.get(b)?.name || b));
    $('#all-list', root).innerHTML = keys.length
      ? keys.map((k) => group(k, groups.get(k))).join('')
      : `<div class="card empty-state"><h2>${term ? 'Nothing matches' : 'No servers yet'}</h2><p class="muted">${term ? 'Try another name.' : 'Nobody has created a server on this panel.'}</p></div>`;
  }

  api('GET', '/api/users')
    .catch(() => [])
    .then((users) => {
      people = new Map(users.map((u) => [u.id, u]));
      ready = true;
      render();
    });
  q.oninput = render;
  return { update: render };
}

// ================================================================ ports (admins)

const PORT_STATUS = {
  open: ['ok', 'Open'],
  closed: ['warn', 'Not answering'],
  free: ['', 'Server stopped'],
  taken: ['bad', 'Used by another program'],
};

/** Admins: every port the panel and its servers use, from server.properties and plugin or mod configs. */
function Ports(root) {
  if (!me().admin) {
    root.innerHTML = `<div class="card empty-state"><h2>Admins only</h2><p class="muted">Only the panel admin can see every port.</p><a class="btn" href="#/">Back to dashboard</a></div>`;
    return {};
  }
  root.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Admin</div><h1>Ports</h1><p>Every port the panel and its servers use: game ports, RCON and Query, and the ones plugins and mods open, such as BlueMap, Dynmap, Geyser and voice chat.</p></div>
      <div class="input-group all-search" style="width:min(440px, 100%)"><input class="input" id="ports-q" type="search" placeholder="Filter by port, server or use" autocomplete="off" spellcheck="false">
      <button class="btn" id="ports-refresh" style="height:40px">${icon('restart')}Refresh</button></div></div>
    <div id="ports-sum"></div>
    <div class="card table-wrap" id="ports-list"><p class="muted" style="padding:16px 20px">Checking ports...</p></div>`;
  let rows = null;
  const q = $('#ports-q', root);

  function statusCell(r) {
    if (r.proto === 'udp') return `<span class="pill">${r.running ? 'Server running' : 'Server stopped'}</span><div class="faint small">UDP, not checked</div>`;
    const [cls, label] = r.status === 'taken' && r.clash ? ['bad', 'Port in use'] : PORT_STATUS[r.status] || ['', r.status];
    return `<span class="pill ${cls}"><span class="dot ${cls}"></span>${label}</span>`;
  }

  function render() {
    if (!rows) return;
    const term = q.value.trim().toLowerCase();
    const shown = rows.filter((r) => !term || `${r.port} ${r.proto} ${r.server} ${r.owner || ''} ${r.what} ${r.file || ''}`.toLowerCase().includes(term));
    const clashes = new Set(rows.filter((r) => r.clash).map((r) => `${r.port}/${r.proto}`)).size;
    const taken = rows.filter((r) => r.status === 'taken' && !r.clash).length;
    $('#ports-sum', root).innerHTML = [
      clashes ? notice(`<strong>${clashes} port${clashes === 1 ? ' is' : 's are'} set for more than one thing.</strong> Only one can use a port at a time; change the others in their config files.`, 'warn') : '',
      taken ? notice(`<strong>${taken} port${taken === 1 ? ' is' : 's are'} already taken by another program</strong> while its server is stopped. That server will fail to start until the program is closed or the port is changed.`, 'warn') : '',
    ].join('');
    $('#ports-list', root).innerHTML = shown.length
      ? `<table class="table ports-table">
          <thead><tr><th>Port</th><th>Protocol</th><th>Server</th><th>Used for</th><th>Set in</th><th>Status</th></tr></thead>
          <tbody>${shown
            .map(
              (r) => `
            <tr class="${r.clash ? 'clash' : ''}">
              <td class="port">${r.port}</td>
              <td><span class="proto">${r.proto}</span></td>
              <td>${
                r.serverId
                  ? `<a href="#/server/${r.serverId}">${esc(r.server)}</a>${r.owner ? `<div class="faint small">${esc(r.owner)}</div>` : ''}`
                  : `<strong>${esc(r.server)}</strong>`
              }</td>
              <td>${esc(r.what)}${r.public ? `<div class="faint small">Players join at <span class="mono">${esc(r.public)}</span></div>` : ''}${
                r.clash ? `<div class="clash-note">${icon('warn')}<span>Also set for ${r.clash.map(esc).join(', ')}</span></div>` : ''
              }</td>
              <td>${r.file ? `<span class="mono small">${esc(r.file)}</span>` : `<span class="faint small">${esc(r.note || (r.serverId ? '' : 'WEBMC_PORT'))}</span>`}</td>
              <td>${statusCell(r)}</td>
            </tr>`,
            )
            .join('')}</tbody>
        </table>`
      : `<div class="empty-state"><p class="muted">${term ? 'No port matches.' : 'No ports yet.'}</p></div>`;
  }

  async function load() {
    try {
      rows = await api('GET', '/api/ports');
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  }
  q.oninput = render;
  $('#ports-refresh', root).onclick = load;
  load();
  const timer = setInterval(load, 15000);
  return { destroy: () => clearInterval(timer) };
}

// ================================================================ account

const ACCOUNT_MSG = {
  'google-linked': ['ok', 'Google account linked. You can sign in with it now.'],
  'google-in-use': ['bad', 'That Google account already belongs to another account on this panel. Unlink it there first, or ask the admin.'],
  'google-cancelled': ['info', 'Linking Google was cancelled.'],
  'google-unverified': ['bad', 'That Google account has no verified email address.'],
  'google-failed': ['bad', 'Linking Google did not work. Please try again.'],
};
const GOOGLE_G =
  '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

/** Your own account: profile, password, Google and sessions. */
function Account(root, args = []) {
  const msg = ACCOUNT_MSG[args[0]];
  if (msg) {
    toast(msg[1], msg[0]);
    history.replaceState(null, '', '#/account');
  }
  root.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">You</div><h1>Account</h1><p>Your profile, password and the ways you sign in.</p></div></div>
    <div class="stack" id="acc"><p class="muted">Loading...</p></div>`;
  const box = $('#acc', root);

  function render(a) {
    const canUnlink = a.hasPassword && a.username;
    const passwordTitle = a.hasPassword ? 'Password' : a.username ? 'Set a password' : 'Add a username and password';
    box.innerHTML = `
      <div class="card panel-card account-head">
        ${mePic(a).replace('class="me-pic"', 'class="me-pic big"')}
        <div class="me-who"><strong>${esc(a.name)}</strong><span>${esc([a.username, a.email].filter(Boolean).join(' · '))}</span></div>
        <div class="row account-tags">
          ${a.admin ? `<span class="tag">${icon('shield')}Admin</span>` : ''}
          <span class="tag">${a.servers} server${a.servers === 1 ? '' : 's'}</span>
          ${a.firstSeen ? `<span class="faint small">Joined ${esc(fmtDate(a.firstSeen))}</span>` : ''}
        </div>
      </div>

      <form class="card panel-card form" id="acc-profile" novalidate>
        <h2>Profile</h2>
        <div class="form-grid">
          <div class="field"><label for="acc-name">Display name</label><input class="input" id="acc-name" name="name" value="${esc(a.name)}" maxlength="60" autocomplete="name">
            <span class="hint">Shown in the sidebar and to the admin.</span></div>
          ${
            a.username
              ? `<div class="field"><label for="acc-user">Username</label><input class="input" id="acc-user" name="username" value="${esc(a.username)}" maxlength="24" autocomplete="username" spellcheck="false">
                  <span class="hint">What you sign in with. Changing it signs out your other browsers.</span></div>`
              : ''
          }
          ${a.email ? `<div class="field"><label for="acc-email">Email</label><input class="input" id="acc-email" value="${esc(a.email)}" disabled><span class="hint">From your linked Google account.</span></div>` : ''}
        </div>
        <div class="form-actions"><button class="btn btn-accent" type="submit">${icon('save')}Save profile</button></div>
      </form>

      <form class="card panel-card form" id="acc-password" novalidate>
        <div><h2>${passwordTitle}</h2><p class="sub" style="margin:4px 0 0">${
          a.hasPassword
            ? 'Changing it signs out your other browsers. Forgot it? Ask the admin for a one-time password.'
            : a.username
              ? 'You have no password right now. Set one to sign in with your username.'
              : 'You sign in with Google. Add a username and password to sign in without it too.'
        }</p></div>
        <div class="form-grid">
          ${
            !a.hasPassword && !a.username
              ? `<div class="field"><label for="acc-newuser">Username</label><input class="input" id="acc-newuser" name="username" maxlength="24" autocomplete="username" spellcheck="false" required>
                  <span class="hint">3 to 24 letters, digits, dots, dashes or underscores.</span></div>`
              : a.username
                ? `<input type="hidden" name="username" value="${esc(a.username)}" autocomplete="username">`
                : ''
          }
          ${a.hasPassword ? `<div class="field"><label for="acc-cur">Current password</label><input class="input" id="acc-cur" name="current" type="password" autocomplete="current-password" required></div>` : ''}
          <div class="field"><label for="acc-new">New password</label><input class="input" id="acc-new" name="next" type="password" minlength="8" autocomplete="new-password" required><span class="hint">At least 8 characters.</span></div>
          <div class="field"><label for="acc-conf">Confirm new password</label><input class="input" id="acc-conf" name="confirm" type="password" autocomplete="new-password" required></div>
        </div>
        <div class="form-actions"><button class="btn btn-accent" type="submit">${icon('key')}${a.hasPassword ? 'Change password' : 'Save password'}</button></div>
      </form>

      <div class="card panel-card stack-sm">
        <h2>Google</h2>
        ${
          a.google
            ? `<div class="linked-row">${GOOGLE_G}<div class="me-who"><strong>Linked</strong><span>${esc(a.email)}</span></div>
                 <button class="btn btn-ghost" id="acc-unlink" ${canUnlink ? '' : 'disabled'}>Unlink</button></div>
               ${canUnlink ? '' : '<p class="hint">Add a username and password above before unlinking, so you can still sign in.</p>'}
               ${a.adminFrom === 'env' ? '<p class="hint">You are an admin because this email is in <code>WEBMC_ADMIN_EMAILS</code>. You stay an admin if you unlink it.</p>' : ''}`
            : a.googleAvailable
              ? `<p class="sub">Link a Google account to sign in with one click. You can still use your username and password.</p>
                 <div><a class="btn" href="/auth/google?link=1">${GOOGLE_G}Link Google account</a></div>`
              : `<p class="sub">Google sign-in is not set up on this panel${
                  a.admin ? '. To turn it on, set <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> (see the README) and restart.' : '.'
                }</p>`
        }
      </div>

      <div class="card panel-card stack-sm">
        <h2>Sessions</h2>
        <p class="sub">Signed in on a computer you no longer use? Sign out everywhere else. This browser stays signed in.</p>
        <div class="row"><button class="btn" id="acc-everywhere">${icon('logout')}Sign out other browsers</button><button class="btn btn-ghost" data-logout>Sign out here</button></div>
      </div>`;

    $('#acc-profile', box).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      try {
        const next = await api('PATCH', '/api/account', { name: f.name.value, ...(f.username ? { username: f.username.value } : {}) });
        toast('Profile saved', 'ok');
        await poll();
        render(next);
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
    $('#acc-password', box).onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      if (f.next.value !== f.confirm.value) return toast('The two new passwords are different', 'bad');
      try {
        const next = await api('POST', '/api/account/password', {
          current: f.current?.value,
          next: f.next.value,
          ...(f.username && !a.username ? { username: f.username.value } : {}),
        });
        toast(a.hasPassword ? 'Password changed' : 'Password saved. You can sign in with it now.', 'ok');
        await poll();
        render(next);
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
    const unlink = $('#acc-unlink', box);
    if (unlink) {
      unlink.onclick = async () => {
        const ok = await confirmBox('Unlink Google?', `You will no longer be able to sign in with ${a.email}. Sign in with your username and password instead.`, { confirmText: 'Unlink' });
        if (!ok) return;
        try {
          render(await api('POST', '/api/account/google/unlink'));
          toast('Google account unlinked', 'ok');
          poll();
        } catch (err) {
          toast(err.message, 'bad');
        }
      };
    }
    $('#acc-everywhere', box).onclick = async () => {
      if (!(await confirmBox('Sign out other browsers?', 'Every other browser and device signed in to this account is signed out. This one stays signed in.', { confirmText: 'Sign them out' }))) return;
      try {
        await api('POST', '/api/account/sign-out-everywhere');
        toast('Signed out everywhere else', 'ok');
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  }

  api('GET', '/api/account')
    .then(render)
    .catch((err) => (box.innerHTML = notice(esc(err.message), 'warn')));
  return {};
}

// ================================================================ panel settings

const USER_STATUS = { approved: ['ok', 'Can sign in'], pending: ['warn', 'Waiting for approval'], blocked: ['bad', 'Blocked'] };

/** Shows a one-time password once, with a copy button. */
function showOtp(login, otp, intro) {
  return modal({
    title: 'One-time password',
    confirmText: 'Done',
    cancelText: '',
    body: `<p>${intro}</p>
      <dl class="kv" style="margin-top:12px"><dt>Sign in as</dt><dd class="mono">${esc(login)}</dd>
        <dt>One-time password</dt><dd><span class="addr otp">${esc(otp)}<button type="button" data-copy="${esc(otp)}" title="Copy">${icon('copy')}</button></span></dd></dl>
      <p class="hint" style="margin-top:12px">It works once, within 24 hours. After signing in with it they choose their own password. This is the only time it is shown.</p>`,
  });
}

/** Admin: every account, who may sign in, admins, and one-time passwords for people who forgot theirs. */
/** What the Accounts card shows, minus "last seen" (which changes all the time), to tell when to redraw it. */
const usersSig = (users) => JSON.stringify(users.map(({ lastSeen, ...u }) => u));

async function renderUsers(card, settings, info) {
  let users;
  try {
    users = await api('GET', '/api/users');
  } catch (err) {
    card.innerHTML = `<h2>Accounts</h2><p class="muted">${esc(err.message)}</p>`;
    return;
  }
  card.dataset.sig = usersSig(users);
  const pending = users.filter((u) => u.status === 'pending' && !u.admin && !u.placeholder).length;
  const kind = (u) =>
    u.placeholder
      ? u.email
        ? 'Google, not signed in yet'
        : 'Username, not created yet'
      : [u.username && (u.hasPassword ? 'Password' : 'No password'), u.email && 'Google'].filter(Boolean).join(' + ');
  card.innerHTML = `
    <div class="row"><h2>Accounts</h2><span class="tag">${users.length}</span>${pending ? `<span class="tag warn">${pending} waiting</span>` : ''}</div>
    <p class="sub" style="margin-top:4px">People sign in with a username and password${info.google ? ' or with Google' : ''}, and manage only their own servers. Admins see and manage every server and account.</p>
    <div class="form-grid" style="margin-bottom:16px">
      <div class="field"><label for="ps-signups">Who can sign in</label>
        <select class="input" id="ps-signups">
          <option value="approval" ${settings.signups !== 'open' ? 'selected' : ''}>Only accounts I approve</option>
          <option value="open" ${settings.signups === 'open' ? 'selected' : ''}>Anyone who signs up</option>
        </select>
        <span class="hint">With approval, new people see "waiting for approval" until you approve them below.</span></div>
      <div class="field"><span class="lbl">Username and password accounts</span>
        ${switchHtml('passwordSignups', settings.passwordSignups !== false, 'Let people create an account with a username and password')}
        <span class="hint">${info.google ? 'When off, only Google sign-in creates new accounts.' : 'When off, nobody can create an account except usernames you approve below.'} Existing accounts can still sign in.</span></div>
      <form class="field" id="ps-add" novalidate><label for="ps-add-id">Approve someone ahead of time</label>
        <div class="input-group"><input class="input" id="ps-add-id" name="id" placeholder="${info.google ? 'friend@gmail.com or a username' : 'A username'}" autocomplete="off" spellcheck="false"><button class="btn" type="submit" style="height:40px">${icon('plus')}Approve</button></div>
        <span class="hint">An approved username is reserved: the first person to create it gets in straight away.</span></form>
    </div>
    <div class="card table-wrap"><table class="table"><thead><tr><th>Account</th><th>Status</th><th class="num">Servers</th><th class="num">Last seen</th><th></th></tr></thead><tbody>
      ${users
        .map((u) => {
          const self = u.id === me().id;
          const [cls, label] = u.admin ? ['ok', u.adminFrom === 'env' ? 'Admin (email list)' : 'Admin'] : USER_STATUS[u.status] || ['', u.status];
          const id = esc(u.id);
          const actions = [
            !u.admin && u.status !== 'approved' ? `<button class="btn btn-sm btn-accent" data-user-status="approved" data-id="${id}">Approve</button>` : '',
            !u.admin && u.status !== 'blocked' ? `<button class="btn btn-sm btn-ghost" data-user-status="blocked" data-id="${id}">Block</button>` : '',
            !u.placeholder && !u.admin ? `<button class="icon-btn" data-user-admin="1" data-id="${id}" title="Make admin">${icon('shield')}</button>` : '',
            u.admin && u.adminFrom === 'role' && !self ? `<button class="btn btn-sm btn-ghost" data-user-admin="0" data-id="${id}">Remove admin</button>` : '',
            !u.placeholder && !self ? `<button class="icon-btn" data-user-reset="${id}" title="Make a one-time password (forgot password)">${icon('key')}</button>` : '',
            !u.admin && !self ? `<button class="icon-btn danger" data-user-remove="${id}" title="Remove account">${icon('trash')}</button>` : '',
          ].join('');
          return `<tr>
            <td><div class="me-row" style="padding:0;margin:0;border:0">${mePic({ ...u, name: u.name || u.id })}<div class="me-who"><strong>${esc(u.name || u.id)}${self ? ' <span class="faint small">(you)</span>' : ''}</strong><span>${esc(
              [u.username, u.email].filter(Boolean).join(' · ') || u.id,
            )} · ${esc(kind(u))}${u.resetPending ? ' · <em>one-time password not used yet</em>' : ''}</span></div></div></td>
            <td><span class="pill ${cls}"><span class="dot ${cls}"></span>${esc(label)}</span></td>
            <td class="num">${u.servers}</td>
            <td class="num">${u.lastSeen ? fmtAgo(u.lastSeen) : 'never'}</td>
            <td class="actions">${actions}</td></tr>`;
        })
        .join('')}
    </tbody></table></div>
    <p class="hint" style="margin-top:10px">Locked out of the admin account? Run <code>node reset-admin.js</code> in the panel folder on the server for a one-time password.</p>`;

  const refresh = async () => {
    await renderUsers(card, (await api('GET', '/api/settings')).settings, info);
    poll();
  };
  const saveSetting = async (body, message) => {
    try {
      await api('PUT', '/api/settings', body);
      toast(message, 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  $('#ps-signups', card).onchange = (e) =>
    saveSetting({ signups: e.target.value }, e.target.value === 'open' ? 'Anyone who signs up can now get in' : 'New accounts now need your approval');
  card.querySelector('[name="passwordSignups"]').onchange = (e) =>
    saveSetting({ passwordSignups: e.target.checked }, e.target.checked ? 'People can create username and password accounts' : 'New username accounts are turned off');
  $('#ps-add', card).onsubmit = async (e) => {
    e.preventDefault();
    const id = e.target.elements.id.value.trim();
    if (!id) return;
    try {
      await api('POST', '/api/users', { id, status: 'approved' });
      toast(`${id} can now sign in`, 'ok');
      refresh();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  card.onclick = async (e) => {
    const st = e.target.closest('[data-user-status]');
    const ad = e.target.closest('[data-user-admin]');
    const rm = e.target.closest('[data-user-remove]');
    const rs = e.target.closest('[data-user-reset]');
    try {
      if (st) {
        await api('POST', '/api/users', { id: st.dataset.id, status: st.dataset.userStatus });
        toast(st.dataset.userStatus === 'approved' ? `${st.dataset.id} can now sign in` : `${st.dataset.id} is blocked`, 'ok');
        refresh();
      } else if (ad) {
        const on = ad.dataset.userAdmin === '1';
        const id = ad.dataset.id;
        const ok = await confirmBox(
          on ? `Make ${id} an admin?` : `Remove admin from ${id}?`,
          on ? 'Admins can see, change and delete every server and every account, including yours.' : 'They keep their own servers but can no longer see anyone else\'s.',
          { confirmText: on ? 'Make admin' : 'Remove admin', danger: on },
        );
        if (!ok) return;
        await api('POST', '/api/users', { id, admin: on });
        toast(on ? `${id} is now an admin` : `${id} is no longer an admin`, 'ok');
        refresh();
      } else if (rs) {
        const id = rs.dataset.userReset;
        const ok = await confirmBox(
          `Reset the password for ${id}?`,
          'Their current password stops working and they are signed out everywhere. You get a one-time password to give them; they choose a new password when they sign in with it.',
          { confirmText: 'Make one-time password' },
        );
        if (!ok) return;
        const r = await api('POST', `/api/users/${enc(id)}/password`);
        refresh();
        await showOtp(r.login, r.otp, `Give this to <strong>${esc(id)}</strong>, for example in a private message.`);
      } else if (rm) {
        const id = rm.dataset.userRemove;
        const ok = await confirmBox(
          `Remove ${id}?`,
          'They are signed out and have to sign up and be approved again to come back. Their servers are kept, and you can still manage them or give them to someone else.',
          { danger: true, confirmText: 'Remove' },
        );
        if (!ok) return;
        await api('DELETE', `/api/users/${enc(id)}`);
        toast(`Removed ${id}`, 'ok');
        refresh();
      }
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
}

const PLAYIT_CLAIM = {
  visit: 'Open the link, then sign in to playit.gg or make a free account.',
  approve: 'Now approve WebbMC on the playit.gg page you opened.',
  finishing: 'Approved. Finishing the setup...',
};
const PLAYIT_HOME = 'https://playit.gg/account/tunnels';

/** Admin: playit.gg tunnels, for a panel running on your own computer. Returns a function that stops refreshing. */
function renderPlayit(card) {
  let last = '';
  let acting = false;
  const serverFor = (dest) => {
    const port = Number(/:(\d+)\s*$/.exec(dest || '')?.[1]);
    return state.overview.servers.find((s) => s.port === port);
  };
  /** What the panel found about a playit installed on this computer (when it is not using it). */
  function externalNote(ext) {
    if (!ext || ext.inUse || ext.state === 'none') return '';
    const check = `<button class="btn btn-sm btn-ghost" data-playit="check">${icon('restart')}Check again</button>`;
    if (ext.state === 'running') return '';
    if (ext.state === 'installed') {
      const start = ext.platform === 'linux' ? `Start it with <span class="addr">${esc(ext.start)}<button type="button" data-copy="${esc(ext.start)}" title="Copy">${icon('copy')}</button></span>` : `${esc(ext.start)}.`;
      return notice(`<strong>playit is installed on this computer but not running.</strong> ${start} WebbMC then uses it by itself. ${check}`);
    }
    if (ext.state === 'denied') {
      const fix =
        ext.platform === 'linux'
          ? `Let WebbMC's user in, then restart WebbMC: <span class="addr">sudo usermod -aG playit ${esc(ext.user)}<button type="button" data-copy="sudo usermod -aG playit ${esc(ext.user)}" title="Copy">${icon('copy')}</button></span>`
          : 'Run WebbMC as the same user as playit (or as an administrator).';
      return notice(`<strong>playit is running on this computer, but WebbMC is not allowed to talk to it.</strong> ${fix} ${check}`, 'warn');
    }
    return notice(`<strong>Found playit on this computer, but cannot use it.</strong> ${esc(ext.message || '')} ${check}`, 'warn');
  }
  function view(st) {
    const ext = st.external;
    const existing = st.source === 'external'; // using the playit installed on this computer, not the panel's own
    const head = (extra = '') =>
      `<div class="row"><h2>Public address with playit.gg</h2>${extra}<span class="spacer"></span>${!existing && st.version ? `<span class="faint small">agent ${esc(st.version)}</span>` : ''}</div>
       <p class="sub" style="margin-top:4px">A free tunnel that gives your servers an address anyone can join, without opening ports on your router. Java and Bedrock both work.</p>
       ${existing ? notice('<strong>Using the playit already installed on this computer.</strong> WebbMC found it running, shows its tunnels and puts their addresses on your servers. It keeps running on its own; manage it with playit or on playit.gg.') : ''}
       ${!existing && st.enabled && ext?.state === 'running' ? notice(`<strong>playit is also installed and running on this computer.</strong> Both work, but one is enough. <button class="btn btn-sm" data-playit="use-existing">Use that one instead</button>`) : ''}`;
    if (st.busy) return `${head()}<p class="row muted"><span class="spin"></span>${esc(st.busy)}...</p>`;
    if (!existing && !st.enabled) {
      const found = externalNote(ext);
      if (!st.supported) return `${head()}${found}${notice(`${esc(st.reason)}${ext && ext.state === 'none' ? ' If you install playit on this computer, WebbMC finds it and shows its tunnels.' : ''}`)}`;
      return `${head()}${found}
        <p class="sub">${
          ext && ext.state === 'none' ? 'No playit was found on this computer. ' : ''
        }Turning it on downloads the official playit agent (about 5 MB) from playit's GitHub releases into the panel's data folder and runs it while the panel runs. It does not touch a playit you installed yourself.</p>
        <div class="row"><button class="btn btn-accent" data-playit="enable">${icon('signal')}Turn on playit.gg</button>${ext ? `<button class="btn btn-sm btn-ghost" data-playit="check">${icon('search')}Look for playit on this computer</button>` : ''}</div>`;
    }
    const pill = (cls, label) => `<span class="pill ${cls}"><span class="dot ${cls}"></span>${esc(label)}</span>`;
    const off = existing ? '' : `<button class="btn btn-sm btn-ghost" data-playit="disable">Turn off</button>`;
    const err = st.error && !existing ? notice(esc(st.error), 'warn') : '';
    if (!st.connected || st.state === 'starting')
      return `${head(pill('warn', existing ? 'Connecting' : 'Starting'))}${err}<p class="row muted"><span class="spin"></span>${existing ? 'Connecting to playit...' : 'Starting the playit agent...'}</p><div class="row">${off}</div>`;
    if (st.state === 'waiting_for_secret' || st.claim) {
      const c = st.claim;
      return `${head(pill('warn', 'Not linked'))}${err}
        ${
          c && c.state !== 'error'
            ? `<div class="stack-sm"><p><strong>${esc(PLAYIT_CLAIM[c.state] || 'Waiting for playit.gg...')}</strong></p>
                <div class="row"><a class="btn btn-accent" href="${esc(c.url)}" target="_blank" rel="noopener">${icon('external')}Open playit.gg to link</a><span class="addr">${esc(c.url)}<button type="button" data-copy="${esc(c.url)}" title="Copy">${icon('copy')}</button></span></div>
                <p class="row muted small"><span class="spin"></span>This page updates by itself once you approve.</p>
                <div class="row"><button class="btn btn-sm btn-ghost" data-playit="cancel-link">Cancel</button>${off}</div></div>`
            : `${c?.error ? notice(esc(c.error), 'warn') : ''}<p class="sub">Link ${existing ? 'the playit on this computer' : 'the agent'} to a playit.gg account. Your tunnels and their addresses live in that account.</p>
               <div class="row"><button class="btn btn-accent" data-playit="link">${icon('link')}Link a playit.gg account</button>${off}</div>`
        }`;
    }
    if (st.state !== 'running') {
      return `${head(pill('bad', 'Problem'))}${err}${notice(esc(st.problem || `The agent reports: ${st.state.replace(/_/g, ' ')}`), 'warn')}
        ${existing ? '' : `<div class="row"><button class="btn btn-accent btn-sm" data-playit="unlink">Link again</button><button class="btn btn-sm" data-playit="update">Update agent</button>${off}</div>`}`;
    }
    const dash = st.loginLink || PLAYIT_HOME;
    const tunnels = st.tunnels.length
      ? `<div class="table-wrap"><table class="table"><thead><tr><th>Address for players</th><th>Goes to</th><th>Server</th></tr></thead><tbody>${st.tunnels
          .map((t) => {
            const srv = serverFor(t.destination);
            return `<tr><td>${t.address ? `<span class="addr">${esc(t.address)}<button type="button" data-copy="${esc(t.address)}" title="Copy">${icon('copy')}</button></span>` : '<span class="faint">Setting up...</span>'}${
              t.disabled ? ` <span class="tag warn" title="${esc(t.reason || '')}">Disabled</span>` : ''
            }</td><td class="mono small">${esc(t.destination)}</td><td>${srv ? `<a href="#/server/${srv.id}">${esc(srv.name)}</a>` : '<span class="faint small">No server on that port</span>'}</td></tr>`;
          })
          .join('')}</tbody></table></div>
         <p class="hint">Servers show their tunnel address on the dashboard automatically (unless they have their own address in Settings).</p>`
      : `<p class="sub"><strong>No tunnels yet.</strong> Open playit.gg, add a tunnel of type <em>Minecraft Java</em> (or <em>Minecraft Bedrock</em>), and point it at <span class="mono">127.0.0.1</span> and your server's port${
          state.overview.servers.length ? `: ${state.overview.servers.map((s) => `${esc(s.name)} uses <span class="mono">${s.port}</span>`).join(', ')}` : ''
        }. It shows up here within a few seconds.</p>`;
    return `${head(pill('ok', 'Running'))}${err}
      ${st.notices.map((n) => notice(`${esc(n.message)}${n.link ? ` <a href="${esc(n.link)}" target="_blank" rel="noopener">Fix it</a>` : ''}`, 'warn')).join('')}
      ${st.pendingTunnels.length ? notice(st.pendingTunnels.map(esc).join('<br>')) : ''}
      ${tunnels}
      <div class="row" style="margin-top:12px"><a class="btn btn-sm btn-accent" href="${esc(dash)}" target="_blank" rel="noopener">${icon('external')}Manage tunnels on playit.gg</a>
        ${existing ? '' : `<button class="btn btn-sm" data-playit="update">Update agent</button><button class="btn btn-sm btn-ghost" data-playit="unlink">Unlink account</button>${off}`}</div>
      ${st.accountStatus === 'guest' ? '<p class="hint">This is a guest playit.gg account. Open the dashboard and add an email so you do not lose it.</p>' : ''}
      ${st.log.length ? `<details class="raw"><summary class="faint small">Agent log</summary><pre class="mono small">${esc(st.log.join('\n'))}</pre></details>` : ''}`;
  }
  async function refresh() {
    if (acting) return;
    let html;
    try {
      html = view(await api('GET', '/api/playit'));
    } catch (err) {
      html = `<h2>Public address with playit.gg</h2>${notice(esc(err.message), 'warn')}`;
    }
    if (html === last) return;
    const logOpen = card.querySelector('details')?.open; // keep the log open across refreshes
    last = html;
    card.innerHTML = html;
    if (logOpen && card.querySelector('details')) card.querySelector('details').open = true;
  }
  card.onclick = async (e) => {
    const b = e.target.closest('[data-playit]');
    if (!b) return;
    const action = b.dataset.playit;
    if (action === 'unlink' && !(await confirmBox('Unlink playit.gg?', 'The agent forgets its key and your servers lose their playit address until you link again. The tunnels stay in your playit.gg account.', { confirmText: 'Unlink' }))) return;
    if (action === 'disable' && !(await confirmBox('Turn off playit.gg?', 'Players cannot reach your servers through playit.gg until you turn it back on. Your account and tunnels are kept.', { confirmText: 'Turn off' }))) return;
    if (action === 'use-existing' && !(await confirmBox('Use the playit on this computer?', "WebbMC turns its own playit agent off and shows the tunnels of the playit installed on this computer instead. Servers whose tunnels are only in WebbMC's agent lose their playit address until you add them to the other one.", { confirmText: 'Use it' }))) return;
    acting = true;
    b.disabled = true;
    if (action === 'enable' || action === 'update') card.querySelector('.row:last-child')?.insertAdjacentHTML('beforeend', '<span class="row muted small"><span class="spin"></span>Downloading...</span>');
    try {
      const st = await api('POST', '/api/playit', { action });
      last = view(st);
      card.innerHTML = last;
      if (action === 'link' && st.claim?.url) window.open(st.claim.url, '_blank', 'noopener');
      poll();
    } catch (err) {
      toast(err.message, 'bad');
      b.disabled = false;
    } finally {
      acting = false;
    }
  };
  refresh();
  const timer = setInterval(refresh, 3000);
  return () => clearInterval(timer);
}

/** Panel settings > Updates: the running version, new commits, and the button that stops the servers and updates. */
async function renderUpdates(card, check = false) {
  let u;
  try {
    u = await api(check ? 'POST' : 'GET', check ? '/api/update/check' : '/api/update');
  } catch (err) {
    card.innerHTML = `<h2>Updates</h2>${notice(esc(err.message), 'warn')}`;
    return;
  }
  const cur = u.current
    ? `<span class="mono">${esc(u.current.sha)}</span> ${esc(u.current.subject)}${u.current.t ? ` <span class="faint">(${esc(fmtDate(u.current.t))})</span>` : ''}`
    : '<span class="faint">Unknown</span>';
  let branchRow = '';
  if (u.mode === 'git' && u.branches?.length) {
    const opts = u.branches
      .map((b) => {
        const kind = branchKind(b.name, u);
        return `<option value="${esc(b.name)}" ${b.name === u.branch ? 'selected' : ''}>${esc(b.name)}${kind ? ` (${kind})` : ''}</option>`;
      })
      .join('');
    branchRow = `<dt>Branch</dt><dd><div class="row branch-pick">
        <select class="input" id="upd-branch" aria-label="Branch">${u.branch ? '' : '<option value="" selected disabled>Detached commit</option>'}${opts}</select>
        <button class="btn btn-sm" data-act="switch" disabled>Switch</button></div>
        <div class="faint small" id="upd-branch-hint" style="margin-top:6px"></div></dd>`;
  } else if (u.branch) branchRow = `<dt>Branch</dt><dd class="mono">${esc(u.branch)}</dd>`;
  let body;
  if (u.mode === 'none') body = notice(esc(u.applyNote));
  else if (u.error) body = notice(`Could not check for updates: ${esc(u.error)}`, 'warn');
  else if (u.available) {
    body = `
      ${notice(`<strong>${u.behind} new change${u.behind === 1 ? '' : 's'} on ${u.branch ? `<span class="mono">${esc(u.branch)}</span>` : 'GitHub'}.</strong> ${u.canApply ? (u.restarts ? 'Updating stops every server, installs the update and restarts the panel. Servers that were running start again.' : esc(u.applyNote)) : esc(u.applyNote)}`)}
      <div class="feed card">${u.commits
        .slice(0, 10)
        .map((c) => `<div class="item"><span class="mono small">${esc(c.sha)}</span><span class="faint small nowrap">${c.t ? fmtAgo(c.t) : ''}</span><span class="msg">${esc(c.subject)}</span></div>`)
        .join('')}${u.commits.length > 10 ? `<div class="item"><span></span><span></span><span class="faint">and ${u.commits.length - 10} more</span></div>` : ''}</div>
      ${u.dirty ? notice('This folder has local edits to the panel. The update works when they do not touch the same files; otherwise git refuses and nothing changes.', 'warn') : ''}
      ${u.canApply ? `<div><button class="btn btn-accent" data-update-now>${icon('download')}Stop servers and update</button></div>` : ''}`;
  } else body = `<p class="muted" style="margin:0">${icon('shield').replace('<svg', '<svg style="width:16px;height:16px;vertical-align:-3px;color:var(--accent)"')} WebbMC is up to date.</p>`;
  // How soon a push shows up, and the optional GitHub webhook that makes it instant.
  let speed = '';
  if (u.webhook?.configured) {
    speed = `<p class="faint small" style="margin:0">${icon('bolt').replace('<svg', '<svg style="width:14px;height:14px;vertical-align:-2px;color:var(--accent)"')} Instant: GitHub tells WebbMC about every push${
      u.webhook.lastAt ? ` (last message ${fmtAgo(u.webhook.lastAt)})` : '. No message from GitHub yet: check the webhook in the repository settings.'
    }</p>`;
  } else if (u.webhook) {
    const hook = `${location.origin}/api/update/webhook`;
    const secret = [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
    const copyable = (v) => `<span class="addr">${esc(v)}<button type="button" data-copy="${esc(v)}" title="Copy">${icon('copy')}</button></span>`;
    speed = `<details class="raw"><summary class="faint small">While the panel is open, pushes show up within a minute. Make it instant (optional)</summary>
      <ol class="small muted stack-sm" style="margin:10px 0 0;padding-left:18px">
        <li>On the <a href="#/settings/env">.env</a> tab, set <span class="mono">WEBMC_WEBHOOK_SECRET</span> to a long random value, for example ${copyable(secret)}, then restart WebbMC.</li>
        <li>On GitHub, open the repository's <strong>Settings → Webhooks → Add webhook</strong>. Payload URL ${copyable(hook)}, content type <span class="mono">application/json</span>, the same secret, and <em>Just the push event</em>.</li>
      </ol>
      ${local ? notice('GitHub has to reach that address from the internet. Open this page through your public domain to get the right Payload URL.', 'warn') : ''}
    </details>`;
  }
  card.innerHTML = `
    <div class="row"><h2>Updates</h2><span class="spacer"></span>${
      u.mode !== 'none' ? `<button class="btn btn-sm" data-act="check">${icon('restart')}Check now</button>` : ''
    }</div>
    <dl class="kv"><dt>Running</dt><dd>${cur}</dd>${branchRow}${u.checkedAt ? `<dt>Last checked</dt><dd>${fmtAgo(u.checkedAt)}</dd>` : ''}</dl>
    ${body}
    ${speed}`;
  const pick = $('#upd-branch', card);
  if (pick) {
    const go = $('[data-act="switch"]', card);
    const hint = $('#upd-branch-hint', card);
    const show = () => {
      const b = u.branches.find((x) => x.name === pick.value);
      const other = b && b.name !== u.branch;
      go.disabled = !other || !u.canApply;
      hint.innerHTML = !b
        ? ''
        : `${other ? 'Latest' : 'This copy runs this branch. Latest on GitHub'}: <span class="mono">${esc(b.sha)}</span> ${esc(b.subject)}${b.t ? ` (${fmtAgo(b.t)})` : ''}${
            other && branchKind(b.name, u) !== 'stable' ? ` · <span style="color:var(--warn)">not the stable version</span>` : ''
          }`;
    };
    pick.onchange = show;
    go.onclick = () => switchBranch(pick.value, u);
    show();
  }
  const btn = $('[data-act="check"]', card);
  if (btn)
    btn.onclick = () => {
      btn.disabled = true;
      btn.innerHTML = `${icon('restart')}Checking...`;
      renderUpdates(card, true);
    };
}

/** The value of KEY in .env text, roughly as Node reads it (for warnings before saving the text view). */
function envValue(text, key) {
  let value;
  for (const line of String(text).split('\n')) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`).exec(line);
    if (!m) continue;
    const v = m[1].trim();
    const q = v[0];
    value = (q === '"' || q === "'" || q === '`') && v.indexOf(q, 1) > 0 ? v.slice(1, v.indexOf(q, 1)) : v.replace(/#.*$/, '').trim();
  }
  return value ?? '';
}

const ENV_GROUPS = ['Sign-in', 'Address', 'Storage', 'Other', 'Custom'];

/**
 * Panel settings > .env: every variable in the .env file, as fields or as the whole file. WebbMC reads .env when it
 * starts, so saved changes wait for a restart. Returns the view's cleanup (none).
 */
function renderEnv(box) {
  let d = null;
  let mode = pref.get('envMode', 'fields');
  let dirty = false;

  const load = async () => {
    try {
      d = await api('GET', '/api/env');
    } catch (err) {
      box.innerHTML = notice(esc(err.message), 'warn');
      return;
    }
    dirty = false;
    draw();
  };

  /** Ask before risky changes (port, address, data folder, session secret). changes: [{ key, from, to }]. */
  const confirmRisky = async (changes) => {
    const risky = changes.filter((c) => d.vars.find((v) => v.key === c.key)?.risky);
    if (!risky.length) return true;
    const items = risky
      .map((c) => `<li><span class="mono">${esc(c.key)}</span> ${c.to ? `= <span class="mono">${esc(d.vars.find((v) => v.key === c.key).secret ? '••••' : c.to)}</span>` : 'is now blank'}: ${esc(d.vars.find((v) => v.key === c.key).risky)}</li>`)
      .join('');
    return modal({
      title: 'Save these changes?',
      body: `<ul class="stack-sm" style="margin:0;padding-left:18px">${items}</ul><p class="muted" style="margin:0">They apply after the panel restarts.</p>`,
      danger: true,
      confirmText: 'Save anyway',
    }).then(Boolean);
  };

  const saved = (r) => {
    d = r;
    dirty = false;
    toast(r.changed.length ? `Saved .env (${r.changed.join(', ')}). Restart the panel to apply.` : 'Nothing changed', r.changed.length ? 'ok' : 'info');
    draw();
  };

  const restart = async () => {
    const pending = d.vars.filter((v) => v.pending);
    const port = pending.find((v) => v.key === 'WEBMC_PORT');
    const newPort = port ? port.value || '8420' : '';
    const origin = newPort && newPort !== location.port ? `${location.protocol}//${location.hostname}:${newPort}` : '';
    const running = (state.overview?.servers || []).filter((s) => s.pid).length;
    const ok = await confirmBox(
      'Restart WebbMC?',
      `WebbMC stops ${running ? `the ${running} running server${running === 1 ? '' : 's'} (players are disconnected)` : 'every server'}, restarts with the new .env and starts the servers that were running again.${
        origin ? ` It then answers on port ${newPort}, so this page moves to ${origin}.` : ''
      }`,
      { danger: true, confirmText: 'Restart now' },
    );
    if (ok) await restartPanel('Restarting WebbMC', () => api('POST', '/api/env/restart'), true, 'WebbMC is restarting', origin);
  };

  function statusCard() {
    const pending = d.vars.filter((v) => v.pending);
    return `
      <div class="card panel-card stack-sm">
        <div class="row"><h2>.env</h2><span class="spacer"></span>
          <div class="seg" role="group" aria-label="View"><button type="button" data-mode="fields" class="${mode === 'fields' ? 'active' : ''}">Fields</button><button type="button" data-mode="text" class="${mode === 'text' ? 'active' : ''}">Text</button></div>
        </div>
        <p class="muted" style="margin:0"><span class="mono small">${esc(d.path)}</span><br>WebbMC reads this file when it starts, so saved changes apply after a restart. Real environment variables (set in the shell, pm2 or your host) win over it.</p>
        ${d.railway ? notice('<strong>On Railway, set variables in the service&#39;s Variables tab.</strong> A .env file here is lost on the next deploy.', 'warn') : ''}
        ${d.exists ? '' : notice('There is no .env file yet. Saving creates one from <span class="mono">.env.example</span>.')}
        ${
          pending.length
            ? `${notice(`<strong>Waiting for a restart:</strong> ${pending.map((v) => `<span class="mono">${esc(v.key)}</span>`).join(', ')}. The panel still runs with the values it started with.${d.restarts ? '' : ' Stop it (Ctrl+C) and run <span class="mono">node server.js</span> again to apply them.'}`, 'warn')}
               ${d.restarts ? `<div><button type="button" class="btn btn-accent" data-act="restart">${icon('restart')}Restart now</button></div>` : ''}`
            : ''
        }
      </div>`;
  }

  function fieldHtml(v) {
    const id = `env-${v.key}`;
    const tags = [
      v.overridden ? '<span class="tag warn" title="A real environment variable sets this, so the panel ignores the value in .env">set by the environment</span>' : '',
      v.pending ? '<span class="tag">restart to apply</span>' : '',
    ].join('');
    return `<div class="field env-field" data-key="${esc(v.key)}">
      <label for="${id}"><span class="mono">${esc(v.key)}</span>${tags}</label>
      <div class="input-group">
        <input class="input mono" id="${id}" name="${esc(v.key)}" type="${v.secret ? 'password' : 'text'}" value="${esc(v.value)}" placeholder="${esc(v.placeholder)}" autocomplete="off" spellcheck="false">
        ${v.secret ? `<button type="button" class="btn" data-reveal="${esc(v.key)}" style="height:40px">Show</button>` : ''}
        ${v.known ? '' : `<button type="button" class="icon-btn danger" data-remove="${esc(v.key)}" title="Remove ${esc(v.key)}" aria-label="Remove ${esc(v.key)}" style="height:40px;width:40px">${icon('trash')}</button>`}
      </div>
      ${v.hint ? `<span class="hint">${esc(v.hint)}</span>` : ''}
      ${v.overridden ? '<span class="hint" style="color:var(--warn)">Set by a real environment variable, which wins: editing it here does nothing.</span>' : ''}
      ${v.risky ? `<span class="hint" style="color:var(--warn)">${esc(v.risky)}</span>` : ''}
    </div>`;
  }

  function fieldsCard() {
    const shown = d.vars.filter((v) => v.known || v.inFile);
    return `
      <form class="card panel-card form" id="env-form" novalidate>
        ${ENV_GROUPS.map((g) => {
          const vars = shown.filter((v) => v.group === g);
          if (g !== 'Custom' && !vars.length) return '';
          return `<h3 class="env-group">${g === 'Custom' ? 'Other variables in the file' : esc(g)}</h3>
            <div class="form-grid" ${g === 'Custom' ? 'id="env-custom"' : ''}>${vars.map(fieldHtml).join('')}</div>
            ${g === 'Custom' ? `${vars.length ? '' : '<p class="faint small" id="env-none" style="margin:0">None yet.</p>'}
              <div class="env-add">
                <input class="input mono" id="env-new-key" placeholder="NEW_VARIABLE" autocomplete="off" spellcheck="false" aria-label="New variable name">
                <input class="input mono" id="env-new-value" placeholder="value" autocomplete="off" spellcheck="false" aria-label="New variable value">
                <button type="button" class="btn" data-act="add">${icon('plus')}Add</button>
              </div>` : ''}`;
        }).join('')}
        <div class="form-actions"><button class="btn btn-accent" type="submit">${icon('save')}Save .env</button></div>
      </form>`;
  }

  function textCard() {
    return `
      <form class="card panel-card form" id="env-text" novalidate>
        <div class="field">
          <label for="env-raw">The whole file</label>
          <textarea class="input" id="env-raw" rows="24" spellcheck="false" autocomplete="off">${esc(d.text)}</textarea>
          <span class="hint">Every line is <span class="mono">KEY=value</span>, a <span class="mono"># comment</span> or blank. This view shows secret values in plain text.</span>
        </div>
        <div class="form-actions"><button class="btn btn-accent" type="submit">${icon('save')}Save .env</button></div>
      </form>`;
  }

  function draw() {
    box.innerHTML = statusCard() + (mode === 'text' ? textCard() : fieldsCard());
    $('[data-act="restart"]', box)?.addEventListener('click', restart);
    $$('[data-mode]', box).forEach((b) =>
      b.addEventListener('click', async () => {
        if (b.dataset.mode === mode) return;
        if (dirty && !(await confirmBox('Discard your changes?', 'Switching views drops the changes you have not saved.', { confirmText: 'Discard' }))) return;
        mode = b.dataset.mode;
        pref.set('envMode', mode);
        dirty = false;
        draw();
      }),
    );
    box.addEventListener('input', () => (dirty = true), { once: true });
    if (mode === 'text') wireText();
    else wireFields();
  }

  function wireFields() {
    const form = $('#env-form', box);
    const removed = new Set();
    form.addEventListener('click', (e) => {
      const reveal = e.target.closest('[data-reveal]');
      if (reveal) {
        const input = form.elements[reveal.dataset.reveal];
        input.type = input.type === 'password' ? 'text' : 'password';
        reveal.textContent = input.type === 'password' ? 'Show' : 'Hide';
      }
      const rm = e.target.closest('[data-remove]');
      if (rm) {
        removed.add(rm.dataset.remove);
        rm.closest('.env-field').remove();
        dirty = true;
      }
      if (e.target.closest('[data-act="add"]')) {
        const key = $('#env-new-key', form).value.trim();
        const value = $('#env-new-value', form).value;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return toast('Names use letters, digits and _, and do not start with a digit', 'bad');
        if (form.elements[key]) return toast(`${key} is already on this page`, 'bad');
        removed.delete(key);
        $('#env-none', form)?.remove();
        $('#env-custom', form).insertAdjacentHTML('beforeend', fieldHtml({ key, value, known: false, secret: /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|API_?KEY/i.test(key), hint: 'New: saved with the others.' }));
        $('#env-new-key', form).value = '';
        $('#env-new-value', form).value = '';
        dirty = true;
      }
    });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const set = {};
      const changes = [];
      for (const field of $$('.env-field', form)) {
        const key = field.dataset.key;
        const value = form.elements[key].value;
        const was = d.vars.find((v) => v.key === key);
        if (!was || !was.inFile || value !== was.value) {
          if (!was?.inFile && value === '' && was) continue; // a known variable left blank stays out of the file
          set[key] = value;
          changes.push({ key, from: was?.value ?? '', to: value });
        }
      }
      if (!Object.keys(set).length && !removed.size) return toast('Nothing changed', 'info');
      if (!(await confirmRisky(changes))) return;
      try {
        saved(await api('PUT', '/api/env', { set, remove: [...removed] }));
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  }

  function wireText() {
    const form = $('#env-text', box);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = $('#env-raw', form).value;
      const changes = d.vars.filter((v) => v.risky && envValue(text, v.key) !== envValue(d.text, v.key)).map((v) => ({ key: v.key, to: envValue(text, v.key) }));
      if (!(await confirmRisky(changes))) return;
      try {
        saved(await api('PUT', '/api/env/text', { text }));
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  }

  load();
  return {};
}

function PanelSettings(root, args = []) {
  let stopPlayit = null;
  let usersTimer = null;
  if (!me().admin) {
    root.innerHTML = `<div class="card empty-state"><h2>Admins only</h2><p class="muted">Panel settings are managed by the panel admin.</p><a class="btn" href="#/">Back to dashboard</a></div>`;
    return {};
  }
  const tab = args[0] === 'env' ? 'env' : 'main';
  root.innerHTML = `
    <div class="page-head"><div><div class="eyebrow">Configure</div><h1>Panel settings</h1><p>Accounts, defaults for new servers and how the panel runs.</p></div></div>
    <nav class="tabs" style="margin-top:4px">
      <a href="#/settings" class="${tab === 'main' ? 'active' : ''}">${icon('cog')}Settings</a>
      <a href="#/settings/env" class="${tab === 'env' ? 'active' : ''}">${icon('file')}.env</a>
    </nav>
    <div class="stack" id="ps"><p class="muted">Loading...</p></div>`;
  if (tab === 'env') return renderEnv($('#ps', root));
  api('GET', '/api/settings').then(({ settings: s, info }) => {
    $('#ps', root).innerHTML = `
      <div class="card panel-card" id="ps-users"><h2>Accounts</h2><p class="muted">Loading...</p></div>
      <div class="card panel-card stack-sm" id="ps-playit"><h2>Public address with playit.gg</h2><p class="muted">Loading...</p></div>
      ${info.railway && !info.volume ? notice('<strong>No Railway volume is attached.</strong> Worlds and backups are wiped on every redeploy. Attach a volume to this service (any mount path).', 'warn') : ''}
      <form class="card panel-card form" id="ps-form" novalidate>
        <h2>General</h2>
        <div class="form-grid">
          <div class="field"><label>Panel name</label><input class="input" name="panelName" value="${esc(s.panelName)}" maxlength="40"></div>
          <div class="field"><label>Default Java executable</label><div class="input-group"><input class="input mono" name="javaPath" value="${esc(s.javaPath)}" list="java-list"><button type="button" class="btn" id="ps-test" style="height:40px">Test</button></div><span class="hint" id="ps-java">Used when a server's Minecraft version is unknown.</span></div>
          ${ramField('defaultMaxRam', 'Default max RAM', s.defaultMaxRam)}
          ${ramField('defaultMinRam', 'Default starting RAM', s.defaultMinRam)}
        </div>
        ${switchHtml('autoJava', s.autoJava !== false, 'Download the Java each server needs (Eclipse Temurin) when no installed Java matches its Minecraft version')}
        <div class="field"><label>Extra allowed hostnames</label><input class="input mono" name="allowedHosts" value="${esc((s.allowedHosts || []).join(', '))}" placeholder="mc.example.com, myserver.local">
          <span class="hint">IP addresses and localhost always work. Add a hostname here only if you reach the panel through one (DNS-rebinding protection).</span></div>
        <div class="form-actions"><button class="btn btn-accent" type="submit">${icon('save')}Save settings</button></div>
      </form>
      <div class="card panel-card stack-sm" id="ps-updates"><h2>Updates</h2><p class="muted">Loading...</p></div>
      <div class="card panel-card">
        <h2>About this panel</h2>
        <dl class="kv" style="margin-top:12px">
          <dt>Version</dt><dd>WebbMC ${esc(info.version)}</dd>
          <dt>Listening on</dt><dd class="mono">${esc(info.bind)}</dd>
          <dt>Data folder</dt><dd class="mono small">${esc(info.dataDir)}</dd>
          ${info.railway ? `<dt>Hosting</dt><dd>Railway${info.volume ? ` (volume at <span class="mono">${esc(info.volume)}</span>)` : ' (no volume attached)'}</dd>` : ''}
          <dt>Sign-in</dt><dd>${
            info.google
              ? `Username and password, or Google${info.adminEmails.length ? ` <span class="faint small">(admin emails: ${info.adminEmails.map(esc).join(', ')})</span>` : ''}`
              : 'Username and password <span class="faint small">(Google is off: <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> are blank)</span>'
          }</dd>
          <dt>Node.js</dt><dd>${esc(info.node)} (${esc(info.platform)})</dd>
          <dt>Time zone</dt><dd>${esc(info.timezone)}</dd>
        </dl>
        <p class="faint small" style="margin-top:14px">Change the address or port with <code>WEBMC_HOST</code> and <code>WEBMC_PORT</code> on the <a href="#/settings/env">.env</a> tab, then restart the panel.</p>
        <div class="row" style="margin-top:14px">
          <button type="button" class="btn" id="ps-restart" ${info.restarter ? '' : 'disabled'}>${icon('restart')}Restart WebbMC</button>
          <span class="faint small">${
            info.restarter === 'pm2'
              ? 'Stops the servers, and pm2 starts WebbMC again. Servers that were running start again too.'
              : info.restarter === 'helper'
                ? 'Stops the servers and starts WebbMC again. Servers that were running start again too.'
                : info.railway
                  ? 'On Railway, restart the service from Railway instead.'
                  : 'Nothing would start WebbMC again here: stop it (Ctrl+C) and run <code>node server.js</code>, or run it with pm2.'
          }</span>
        </div>
      </div>`;
    const form = $('#ps-form', root);
    wireRam(form);
    fillJavaList();
    renderUsers($('#ps-users', root), s, info);
    // New sign-ups, and changes made by another admin, show up without a reload (not while you type in the card).
    const usersCard = $('#ps-users', root);
    usersTimer = setInterval(async () => {
      if (document.hidden || $('.modal-backdrop') || usersCard.contains(document.activeElement) || $('#ps-add-id', usersCard)?.value) return;
      try {
        if (usersSig(await api('GET', '/api/users')) !== usersCard.dataset.sig) renderUsers(usersCard, (await api('GET', '/api/settings')).settings, info);
      } catch {
        /* try again next time */
      }
    }, 8000);
    stopPlayit = renderPlayit($('#ps-playit', root));
    renderUpdates($('#ps-updates', root)).then(() => {
      if (args[0] === 'updates') $('#ps-updates', root).scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const test = async () => {
      const j = await api('GET', `/api/java?path=${enc(form.elements.javaPath.value)}`);
      $('#ps-java', root).innerHTML = j.ok ? `Detected: <span class="mono">${esc(j.version)}</span>` : `<span style="color:var(--danger)">${esc(j.error)}</span>`;
    };
    $('#ps-test', root).onclick = test;
    test();
    $('#ps-restart', root).onclick = async () => {
      const running = (state.overview?.servers || []).filter((x) => x.pid).length;
      const ok = await confirmBox(
        'Restart WebbMC?',
        `WebbMC stops ${running ? `the ${running} running server${running === 1 ? '' : 's'} (players are disconnected)` : 'every server'} and restarts. Servers that were running start again afterwards. This page reloads when it is back.`,
        { danger: true, confirmText: 'Restart now' },
      );
      if (ok) await restartPanel('Restarting WebbMC', () => api('POST', '/api/restart'), true, 'WebbMC is restarting');
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const f = form.elements;
      try {
        await api('PUT', '/api/settings', {
          panelName: f.panelName.value,
          javaPath: f.javaPath.value,
          autoJava: f.autoJava.checked,
          defaultMaxRam: f.defaultMaxRam.value,
          defaultMinRam: f.defaultMinRam.value,
          allowedHosts: f.allowedHosts.value.split(',').map((x) => x.trim()).filter(Boolean),
        });
        toast('Panel settings saved', 'ok');
        poll();
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  });
  return {
    destroy: () => {
      stopPlayit?.();
      clearInterval(usersTimer);
    },
  };
}

// ================================================================ router + boot

let current = null;

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  closeMenu();
  if (parts[0] === 'server' && current?.serverId === parts[1] && findServer(parts[1])) {
    current.setTab(parts[2] || 'console');
    highlightNav();
    return;
  }
  if (parts[0] === 'status' && current?.statusPage) {
    current.show(parts.slice(1));
    return;
  }
  current?.destroy?.();
  current = null;
  const root = $('#view');
  root.innerHTML = '';
  window.scrollTo(0, 0);
  const views = { '': Dashboard, all: AllServers, ports: Ports, new: NewServer, status: StatusPage, activity: Activity, account: Account, settings: PanelSettings };
  const notFound = (msg) =>
    `<div class="card empty-state"><h2>Not found</h2><p class="muted">${esc(msg)}</p><a class="btn" href="#/">Back to dashboard</a></div>`;
  if (parts[0] === 'server') {
    if (findServer(parts[1])) current = ServerView(root, parts[1], parts[2] || 'console');
    else root.innerHTML = notFound('That server does not exist (it may have been deleted).');
  } else if (views[parts[0] || '']) current = views[parts[0] || ''](root, parts.slice(1));
  else root.innerHTML = notFound('There is no page at this address.');
  highlightNav();
}

/** The panel restarted with a new version: this page still runs the old code, so offer to load the new one. */
function offerReload() {
  if ($('#reload-bar')) return;
  const bar = document.createElement('div');
  bar.id = 'reload-bar';
  bar.className = 'reload-bar';
  bar.setAttribute('role', 'status');
  bar.innerHTML = `${icon('info')}<span><strong>WebbMC was updated.</strong> Reload to use the new version.</span><button type="button" class="btn btn-sm btn-accent">${icon('restart')}Reload</button>`;
  $('button', bar).onclick = () => location.reload();
  document.body.append(bar);
}

async function poll() {
  if (document.hidden && state.overview) return;
  try {
    state.overview = await api('GET', '/api/overview');
    state.build ||= state.overview.panel.build;
    if (state.overview.panel.build && state.overview.panel.build !== state.build) offerReload();
    if (!state.connected) {
      state.connected = true;
      toast('Reconnected to the panel', 'ok');
    }
    renderChrome();
    current?.update?.();
  } catch {
    if (state.updating) return;
    if (state.connected && state.overview) {
      state.connected = false;
      toast('Lost connection to the panel. Retrying...', 'bad');
    }
  }
}

(async function boot() {
  await poll();
  if (!state.overview) {
    $('#view').innerHTML = `<div class="card empty-state"><h2>Cannot reach the panel</h2><p class="muted">Is <code>node server.js</code> still running? Retrying...</p></div>`;
    const retry = setInterval(async () => {
      await poll();
      if (state.overview) {
        clearInterval(retry);
        route();
      }
    }, 3000);
  } else route();
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => !document.hidden && poll());
  setInterval(poll, 2500);
})();
