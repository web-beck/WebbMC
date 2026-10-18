'use strict';
// The .env file next to server.js, for Panel settings > .env. Edits keep the file's comments and the order of its
// lines. Node reads .env once at startup (server.js), so changes apply after the panel restarts, and real environment
// variables (Railway's Variables tab, pm2, the shell) always win over the file.
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { httpError } = require('./util');

const FILE = path.join(store.ROOT, '.env');
const EXAMPLE = path.join(store.ROOT, '.env.example');
const ON_RAILWAY = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);

// The variables WebbMC reads, in the order the page shows them. secret: masked on the page. risky: what can go wrong.
const KNOWN = [
  { key: 'GOOGLE_CLIENT_ID', group: 'Sign-in', hint: 'Turns on Google sign-in together with the secret. Leave both blank for usernames and passwords only.' },
  { key: 'GOOGLE_CLIENT_SECRET', group: 'Sign-in', secret: true, hint: 'The secret of the Google OAuth client above.' },
  { key: 'WEBMC_ADMIN_EMAILS', group: 'Sign-in', hint: 'Google emails that are always admins, comma-separated. Needs Google sign-in.', placeholder: 'you@gmail.com' },
  {
    key: 'WEBMC_SESSION_SECRET',
    group: 'Sign-in',
    secret: true,
    hint: 'Signs sign-in cookies. Normally left blank: the panel keeps one in the data folder.',
    risky: 'Changing it signs everyone out, you included.',
  },
  { key: 'WEBMC_PUBLIC_URL', group: 'Address', hint: 'The address people open the panel at. Used for Google sign-in, and its hostname is allowed automatically.', placeholder: 'https://mc.example.com' },
  { key: 'WEBMC_ALLOWED_HOSTS', group: 'Address', hint: 'Other hostnames that may reach the panel, comma-separated. IP addresses and localhost always work.', placeholder: 'mc.example.com' },
  { key: 'WEBMC_PORT', group: 'Address', hint: 'The web app port. 8420 when blank.', placeholder: '8420', risky: 'After the restart the panel answers on the new port only, so open it there.' },
  {
    key: 'WEBMC_HOST',
    group: 'Address',
    hint: '127.0.0.1 = this machine only (the default), 0.0.0.0 = every network interface.',
    placeholder: '127.0.0.1',
    risky: 'A wrong address can make the panel unreachable after the restart.',
  },
  {
    key: 'WEBMC_DATA',
    group: 'Storage',
    hint: 'Where servers, backups and accounts are kept. ./data when blank.',
    placeholder: './data',
    risky: 'The panel switches to the other folder: the servers and accounts in the current one disappear from the panel (the files stay). In an empty folder there is no admin, and the first account created becomes one.',
  },
  { key: 'GITHUB_TOKEN', group: 'Other', secret: true, hint: 'Raises GitHub limits for plugin installs, and allows update checks from a private repository on Railway.' },
  { key: 'WEBMC_JAVA_PATHS', group: 'Other', hint: 'Extra Java executables to offer in the Java fields, comma-separated.' },
  {
    key: 'WEBMC_WEBHOOK_SECRET',
    group: 'Other',
    secret: true,
    hint: 'Turns on the GitHub push webhook, so new commits show up in the bell right away. Use the same value as the secret in the repository\'s webhook settings.',
  },
  { key: 'WEBMC_PLAYIT_SOCKET', group: 'Other', hint: 'Where a playit you installed yourself listens, if you start it with its own --socket-path. WebbMC looks in the usual place otherwise.' },
  { key: 'WEBMC_NO_SUPERVISOR', group: 'Other', hint: 'Set to 1 to run without the restart helper (updates then stop the panel instead of restarting it).', placeholder: '1' },
];
const KNOWN_KEYS = new Map(KNOWN.map((k) => [k.key, k]));
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_RE = /SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|API_?KEY/i;

let systemKeys = new Set(); // real environment variables when the panel started (.env cannot change these)
let startup = {}; // what the panel runs with: process.env right after .env was read

/** Called by server.js: `system` is the set of variable names that existed before .env was read. */
function init(system) {
  systemKeys = system;
  startup = { ...process.env };
}

/** KEY and value of an assignment line, the way Node's .env reader sees it, or null for comments and blank lines. */
function parseLine(line) {
  const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (!m) return null;
  let v = m[2].trim();
  const q = v[0];
  if (q === '"' || q === "'" || q === '`') {
    const end = v.indexOf(q, 1);
    if (end > 0) {
      v = v.slice(1, end);
      return { key: m[1], value: q === '"' ? v.replace(/\\n/g, '\n') : v };
    }
  }
  const hash = v.indexOf('#');
  if (hash >= 0) v = v.slice(0, hash).trim();
  return { key: m[1], value: v };
}

/** A commented-out example such as "# WEBMC_PORT=8420", which an edit replaces rather than adding a second line. */
const commentedKey = (line) => /^\s*#\s*([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)?.[1] || null;

/** The value written after KEY=, quoted when Node would otherwise change it (spaces at the ends, #, quotes). */
function quote(v) {
  if (/[\r\n]/.test(v)) throw httpError(400, 'A value cannot span more than one line');
  if (!/[\s#"'`\\]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  if (!v.includes('"') && !v.includes('\\n')) return `"${v}"`;
  if (!v.includes('`')) return `\`${v}\``;
  throw httpError(400, 'A value cannot contain all three kinds of quotes');
}

function readText() {
  try {
    return fs.readFileSync(FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Writes the whole file in one step. It holds secrets, so only its owner (the panel's user) can read it. */
function writeText(text) {
  const mode = 0o600;
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text.endsWith('\n') || !text ? text : `${text}\n`, { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, FILE);
}

function fileValues(text) {
  const values = new Map(); // the last assignment wins, as in Node
  for (const line of (text || '').split(/\r?\n/)) {
    const p = parseLine(line);
    if (p) values.set(p.key, p.value);
  }
  return values;
}

function describe(key, value, inFile) {
  const k = KNOWN_KEYS.get(key);
  const fromSystem = systemKeys.has(key);
  const running = startup[key] ?? '';
  return {
    key,
    value: value ?? '',
    inFile,
    known: Boolean(k),
    group: k?.group || 'Custom',
    hint: k?.hint || '',
    placeholder: k?.placeholder || '',
    risky: k?.risky || '',
    secret: Boolean(k?.secret || (!k && SECRET_RE.test(key))),
    // A real environment variable wins over .env, so editing the file does nothing for it.
    overridden: fromSystem,
    // Saved, but the panel still runs with the value it started with.
    pending: !fromSystem && (value ?? '') !== running,
  };
}

function status() {
  const text = readText();
  const values = fileValues(text);
  const vars = KNOWN.map((k) => describe(k.key, values.get(k.key), values.has(k.key)));
  for (const [key, value] of values) if (!KNOWN_KEYS.has(key)) vars.push(describe(key, value, true));
  // A variable removed from the file still runs until the restart.
  for (const key of Object.keys(startup)) {
    if (!values.has(key) && !systemKeys.has(key) && !KNOWN_KEYS.has(key)) vars.push(describe(key, undefined, false));
  }
  return {
    path: FILE,
    exists: text !== null,
    railway: ON_RAILWAY,
    restarts: require('./supervisor').restartsOnExit(), // something starts the panel again after it exits
    text: text ?? '',
    vars,
    pending: vars.some((v) => v.pending),
  };
}

/** Field edits: set { KEY: value } and remove [KEY]. Returns the names that changed. */
function update(body) {
  const set = body.set && typeof body.set === 'object' ? body.set : {};
  const remove = Array.isArray(body.remove) ? body.remove.map(String) : [];
  for (const key of [...Object.keys(set), ...remove]) if (!KEY_RE.test(key)) throw httpError(400, `"${key}" is not a valid variable name (letters, digits and _, not starting with a digit)`);
  let text = readText();
  if (text === null) text = fs.existsSync(EXAMPLE) ? fs.readFileSync(EXAMPLE, 'utf8') : ''; // start from the documented example
  const before = fileValues(text);
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const pending = new Map(Object.entries(set).map(([k, v]) => [k, `${k}=${quote(String(v ?? ''))}`]));
  const drop = new Set(remove);
  const out = [];
  // Replace the last assignment of each key (the one Node uses) and drop the others, so the file has one line per key.
  const lastIndex = new Map();
  lines.forEach((line, i) => {
    const p = parseLine(line);
    if (p) lastIndex.set(p.key, i);
  });
  lines.forEach((line, i) => {
    const p = parseLine(line);
    if (p && (pending.has(p.key) || drop.has(p.key))) {
      if (pending.has(p.key) && lastIndex.get(p.key) === i) {
        out.push(pending.get(p.key));
        pending.delete(p.key);
      }
      return;
    }
    out.push(line);
  });
  // Keys that are not in the file yet: fill in their commented-out example line, or add them at the end.
  for (const [key, line] of [...pending]) {
    const at = out.findIndex((l) => commentedKey(l) === key);
    if (at >= 0) {
      out[at] = line;
      pending.delete(key);
    }
  }
  if (pending.size) out.push(...(out.length && out[out.length - 1].trim() ? [''] : []), ...pending.values());
  const next = `${out.join('\n')}\n`;
  const after = fileValues(next);
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
  if (changed.length) writeText(next);
  return changed;
}

/** The whole file as text. Every line must be blank, a # comment or KEY=value. Returns the names that changed. */
function replaceText(text) {
  text = String(text ?? '').replace(/\r\n/g, '\n');
  if (text.length > 64 * 1024) throw httpError(400, 'The file is too large');
  text.split('\n').forEach((line, i) => {
    if (!line.trim() || /^\s*#/.test(line) || parseLine(line)) return;
    throw httpError(400, `Line ${i + 1} is not KEY=value or a # comment: ${line.slice(0, 60)}`);
  });
  const before = fileValues(readText());
  const after = fileValues(text);
  writeText(text);
  return [...new Set([...before.keys(), ...after.keys()])].filter((k) => before.get(k) !== after.get(k));
}

module.exports = { init, status, update, replaceText, parseLine, quote, FILE };
