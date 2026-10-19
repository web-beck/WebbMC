'use strict';
// The servers a proxy sends players to, edited in the Properties tab: Velocity's [servers] (with "try", the order
// players are placed in) and [forced-hosts] in velocity.toml, BungeeCord's "servers:" and the first listener's
// "priorities" in config.yml. Only those entries are rewritten; comments and every other setting stay as they are.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const cfgtree = require('./cfgtree');
const software = require('./software');
const files = require('./files');
const { httpError } = require('./util');

const hash = (text) => crypto.createHash('sha1').update(text).digest('hex');
const spaces = (s) => /^\s*/.exec(s)[0].length;
const ADDRESS = /^(\[[0-9a-fA-F:.]+\]|[^\s:[\]]+)(:\d{1,5})?$/;

// ---------------------------------------------------------------- Velocity (velocity.toml)

function velocityRead(text) {
  const items = cfgtree.parse(text, 'velocity.toml').filter((x) => x.kind === 'value' && x.path.length === 2);
  return {
    servers: items.filter((x) => x.path[0] === 'servers' && x.path[1] !== 'try' && x.type === 'string').map((x) => ({ name: x.path[1], address: x.value })),
    try: items.find((x) => x.path[0] === 'servers' && x.path[1] === 'try')?.value || [],
    forced: items.filter((x) => x.path[0] === 'forced-hosts' && x.type === 'list').map((x) => ({ host: x.path[1], servers: x.value })),
  };
}

const tomlKey = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
const tomlList = (key, list) => (list.length ? [`${key} = [`, ...list.map((v) => `    ${JSON.stringify(v)},`), ']'] : [`${key} = []`]);

/**
 * Replace the entries of a TOML table that `owns` picks with `fresh` lines, where the first of them was (or after
 * `after`'s last entry, or below the table's opening comments). Other lines, comments included, stay.
 */
function replaceInTable(text, table, owns, fresh, after) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const items = cfgtree.parse(text, 'x.toml');
  const header = items.find((x) => x.kind === 'section' && x.path.length === 1 && x.path[0] === table);
  if (!header) {
    if (!fresh.length) return text;
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push('', `[${table}]`, ...fresh, '');
    return lines.join(eol);
  }
  const inTable = items.filter((x) => x.kind === 'value' && x.path.length === 2 && x.path[0] === table);
  const mine = inTable.filter(owns);
  let at;
  if (mine.length) at = mine[0].line;
  else {
    const before = after ? inTable.filter(after) : [];
    at = before.length ? before[before.length - 1].end + 1 : header.line + 1;
    if (!before.length) while (at < lines.length && /^\s*#/.test(lines[at])) at++;
  }
  for (const x of [...mine].sort((a, b) => b.line - a.line)) lines.splice(x.line, x.end - x.line + 1);
  lines.splice(at, 0, ...fresh);
  return lines.join(eol);
}

function velocityWrite(text, d) {
  let out = replaceInTable(text, 'servers', (x) => x.path[1] !== 'try', d.servers.map((s) => `${tomlKey(s.name)} = ${JSON.stringify(s.address)}`));
  out = replaceInTable(out, 'servers', (x) => x.path[1] === 'try', tomlList('try', d.try), (x) => x.path[1] !== 'try');
  return replaceInTable(out, 'forced-hosts', () => true, d.forced.flatMap((f) => tomlList(JSON.stringify(f.host), f.servers)));
}

// ---------------------------------------------------------------- BungeeCord (config.yml)

/** The first listener's lines: { start, end, keyCol }, keyCol being where its keys start. */
function firstListener(lines) {
  const li = lines.findIndex((l) => /^listeners:\s*$/.test(l));
  if (li < 0) return null;
  let k = li + 1;
  while (k < lines.length && (!lines[k].trim() || /^\s*#/.test(lines[k]))) k++;
  const m = /^(\s*)-\s+\S/.exec(lines[k] || '');
  if (!m) return null;
  const keyCol = m[1].length + 2;
  let end = k + 1;
  while (end < lines.length && (!lines[end].trim() || spaces(lines[end]) >= keyCol)) end++;
  while (end > k + 1 && !lines[end - 1].trim()) end--; // blank lines after it are not part of it
  return { start: k, end, keyCol };
}

/** Where the listener's "priorities" list is: { line, end } (end exclusive), or null. */
function prioritiesAt(lines, l) {
  for (let i = l.start + 1; i < l.end; i++) {
    if (spaces(lines[i]) !== l.keyCol || !/^\s*priorities:\s*$/.test(lines[i])) continue;
    let end = i + 1;
    while (end < l.end && (!lines[end].trim() || (/^\s*-\s/.test(lines[end]) && spaces(lines[end]) >= l.keyCol) || spaces(lines[end]) > l.keyCol)) end++;
    return { line: i, end };
  }
  return null;
}

function bungeeRead(text) {
  const items = cfgtree.parse(text, 'config.yml');
  const servers = items
    .filter((x) => x.kind === 'section' && x.path.length === 2 && x.path[0] === 'servers')
    .map((sec) => {
      const fields = items.filter((x) => x.kind === 'value' && x.path.length === 3 && x.path[0] === 'servers' && x.path[1] === sec.path[1]);
      const get = (k) => fields.find((x) => x.path[2] === k)?.value;
      return {
        name: sec.path[1],
        address: String(get('address') ?? ''),
        motd: String(get('motd') ?? ''),
        restricted: get('restricted') === true,
        extra: fields.filter((x) => !['address', 'motd', 'restricted'].includes(x.path[2])).map((x) => [x.path[2], x.type === 'list' ? null : x.value]).filter(([, v]) => v !== null),
      };
    });
  const lines = text.split(/\r?\n/);
  const l = firstListener(lines);
  const pr = l && prioritiesAt(lines, l);
  const tries = pr ? lines.slice(pr.line + 1, pr.end).map((x) => /^\s*-\s+(.*)$/.exec(x)?.[1]).filter(Boolean).map((v) => String(cfgtree.decode(v.trim(), false).value)) : [];
  return { servers, try: tries, forced: null };
}

const yamlValue = (v) => (typeof v === 'boolean' || typeof v === 'number' ? String(v) : /^-?\d+(\.\d+)?$/.test(String(v)) ? String(v) : cfgtree.encodeString(v, '', false));

function bungeeWrite(text, d, current) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // The listener's priorities first (lower in the file than "servers:" in BungeeCord's own layout, but either way works
  // as each step finds its lines again).
  const l = firstListener(lines);
  if (!l) throw httpError(400, 'config.yml has no listener yet. Start the proxy once so BungeeCord writes its config, then try again.');
  const pad = ' '.repeat(l.keyCol);
  const fresh = [`${pad}priorities:`, ...d.try.map((n) => `${pad}- ${yamlValue(n)}`)];
  const pr = prioritiesAt(lines, l);
  if (pr) lines.splice(pr.line, pr.end - pr.line, ...fresh);
  else lines.splice(l.end, 0, ...fresh);
  // Then the servers block, rebuilt (BungeeCord writes it without comments).
  const block = d.servers.flatMap((s) => {
    const extra = current.servers.find((c) => c.name === s.name)?.extra || [];
    return [
      `  ${yamlValue(s.name)}:`,
      `    motd: ${yamlValue(s.motd ?? '')}`,
      `    address: ${yamlValue(s.address)}`,
      `    restricted: ${Boolean(s.restricted)}`,
      ...extra.map(([k, v]) => `    ${k}: ${yamlValue(v)}`),
    ];
  });
  const si = lines.findIndex((x) => /^servers:\s*(\{\s*\})?\s*$/.test(x));
  if (si < 0) lines.push('servers:', ...block);
  else {
    let end = si + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s/.test(lines[end]))) end++;
    lines.splice(si, end - si, block.length ? 'servers:' : 'servers: {}', ...block);
  }
  return lines.join(eol);
}

// ---------------------------------------------------------------- shared

function where(inst) {
  const kind = software.kindOf(inst.cfg);
  if (kind !== 'velocity' && kind !== 'bungeecord') throw httpError(400, 'This server is not a proxy');
  const file = kind === 'velocity' ? 'velocity.toml' : 'config.yml';
  return { kind, file, abs: files.resolveIn(inst.dir, file) };
}

/** The proxy's servers, start order and forced hosts, plus Velocity's forwarding secret for setting up Paper. */
async function read(inst) {
  const w = where(inst);
  const text = await fsp.readFile(w.abs, 'utf8').catch(() => null);
  if (text == null) return { kind: w.kind, file: w.file, exists: false };
  const data = w.kind === 'velocity' ? velocityRead(text) : bungeeRead(text);
  let secret = null;
  if (w.kind === 'velocity') {
    const rel = software.velocityGet(text, 'forwarding-secret-file') || 'forwarding.secret';
    secret = await fsp
      .readFile(files.resolveIn(inst.dir, rel), 'utf8')
      .then((s) => s.trim().slice(0, 500) || null)
      .catch(() => null);
  }
  return { kind: w.kind, file: w.file, exists: true, hash: hash(text), ...data, servers: data.servers.map(({ extra, ...s }) => s), secret };
}

/** Save { hash, servers, try, forced }. Names must be unique, addresses host:port, and the start order known names. */
async function save(inst, body) {
  const w = where(inst);
  const text = await fsp.readFile(w.abs, 'utf8').catch(() => {
    throw httpError(400, `${w.file} does not exist yet. Start the proxy once so it writes it.`);
  });
  if (hash(text) !== body.hash) throw httpError(409, `${w.file} changed since you opened it. Reload to see it as it is now.`);
  const NAME = w.kind === 'velocity' ? /^[A-Za-z0-9_.-]{1,64}$/ : /^[A-Za-z0-9_-]{1,64}$/;
  const servers = (Array.isArray(body.servers) ? body.servers : []).slice(0, 500).map((s) => ({
    name: String(s?.name ?? '').trim(),
    address: String(s?.address ?? '').trim(),
    motd: String(s?.motd ?? ''),
    restricted: Boolean(s?.restricted),
  }));
  const names = new Set();
  for (const s of servers) {
    if (!NAME.test(s.name) || s.name === 'try') throw httpError(400, `"${s.name || '(empty)'}" cannot be a server name: use letters, digits, - and _`);
    if (names.has(s.name)) throw httpError(400, `There are two servers called ${s.name}`);
    names.add(s.name);
    if (!ADDRESS.test(s.address)) throw httpError(400, `${s.name}: the address must look like 127.0.0.1:25566`);
    if (/[\r\n]/.test(s.motd)) throw httpError(400, `${s.name}: the MOTD must be one line`);
  }
  const tries = [...new Set((Array.isArray(body.try) ? body.try : []).map(String))];
  for (const n of tries) if (!names.has(n)) throw httpError(400, `${n} is in the start order but is not one of the servers`);
  const forced = w.kind !== 'velocity' ? [] : (Array.isArray(body.forced) ? body.forced : []).map((f) => ({ host: String(f?.host ?? '').trim().toLowerCase(), servers: [...new Set((f?.servers || []).map(String))] }));
  for (const f of forced) {
    if (!/^[a-z0-9.-]+$/.test(f.host)) throw httpError(400, `"${f.host || '(empty)'}" is not a host name like play.example.com`);
    for (const n of f.servers) if (!names.has(n)) throw httpError(400, `${f.host} sends players to ${n}, which is not one of the servers`);
  }
  const d = { servers, try: tries, forced };
  const next = w.kind === 'velocity' ? velocityWrite(text, d) : bungeeWrite(text, d, bungeeRead(text));
  if (next !== text) await fsp.writeFile(w.abs, next);
  return { changed: next !== text, ...(await read(inst)) };
}

module.exports = { read, save, velocityRead, velocityWrite, bungeeRead, bungeeWrite };
