'use strict';
// Who is using the panel, and what they may touch.
//
// Everyone signs in with an account: a username and password, a linked Google account, or both. Google sign-in
// only exists when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set. Each account manages its own servers;
// admins manage every server and every account.
//
// Admins are accounts with the admin role (given in Panel settings, or by `node reset-admin.js` in a terminal on
// the server) plus accounts whose linked Google email is in WEBMC_ADMIN_EMAILS. While there is no admin at all,
// the first account created becomes one.
//
// An account's id (what a server's "owner" points at) is its username, or its Google email when it has no
// username. Usernames cannot contain "@", so the two never collide.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const store = require('./store');
const { httpError, readBody } = require('./util');

const CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE = Boolean(CLIENT_ID && CLIENT_SECRET);
const ADMINS = new Set(
  `${process.env.WEBMC_ADMIN_EMAILS || ''},${process.env.WEBMC_ADMIN_EMAIL || ''}`
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
const SESSION_COOKIE = 'webmc_session';
const STATE_COOKIE = 'webmc_oauth';
const CHANGE_COOKIE = 'webmc_newpw';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const OTP_MS = 24 * 60 * 60 * 1000; // a one-time password works for a day
const CHANGE_MS = 15 * 60 * 1000; // after using it, 15 minutes to pick the new password
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[a-z0-9_.-]{3,24}$/;
const MIN_PASSWORD = 8;
// One-time passwords made by `node reset-admin.js`. The panel may be running (and owns panel.json), so the
// terminal leaves them here and the panel picks them up.
const RESETS_FILE = path.join(store.DATA_DIR, 'password-resets.json');

// ---------------------------------------------------------------- signed cookies

/** Kept in the data folder so sign-ins survive restarts and redeploys (unless WEBMC_SESSION_SECRET is set). */
const SECRET = (() => {
  if (process.env.WEBMC_SESSION_SECRET) return process.env.WEBMC_SESSION_SECRET;
  const file = path.join(store.DATA_DIR, 'session-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
})();

const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const sign = (data) => {
  const body = Buffer.from(JSON.stringify(data)).toString('base64url');
  return `${body}.${hmac(body)}`;
};
function unsign(token) {
  const [body, sig] = String(token || '').split('.');
  if (!body || !sig) return null;
  const good = hmac(body);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return data.x > Date.now() ? data : null;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || Boolean(req.socket.encrypted);
const cookie = (req, name, value, maxAgeSec, cookiePath = '/') =>
  `${name}=${encodeURIComponent(value)}; Path=${cookiePath}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`;
/** The session also carries the account's password version, so changing a password signs out other browsers. */
const sessionCookie = (req, u) => cookie(req, SESSION_COOKIE, sign({ e: u.id, v: u.pv || 0, x: Date.now() + SESSION_MS }), SESSION_MS / 1000);
const changeCookie = (req, u) => cookie(req, CHANGE_COOKIE, sign({ e: u.id, v: u.pv || 0, x: Date.now() + CHANGE_MS }), CHANGE_MS / 1000, '/auth');

/** The address Google sends people back to. Must be listed in the OAuth client's authorized redirect URIs. */
function publicBase(req) {
  if (process.env.WEBMC_PUBLIC_URL) return process.env.WEBMC_PUBLIC_URL.replace(/\/+$/, '');
  return `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
}
const redirectUri = (req) => `${publicBase(req)}/auth/google/callback`;

// ---------------------------------------------------------------- accounts
// A record: { id, username?, name, password? (scrypt hash), google? { sub, email }, picture, admin? (role),
// status: 'approved' | 'pending' | 'blocked', pv (password version), otp? (expiry of a one-time password),
// mustChange?, firstSeen, lastSeen }

const normId = (s) => String(s || '').trim().toLowerCase();
const isAccountId = (id) => EMAIL_RE.test(id) || USERNAME_RE.test(id);
const users = () => store.state.users;
const findUser = (id) => users().find((u) => u.id === id);
/** What people type on the sign-in form: a username, or the email of a Google account that also has a password. */
const findLogin = (name) => users().find((u) => u.username === name) || users().find((u) => u.id === name && u.password);
const findByGoogle = (sub, email) =>
  users().find((u) => u.google?.sub && u.google.sub === sub) || users().find((u) => u.google && !u.google.sub && u.google.email === email);
const taken = (name, self) => users().some((o) => o !== self && (o.id === name || o.username === name));
const emailOf = (u) => u.google?.email || null;
/** Approved ahead of time by an admin, never used yet. */
const isPlaceholder = (u) => !u.password && !u.google?.sub && !u.firstSeen;
const envAdmin = (u) => Boolean(GOOGLE && u.google?.email && ADMINS.has(u.google.email));
const isAdminUser = (u) => Boolean(u && (u.admin === true || envAdmin(u)));
/** False on a fresh panel: then the first account created becomes the admin. */
const hasAdmin = () => (GOOGLE && ADMINS.size > 0) || users().some(isAdminUser);
const signups = () => (store.state.settings.signups === 'open' ? 'open' : 'approval');
const passwordSignups = () => store.state.settings.passwordSignups !== false;

// Older records had provider: 'google' | 'password' and an email field.
for (const u of store.state.users) {
  if (!u.id) u.id = u.email;
  if (u.provider === 'google' && !u.google) u.google = { sub: null, email: u.email || u.id };
  if (u.provider === 'password' && !u.username) u.username = u.id;
  delete u.provider;
  delete u.email;
}

function allowed(u) {
  if (!u) return false;
  if (isAdminUser(u)) return true;
  return u.status !== 'blocked' && (u.status === 'approved' || signups() === 'open');
}

function sessionUser(req) {
  const s = unsign(cookies(req)[SESSION_COOKIE]);
  const u = s?.e ? findUser(s.e) : null;
  return u && allowed(u) && (u.pv || 0) === (s.v || 0) ? u : null;
}

const userView = (u) => ({
  id: u.id,
  username: u.username || null,
  email: emailOf(u),
  name: u.name || u.username || u.id,
  picture: u.picture || '',
  admin: isAdminUser(u),
  google: Boolean(u.google),
  hasPassword: Boolean(u.password),
});

/** The signed-in user for this request, or null. */
function currentUser(req) {
  const u = sessionUser(req);
  if (!u) return null;
  if (Date.now() - (u.lastSeen || 0) > 5 * 60 * 1000) {
    u.lastSeen = Date.now();
    store.save();
  }
  return userView(u);
}

/** Admins see everything. Others see servers they own or that were shared with them; servers without an owner belong to the admins. */
const canManage = (user, cfg) => Boolean(user.admin || (user.id && (cfg.owner === user.id || cfg.shared?.includes(user.id))));
/** Deleting a server, and choosing who it is shared with, is for its owner and the admins. */
const isOwner = (user, cfg) => Boolean(user.admin || (user.id && cfg.owner === user.id));

/** The account id for a username, account id or Google email someone typed, for sharing a server. */
function accountId(nameIn) {
  const name = normId(nameIn);
  const u = findUser(name) || users().find((x) => x.username === name || emailOf(x) === name);
  if (!u || u.status === 'blocked') throw httpError(404, `There is no account called ${name || '(empty)'}`);
  return u.id;
}

/** When the signed-in account last opened its notifications. */
const notifSeen = (user) => findUser(user.id)?.notifSeen || 0;
function markNotifSeen(user) {
  const u = findUser(user.id);
  if (!u) return;
  u.notifSeen = Date.now();
  store.save();
}

function listUsers() {
  const servers = store.state.servers;
  const rows = users().map((u) => ({
    id: u.id,
    username: u.username || null,
    name: u.name || '',
    picture: u.picture || '',
    email: emailOf(u),
    hasPassword: Boolean(u.password),
    resetPending: Boolean(u.otp || u.mustChange),
    placeholder: isPlaceholder(u),
    admin: isAdminUser(u),
    adminFrom: envAdmin(u) ? 'env' : u.admin ? 'role' : null,
    status: isAdminUser(u) ? 'approved' : u.status,
    firstSeen: u.firstSeen || null,
    lastSeen: u.lastSeen || null,
    servers: servers.filter((c) => c.owner === u.id).length,
  }));
  // Admin emails that have not signed in yet
  if (GOOGLE) {
    for (const email of ADMINS) {
      if (users().some((u) => emailOf(u) === email)) continue;
      rows.push({ id: email, username: null, name: '', picture: '', email, hasPassword: false, resetPending: false, placeholder: true, admin: true, adminFrom: 'env', status: 'approved', firstSeen: null, lastSeen: null, servers: servers.filter((c) => c.owner === email).length });
    }
  }
  return rows.sort((a, b) => b.admin - a.admin || (b.status === 'pending') - (a.status === 'pending') || a.id.localeCompare(b.id));
}

/** Admin: approve or block an account. An email or username that has not signed up yet is approved ahead of time. */
function setUser(idIn, status) {
  const id = normId(idIn);
  if (!isAccountId(id)) throw httpError(400, 'Enter an email address or a username (3 to 24 letters, digits, dots, dashes or underscores)');
  if (!['approved', 'blocked'].includes(status)) throw httpError(400, 'Unknown account status');
  let u = findUser(id) || users().find((x) => emailOf(x) === id);
  if (isAdminUser(u) || (!u && GOOGLE && ADMINS.has(id))) throw httpError(400, 'Admins can always sign in. Take away their admin role first.');
  if (!u) {
    if (EMAIL_RE.test(id) && !GOOGLE) throw httpError(400, 'Google sign-in is not set up, so an email address cannot sign in. Enter a username instead.');
    users().push((u = EMAIL_RE.test(id) ? { id, google: { sub: null, email: id }, firstSeen: null } : { id, username: id, name: id, firstSeen: null }));
  }
  u.status = status;
  store.save();
  store.logActivity(null, `${u.id} ${status === 'approved' ? 'can now sign in' : 'was blocked from signing in'}`);
  return listUsers();
}

/** Admin: give or take away the admin role. Admins from WEBMC_ADMIN_EMAILS can only be changed there. */
function setAdmin(idIn, on, actor) {
  const u = findUser(normId(idIn));
  if (!u) throw httpError(404, 'No account with that name');
  if (on) {
    if (isPlaceholder(u)) throw httpError(400, 'They have to sign in once before they can be made an admin');
    Object.assign(u, { admin: true, status: 'approved' });
  } else {
    if (envAdmin(u)) throw httpError(400, `${emailOf(u)} is an admin because it is in WEBMC_ADMIN_EMAILS. Remove it there and restart the panel.`);
    if (!users().some((o) => o !== u && isAdminUser(o))) throw httpError(400, 'The panel needs at least one admin. Make someone else an admin first.');
    delete u.admin;
    u.status = 'approved';
  }
  store.save();
  store.logActivity(null, `${actor.id} ${on ? 'made' : 'took away admin from'} ${u.id}${on ? ' an admin' : ''}`);
  return listUsers();
}

function removeUser(idIn, actor) {
  const u = findUser(normId(idIn));
  if (!u) return listUsers();
  if (u.id === actor.id) throw httpError(400, 'You cannot remove your own account');
  if (isAdminUser(u)) throw httpError(400, 'Take away their admin role before removing the account');
  store.state.users = users().filter((x) => x !== u);
  for (const c of store.state.servers) if (c.shared?.includes(u.id)) c.shared = c.shared.filter((s) => s !== u.id);
  store.save();
  store.logActivity(null, `Removed the account ${u.id}. Its servers were kept.`);
  return listUsers();
}

const pendingUsers = () => users().filter((u) => u.status === 'pending' && !isAdminUser(u) && !isPlaceholder(u));
const pendingCount = () => pendingUsers().length;

// ---------------------------------------------------------------- passwords

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function checkPassword(password, stored) {
  const [kind, N, r, p, salt, hash] = String(stored || '').split('$');
  if (kind !== 'scrypt') {
    await hashPassword(password); // same time either way, so response times do not reveal which usernames exist
    return false;
  }
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(key, expected);
}

function checkNewPassword(password, username = '') {
  const pw = String(password || '');
  if (pw.length < MIN_PASSWORD) throw httpError(400, `Use at least ${MIN_PASSWORD} characters for the password`);
  if (pw.length > 200) throw httpError(400, 'That password is too long');
  if (username && pw.toLowerCase() === username.toLowerCase()) throw httpError(400, 'The password cannot be the same as the username');
  return pw;
}

function checkNewUsername(display, self) {
  const name = normId(display);
  if (!USERNAME_RE.test(name)) throw httpError(400, 'Usernames are 3 to 24 characters: letters, digits, dots, dashes and underscores');
  if (taken(name, self)) throw httpError(409, 'That username is taken. Pick another one.');
  return name;
}

// Easy to read out loud: no 0/o, 1/l/i.
const OTP_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
const makeOtp = () =>
  Array.from({ length: 3 }, () => Array.from({ length: 4 }, () => OTP_CHARS[crypto.randomInt(OTP_CHARS.length)]).join('')).join('-');

/** Replaces the password with a one-time one. Signs the account out everywhere. */
async function setOneTimePassword(u) {
  const otp = makeOtp();
  Object.assign(u, { password: await hashPassword(otp), otp: Date.now() + OTP_MS, pv: (u.pv || 0) + 1 });
  delete u.mustChange;
  return otp;
}

/** Admin: a one-time password for someone who forgot theirs. They choose a new one when they sign in with it. */
async function resetPassword(idIn, actor) {
  const u = findUser(normId(idIn));
  if (!u || isPlaceholder(u)) throw httpError(404, 'That account has not been set up yet');
  if (u.id === actor.id) throw httpError(400, 'Change your own password on the Account page');
  const otp = await setOneTimePassword(u);
  store.save();
  store.logActivity(null, `${actor.id} made a one-time password for ${u.id}`);
  return { otp, login: u.username || u.id, users: listUsers() };
}

/**
 * `node reset-admin.js [username]`: makes a one-time password for an admin account (or creates one) and leaves it
 * in RESETS_FILE for the panel. Runs in its own process, so it never writes panel.json.
 */
async function terminalReset(nameIn) {
  const name = normId(nameIn);
  let u = null;
  let create = false;
  if (name) {
    u = findLogin(name) || findUser(name) || null;
    if (!u) {
      if (!USERNAME_RE.test(name)) throw new Error(`There is no account "${name}", and it cannot be a new username (3 to 24 letters, digits, dots, dashes or underscores).`);
      create = true;
    }
  } else {
    const admins = users().filter(isAdminUser);
    if (admins.length > 1) {
      throw new Error(`There is more than one admin. Pick one:\n${admins.map((a) => `  node reset-admin.js ${a.username || a.id}`).join('\n')}`);
    }
    u = admins[0] || null;
    if (!u) {
      if (taken('admin')) throw new Error('There is no admin yet, and the username "admin" is taken. Run: node reset-admin.js <new username>');
      create = true;
    }
  }
  const id = u ? u.id : name || 'admin';
  const otp = makeOtp();
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(RESETS_FILE, 'utf8'));
  } catch {
    /* none waiting */
  }
  list = (Array.isArray(list) ? list : []).filter((e) => e.id !== id);
  list.push({ id, create, hash: await hashPassword(otp), expires: Date.now() + OTP_MS });
  fs.writeFileSync(RESETS_FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
  return { login: u ? u.username || u.id : id, otp, created: create, promoted: Boolean(u && !isAdminUser(u)) };
}

/** Picks up one-time passwords left by `node reset-admin.js`. Called at startup and before each password sign-in. */
function applyResets() {
  let list;
  try {
    list = JSON.parse(fs.readFileSync(RESETS_FILE, 'utf8'));
  } catch {
    return;
  }
  fs.rmSync(RESETS_FILE, { force: true });
  for (const e of Array.isArray(list) ? list : []) {
    if (!e?.id || !e.hash || !(e.expires > Date.now())) continue;
    let u = findUser(e.id);
    if (!u) {
      if (!e.create || !USERNAME_RE.test(e.id)) continue;
      users().push((u = { id: e.id, username: e.id, name: e.id, firstSeen: Date.now() }));
    }
    Object.assign(u, { password: e.hash, otp: e.expires, pv: (u.pv || 0) + 1, admin: true, status: 'approved' });
    delete u.mustChange;
    store.logActivity(null, `A one-time admin password for ${u.id} was made in a terminal on the server`);
  }
  store.save();
}

// Wrong passwords: 10 per IP and 20 per account in 15 minutes. New accounts: 5 per IP per hour.
const limits = new Map(); // key -> { count, since }
function overLimit(key, max, windowMs) {
  const f = limits.get(key);
  return Boolean(f && Date.now() - f.since < windowMs && f.count >= max);
}
function bump(key, windowMs) {
  const f = limits.get(key);
  limits.set(key, f && Date.now() - f.since < windowMs ? { count: f.count + 1, since: f.since } : { count: 1, since: Date.now() });
}
const FAIL_WINDOW = 15 * 60 * 1000;
const REGISTER_WINDOW = 60 * 60 * 1000;

/** Login and registration forms must come from this panel (no login CSRF from other sites). */
function sameOrigin(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readForm(req) {
  return new URLSearchParams((await readBody(req, 8192)).toString('utf8'));
}

const redirect = (res, location, setCookie) => {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...(setCookie ? { 'Set-Cookie': setCookie } : {}) });
  res.end();
};

async function passwordLogin(req, res, clientIp) {
  if (!sameOrigin(req)) throw httpError(403, 'Cross-origin request blocked');
  applyResets();
  const form = await readForm(req);
  const name = normId(form.get('username'));
  const ip = clientIp(req);
  const show = (error) => sendLogin(req, res, { error, username: name });
  if (overLimit(`ip:${ip}`, 10, FAIL_WINDOW) || overLimit(`user:${name}`, 20, FAIL_WINDOW)) {
    return show('Too many wrong passwords. Wait 15 minutes and try again.');
  }
  const u = name ? findLogin(name) : null;
  // One-time passwords are lowercase; forgive capitals and stray spaces when typing one in.
  const password = u?.otp ? String(form.get('password') || '').trim().toLowerCase() : form.get('password') || '';
  if (!(await checkPassword(password, u?.password))) {
    bump(`ip:${ip}`, FAIL_WINDOW);
    bump(`user:${name}`, FAIL_WINDOW);
    return show('That username and password do not match.');
  }
  limits.delete(`user:${name}`);
  if (u.otp) {
    if (u.otp < Date.now()) {
      u.password = null;
      delete u.otp;
      store.save();
      return show('That one-time password has expired. Ask for a new one.');
    }
    // Used up now: the next page asks for the new password.
    u.password = null;
    delete u.otp;
    u.mustChange = true;
    u.pv = (u.pv || 0) + 1;
    store.save();
    return sendNewPassword(req, res, u, { setCookie: changeCookie(req, u) });
  }
  if (!allowed(u)) return sendLogin(req, res, { pending: u.id, blocked: u.status === 'blocked' });
  u.lastSeen = Date.now();
  store.save();
  redirect(res, '/', sessionCookie(req, u));
}

/** The page after signing in with a one-time password. */
async function finishNewPassword(req, res) {
  if (!sameOrigin(req)) throw httpError(403, 'Cross-origin request blocked');
  const s = unsign(cookies(req)[CHANGE_COOKIE]);
  const u = s?.e ? findUser(s.e) : null;
  const clear = cookie(req, CHANGE_COOKIE, '', 0, '/auth');
  if (!u || !u.mustChange || (u.pv || 0) !== s.v) {
    return sendLogin(req, res, { error: 'That page timed out and the one-time password is used up. Ask for a new one.', setCookie: clear });
  }
  const form = await readForm(req);
  const show = (error) => sendNewPassword(req, res, u, { error });
  if (form.get('password') !== form.get('confirm')) return show('The two passwords are different.');
  let pw;
  try {
    pw = checkNewPassword(form.get('password'), u.username || '');
  } catch (err) {
    return show(err.message);
  }
  Object.assign(u, { password: await hashPassword(pw), pv: (u.pv || 0) + 1, lastSeen: Date.now() });
  delete u.mustChange;
  store.save();
  if (!allowed(u)) return sendLogin(req, res, { pending: u.id, blocked: u.status === 'blocked', setCookie: clear });
  redirect(res, '/', [clear, sessionCookie(req, u)]);
}

async function register(req, res, clientIp) {
  if (!sameOrigin(req)) throw httpError(403, 'Cross-origin request blocked');
  const form = await readForm(req);
  const display = String(form.get('username') || '').trim();
  const username = normId(display);
  const show = (error) => sendLogin(req, res, { view: 'register', error, username: display });
  const ip = clientIp(req);
  if (overLimit(`register:${ip}`, 5, REGISTER_WINDOW)) return show('Too many new accounts from this network. Try again later.');
  if (!USERNAME_RE.test(username)) return show('Usernames are 3 to 24 characters: letters, digits, dots, dashes and underscores.');
  let u = findUser(username) || users().find((x) => x.username === username);
  // A username the admin approved ahead of time has a record but no password yet: whoever registers it claims it.
  const claim = Boolean(u && u.username === username && !u.google && isPlaceholder(u));
  if (u && !claim) return show('That username is taken. Pick another one.');
  if (!claim && !passwordSignups() && hasAdmin()) {
    return show(GOOGLE ? 'Creating accounts with a username and password is turned off. Sign in with Google instead.' : 'Creating accounts is turned off. Ask the panel admin.');
  }
  if (form.get('password') !== form.get('confirm')) return show('The two passwords are different.');
  let pw;
  try {
    pw = checkNewPassword(form.get('password'), username);
  } catch (err) {
    return show(err.message);
  }
  bump(`register:${ip}`, REGISTER_WINDOW);
  const hash = await hashPassword(pw);
  if (!claim && taken(username)) return show('That username is taken. Pick another one.');
  const first = !hasAdmin();
  if (!u) users().push((u = { id: username, username, status: signups() === 'open' ? 'approved' : 'pending' }));
  Object.assign(u, { name: display, password: hash, firstSeen: Date.now(), lastSeen: Date.now() });
  if (first) Object.assign(u, { admin: true, status: 'approved' });
  store.save();
  if (!allowed(u)) {
    store.logActivity(null, `${username} created an account and is waiting for approval. Approve them in Panel settings.`);
    return sendLogin(req, res, { pending: username });
  }
  store.logActivity(null, first ? `${username} created the first account and is the panel admin` : `${username} created an account`);
  redirect(res, '/', sessionCookie(req, u));
}

// ---------------------------------------------------------------- the Account page (signed-in users, JSON API)

const recordOf = (user) => {
  const u = findUser(user.id);
  if (!u) throw httpError(401, 'Sign in first');
  return u;
};

function accountInfo(user) {
  const u = recordOf(user);
  return {
    ...userView(u),
    googleAvailable: GOOGLE,
    adminFrom: envAdmin(u) ? 'env' : u.admin ? 'role' : null,
    firstSeen: u.firstSeen || null,
    servers: store.state.servers.filter((c) => c.owner === u.id).length,
  };
}

/** A new username is also the account's new id, so servers and favorites move with it. */
function rename(u, id) {
  const old = u.id;
  for (const c of store.state.servers) {
    if (c.owner === old) c.owner = id;
    if (c.shared?.includes(old)) c.shared = c.shared.map((s) => (s === old ? id : s));
  }
  for (const f of store.state.favorites) if (f.owner === old) f.owner = id;
  Object.assign(u, { id, username: id });
  store.logActivity(null, `${old} is now called ${id}`);
}

function updateAccount(req, res, user, body) {
  const u = recordOf(user);
  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 60);
    if (!name) throw httpError(400, 'Enter a display name');
    u.name = name;
  }
  if (body.username != null && normId(body.username) !== (u.username || '')) {
    if (!u.username) throw httpError(400, 'Add a username together with a password');
    rename(u, checkNewUsername(body.username, u));
    res.setHeader('Set-Cookie', sessionCookie(req, u));
  }
  store.save();
  return accountInfo(u);
}

/** Change the password, or (for a Google account without one) add a username and password. */
async function setOwnPassword(req, res, user, body) {
  const u = recordOf(user);
  let newName = null;
  if (u.password) {
    if (!(await checkPassword(String(body.current || ''), u.password))) throw httpError(400, 'Your current password is not right');
  } else if (!u.username) {
    newName = checkNewUsername(body.username, u);
  }
  const hash = await hashPassword(checkNewPassword(body.next, u.username || newName));
  if (newName) rename(u, checkNewUsername(newName, u));
  Object.assign(u, { password: hash, pv: (u.pv || 0) + 1 });
  delete u.otp;
  delete u.mustChange;
  store.save();
  res.setHeader('Set-Cookie', sessionCookie(req, u));
  return accountInfo(u);
}

function unlinkGoogle(user) {
  const u = recordOf(user);
  if (!u.google) throw httpError(400, 'No Google account is linked');
  if (!u.username || !u.password) throw httpError(400, 'Add a username and password first, or you would have no way to sign in');
  // Someone who was an admin through WEBMC_ADMIN_EMAILS stays one.
  if (envAdmin(u)) u.admin = true;
  const email = emailOf(u);
  delete u.google;
  u.picture = '';
  store.save();
  store.logActivity(null, `${u.id} unlinked the Google account ${email}`);
  return accountInfo(u);
}

function signOutEverywhere(req, res, user) {
  const u = recordOf(user);
  u.pv = (u.pv || 0) + 1;
  store.save();
  res.setHeader('Set-Cookie', sessionCookie(req, u));
  return accountInfo(u);
}

// ---------------------------------------------------------------- Google sign-in (and linking)

function startGoogle(req, res, link) {
  // Linking adds Google to the account that is signed in now.
  const linkTo = link ? sessionUser(req) : null;
  if (link && !linkTo) return redirect(res, '/');
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  const st = { s: state, v: verifier, x: Date.now() + 10 * 60 * 1000, ...(linkTo ? { l: linkTo.id } : {}) };
  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${q}`,
    'Set-Cookie': cookie(req, STATE_COOKIE, sign(st), 600, '/auth'),
    'Cache-Control': 'no-store',
  });
  res.end();
}

async function finishGoogle(req, res, query) {
  const st = unsign(cookies(req)[STATE_COOKIE]);
  const clearState = cookie(req, STATE_COOKIE, '', 0, '/auth');
  const linking = Boolean(st?.l);
  // Linking happens from the Account page, so its outcome is shown there.
  const fail = (message, code = 'google-failed') => (linking ? redirect(res, `/#/account/${code}`, clearState) : sendLogin(req, res, { error: message, setCookie: clearState }));
  if (query.get('error')) return fail(query.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : `Google said: ${query.get('error')}`, 'google-cancelled');
  if (!st || st.s !== query.get('state')) return fail('That sign-in link expired. Please try again.');

  let info;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: query.get('code') || '',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri(req),
        grant_type: 'authorization_code',
        code_verifier: st.v,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) throw new Error(token.error_description || token.error || `HTTP ${tokenRes.status}`);
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!infoRes.ok) throw new Error(`HTTP ${infoRes.status} from Google`);
    info = await infoRes.json();
  } catch (err) {
    console.error('[webbmc] Google sign-in failed:', err.message);
    return fail(`Google sign-in failed: ${err.message}`);
  }
  const sub = String(info.sub || '');
  const email = normId(info.email);
  if (!sub || !email || info.email_verified === false) return fail('Your Google account has no verified email address.', 'google-unverified');
  const picture = /^https:\/\//.test(info.picture || '') ? info.picture : '';
  const found = findByGoogle(sub, email);

  if (linking) {
    const me = sessionUser(req);
    if (!me || me.id !== st.l) return fail('', 'google-failed');
    if (found && found !== me) {
      if (!isPlaceholder(found)) return fail('', 'google-in-use');
      store.state.users = users().filter((x) => x !== found); // an approval ahead of time for this email; not needed now
    }
    Object.assign(me, { google: { sub, email }, picture });
    store.save();
    store.logActivity(null, `${me.id} linked the Google account ${email}`);
    return redirect(res, '/#/account/google-linked', clearState);
  }

  let u = found;
  const isNew = !u;
  if (!u) {
    if (findUser(email)) return fail('That email is already used by another account.');
    const first = !hasAdmin();
    u = { id: email, status: first || (GOOGLE && ADMINS.has(email)) || signups() === 'open' ? 'approved' : 'pending', firstSeen: Date.now() };
    if (first) u.admin = true;
    users().push(u);
  }
  Object.assign(u, { google: { sub, email }, picture, lastSeen: Date.now() });
  if (!u.name) u.name = String(info.name || '').slice(0, 60);
  u.firstSeen ||= Date.now();
  delete u.mustChange;
  store.save();

  if (!allowed(u)) {
    if (isNew) store.logActivity(null, `${email} asked to sign in. Approve them in Panel settings.`);
    return sendLogin(req, res, { pending: email, blocked: u.status === 'blocked', setCookie: clearState });
  }
  if (isNew) store.logActivity(null, u.admin ? `${email} signed in first and is the panel admin` : `${email} signed in for the first time`);
  res.writeHead(302, { Location: '/', 'Set-Cookie': [clearState, sessionCookie(req, u)], 'Cache-Control': 'no-store' });
  res.end();
}

// ---------------------------------------------------------------- pages

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const GOOGLE_G =
  '<svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

function sendPage(res, { status, title, heading, sub, body, setCookie = null }) {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  const panelName = store.state.settings.panelName || 'WebbMC';
  res.writeHead(status, headers);
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#120a2f">
<title>${escHtml(title)} · ${escHtml(panelName)}</title><link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/static/app.css">
<style>.unlock{min-height:100vh;display:grid;place-items:center;padding:16px}.unlock .card{width:min(420px,100%);padding:28px;display:grid;gap:18px}.unlock .brand{padding:0}
.google{display:flex;align-items:center;justify-content:center;gap:12px;height:44px;border-radius:10px;background:#fff;color:#1f1f1f;font:600 14px var(--font-body);text-decoration:none!important;border:1px solid #dadce0}
.google:hover{background:#f2f2f2}.or{display:flex;align-items:center;gap:12px;color:var(--faint);font-size:12px}.or::before,.or::after{content:"";flex:1;height:1px;background:var(--line)}</style></head>
<body><div class="bg-mesh" aria-hidden="true"></div><div class="bg-grid" aria-hidden="true"></div>
<main class="unlock"><div class="card">
<span class="brand"><img src="/static/favicon.svg" alt="" width="34" height="34"><span class="brand-name">${
    panelName === 'WebbMC' ? 'Webb<span class="text-gradient">MC</span>' : escHtml(panelName)
  }</span></span>
<div><h2>${escHtml(heading)}</h2><p class="muted" style="margin-top:6px">${sub}</p></div>
${body}
</div></main></body></html>`);
}

const noticeHtml = (html, warn) => `<div class="notice ${warn ? 'warn' : ''}" ${warn ? 'role="alert"' : ''}><div>${html}</div></div>`;

/** The sign-in page (view "signin") or the create-an-account page (view "register"). */
function sendLogin(req, res, { view = 'signin', error = '', pending = '', blocked = false, username = '', setCookie = null } = {}) {
  const register = view === 'register';
  const setup = !hasAdmin();
  const message = pending
    ? noticeHtml(
        blocked
          ? `<strong>${escHtml(pending)}</strong> is not allowed to use this panel.`
          : `<strong>Almost there.</strong> The account <strong>${escHtml(pending)}</strong> is waiting for the panel admin to approve it. Sign in again once they have.`,
        blocked,
      )
    : error
      ? noticeHtml(escHtml(error), true)
      : setup
        ? noticeHtml('<strong>New panel.</strong> Nobody is the admin yet, so the first account created here becomes the panel admin.')
        : '';
  const canRegister = passwordSignups() || setup;
  const fields = register
    ? `<form class="form" method="post" action="/auth/register" style="gap:12px">
        <div class="field"><label for="u">Username</label><input class="input" id="u" name="username" value="${escHtml(username)}" minlength="3" maxlength="24" pattern="[A-Za-z0-9_.\\-]{3,24}" autocomplete="username" required autofocus>
          <span class="hint">3 to 24 letters, digits, dots, dashes or underscores.</span></div>
        <div class="field"><label for="p">Password</label><input class="input" id="p" name="password" type="password" minlength="${MIN_PASSWORD}" autocomplete="new-password" required>
          <span class="hint">At least ${MIN_PASSWORD} characters.</span></div>
        <div class="field"><label for="c">Confirm password</label><input class="input" id="c" name="confirm" type="password" minlength="${MIN_PASSWORD}" autocomplete="new-password" required></div>
        <button class="btn btn-accent" type="submit">Create account</button>
      </form>
      <p class="muted small" style="text-align:center">Already have an account? <a href="/auth/login">Sign in</a></p>`
    : `<form class="form" method="post" action="/auth/login" style="gap:12px">
        <div class="field"><label for="u">Username</label><input class="input" id="u" name="username" value="${escHtml(username)}" autocomplete="username" required ${username ? '' : 'autofocus'}></div>
        <div class="field"><label for="p">Password</label><input class="input" id="p" name="password" type="password" autocomplete="current-password" required ${username ? 'autofocus' : ''}>
          <span class="hint">Forgot it? Ask the panel admin for a one-time password.</span></div>
        <button class="btn btn-accent" type="submit">Sign in</button>
      </form>
      <p class="muted small" style="text-align:center">${
        canRegister ? 'New here? <a href="/auth/register">Create an account</a>' : 'Did the admin approve a username for you? <a href="/auth/register">Create it</a>'
      }</p>`;
  const google = GOOGLE ? `<a class="google" href="/auth/google">${GOOGLE_G}${register ? 'Sign up' : 'Sign in'} with Google</a><div class="or">or with a username</div>` : '';
  sendPage(res, {
    status: pending || error ? 403 : 401,
    title: register ? 'Create an account' : 'Sign in',
    heading: register ? 'Create an account' : 'Sign in',
    sub: register ? (GOOGLE ? 'Pick a username and password, or use your Google account.' : 'Pick a username and password.') : 'Sign in to manage your Minecraft servers.',
    body: `${message}${google}${fields}`,
    setCookie,
  });
}

function sendNewPassword(req, res, u, { error = '', setCookie = null } = {}) {
  sendPage(res, {
    status: error ? 400 : 200,
    title: 'Choose a new password',
    heading: 'Choose a new password',
    sub: `The one-time password for <strong>${escHtml(u.username || u.id)}</strong> is used up. Pick the password you will sign in with from now on.`,
    body: `${error ? noticeHtml(escHtml(error), true) : ''}
      <form class="form" method="post" action="/auth/new-password" style="gap:12px">
        <input type="hidden" name="username" value="${escHtml(u.username || u.id)}" autocomplete="username">
        <div class="field"><label for="p">New password</label><input class="input" id="p" name="password" type="password" minlength="${MIN_PASSWORD}" autocomplete="new-password" required autofocus>
          <span class="hint">At least ${MIN_PASSWORD} characters.</span></div>
        <div class="field"><label for="c">Confirm new password</label><input class="input" id="c" name="confirm" type="password" minlength="${MIN_PASSWORD}" autocomplete="new-password" required></div>
        <button class="btn btn-accent" type="submit">Save and sign in</button>
      </form>`,
    setCookie,
  });
}

/** Everything under /auth/. Returns true when it handled the request. */
async function handle(req, res, url, clientIp) {
  const p = url.pathname;
  const get = req.method === 'GET';
  const post = req.method === 'POST';
  if (get && p === '/auth/login') return (sessionUser(req) ? redirect(res, '/') : sendLogin(req, res)), true;
  if (get && p === '/auth/register') return sendLogin(req, res, { view: 'register' }), true;
  if (post && p === '/auth/login') return await passwordLogin(req, res, clientIp), true;
  if (post && p === '/auth/register') return await register(req, res, clientIp), true;
  if (post && p === '/auth/new-password') return await finishNewPassword(req, res), true;
  if (GOOGLE && get && p === '/auth/google') return startGoogle(req, res, url.searchParams.get('link') === '1'), true;
  if (GOOGLE && get && p === '/auth/google/callback') return await finishGoogle(req, res, url.searchParams), true;
  if (post && p === '/auth/logout') {
    if (req.headers['x-webmc'] !== '1') throw httpError(403, 'Missing X-WebMC header');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie(req, SESSION_COOKIE, '', 0) });
    return res.end('{"ok":true}'), true;
  }
  return false;
}

module.exports = {
  GOOGLE,
  ADMINS,
  isAccountId,
  normId,
  currentUser,
  canManage,
  isOwner,
  accountId,
  notifSeen,
  markNotifSeen,
  handle,
  sendLogin,
  listUsers,
  setUser,
  setAdmin,
  removeUser,
  resetPassword,
  terminalReset,
  applyResets,
  pendingCount,
  pendingUsers,
  hasAdmin,
  accountInfo,
  updateAccount,
  setOwnPassword,
  unlinkGoogle,
  signOutEverywhere,
  redirectUri,
};
