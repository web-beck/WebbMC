'use strict';
// What a server folder runs, and where its settings live: server.properties for Minecraft servers, velocity.toml
// for Velocity, and the first listener in config.yml for BungeeCord (and forks such as Waterfall).
const fs = require('fs');
const path = require('path');
const properties = require('./properties');
const zip = require('./zip');

const PROXIES = ['velocity', 'bungeecord'];

const read = (dir, file) => {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8');
  } catch {
    return null;
  }
};
const exists = (dir, file) => fs.existsSync(path.join(dir, file));

/** 'vanilla' (Vanilla, Fabric, Forge...), 'spigot' (Spigot, Paper, Purpur...), 'velocity' or 'bungeecord'. */
function kindOf(cfg) {
  if (PROXIES.includes(cfg.type)) return cfg.type;
  if (cfg.type === 'paper' || cfg.type === 'purpur') return 'spigot';
  if (cfg.type === 'vanilla' || cfg.type === 'fabric') return 'vanilla';
  // A custom jar or an imported folder: go by its files, then by the jar's name.
  if (exists(cfg.dir, 'velocity.toml')) return 'velocity';
  if (/^listeners:/m.test(read(cfg.dir, 'config.yml') || '')) return 'bungeecord';
  if (exists(cfg.dir, 'bukkit.yml') || exists(cfg.dir, 'spigot.yml') || exists(cfg.dir, path.join('config', 'paper-global.yml'))) return 'spigot';
  if (/velocity/i.test(cfg.jar || '')) return 'velocity';
  if (/bungee|waterfall/i.test(cfg.jar || '')) return 'bungeecord';
  if (/paper|purpur|spigot|bukkit|folia/i.test(cfg.jar || '')) return 'spigot';
  return 'vanilla';
}
const isProxy = (cfg) => PROXIES.includes(kindOf(cfg));

// ---------------------------------------------------------------- BungeeCord config.yml (just the bits we need)

/** Lines of the "listeners:" section: from the line after "listeners:" up to the next top-level key. */
function listenersRange(lines) {
  const start = lines.findIndex((l) => /^listeners:\s*$/.test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^[^\s#-]/.test(lines[end])) end++;
  return { start: start + 1, end };
}

/** The first listener's `key:` line, plus the lines that continue its value (indented deeper than the key). */
function firstItem(lines) {
  const range = listenersRange(lines);
  if (!range) return null;
  const startAt = lines.slice(range.start, range.end).findIndex((l) => /^\s*-\s+\S/.test(l));
  if (startAt < 0) return null;
  const start = range.start + startAt;
  const marker = /^(\s*)-(\s+)/.exec(lines[start]);
  const dashCol = marker[1].length;
  let end = start + 1;
  // The item ends where the next "- " at the same column (the second listener) begins.
  while (end < range.end && !(new RegExp(`^\\s{${dashCol}}-\\s`).test(lines[end]) && lines[end].search(/-/) === dashCol)) end++;
  return { start, end, keyCol: marker[0].length };
}

function findYamlKey(lines, key) {
  const item = firstItem(lines);
  if (!item) return null;
  const re = new RegExp(`^(\\s*(?:-\\s+)?)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(.*)$`);
  for (let i = item.start; i < item.end; i++) {
    const m = re.exec(lines[i]);
    if (!m || m[1].length !== item.keyCol) continue; // a nested key with the same name does not count
    let j = i + 1;
    while (j < item.end && (lines[j].trim() === '' || lines[j].search(/\S/) > item.keyCol)) j++;
    while (j > i + 1 && lines[j - 1].trim() === '') j--;
    return { index: i, end: j, prefix: m[1], rest: m[2] };
  }
  return null;
}

/** Decode a YAML scalar the way BungeeCord (SnakeYAML) writes them: plain, 'single', "double" or a | block. */
function yamlScalar(rest, more) {
  const first = rest.trim();
  if (/^[|>][+-]?\s*$/.test(first)) {
    const indent = Math.min(...more.filter((l) => l.trim()).map((l) => l.search(/\S/)));
    const body = more.map((l) => l.slice(indent));
    return first[0] === '|' ? body.join('\n').replace(/\n+$/, '') : body.join(' ').trim();
  }
  const joined = [first, ...more.map((l) => l.trim())];
  if (first.startsWith("'")) {
    const text = joined.reduce((acc, l, i) => (i === 0 ? l : l === '' ? `${acc}\n` : `${acc}${acc.endsWith('\n') ? '' : ' '}${l}`), '');
    return text.replace(/^'|'$/g, '').replace(/''/g, "'");
  }
  if (first.startsWith('"')) {
    let text = '';
    joined.forEach((l, i) => {
      if (i === 0) text = l;
      else if (text.endsWith('\\')) text = text.slice(0, -1) + l;
      else text += l === '' ? '\n' : ` ${l}`;
    });
    return JSON.parse(text.replace(/\\x([0-9a-fA-F]{2})/g, '\\u00$1').replace(/\\U([0-9a-fA-F]{8})/g, (_, h) => {
      const cp = Number.parseInt(h, 16);
      return JSON.stringify(String.fromCodePoint(cp)).slice(1, -1);
    }));
  }
  return joined.join(' ').trim();
}

/** A double-quoted YAML scalar, ASCII only so the file's encoding never matters. */
const yamlQuote = (s) =>
  `"${[...String(s)]
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (ch === '\\') return '\\\\';
      if (ch === '"') return '\\"';
      if (ch === '\n') return '\\n';
      if (cp >= 0x20 && cp < 0x7f) return ch;
      return cp > 0xffff ? `\\U${cp.toString(16).padStart(8, '0')}` : `\\u${cp.toString(16).padStart(4, '0')}`;
    })
    .join('')}"`;

function bungeeGet(text, key) {
  const lines = String(text).split(/\r?\n/);
  const at = findYamlKey(lines, key);
  return at ? yamlScalar(at.rest, lines.slice(at.index + 1, at.end)) : null;
}

/** Replace (or add) a key of the first listener. Returns the new file text, or null when there is no listener. */
function bungeeSet(text, key, value) {
  const lines = String(text).split(/\r?\n/);
  const at = findYamlKey(lines, key);
  const encoded = typeof value === 'number' ? String(value) : yamlQuote(value);
  if (at) {
    lines.splice(at.index, at.end - at.index, `${at.prefix}${key}: ${encoded}`);
    return lines.join('\n');
  }
  const item = firstItem(lines);
  if (!item) return null;
  lines.splice(item.start + 1, 0, `${' '.repeat(item.keyCol)}${key}: ${encoded}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- Velocity velocity.toml

/** A TOML basic ("...") or literal ('...') string. */
function tomlString(raw) {
  const v = String(raw).trim();
  if (v.startsWith("'")) return v.slice(1, v.lastIndexOf("'"));
  if (!v.startsWith('"')) return v;
  let out = '';
  for (let i = 1; i < v.length; i++) {
    const ch = v[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const n = v[++i];
    const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }[n];
    if (simple !== undefined) out += simple;
    else if (n === 'u' || n === 'U') {
      const len = n === 'u' ? 4 : 8;
      out += String.fromCodePoint(Number.parseInt(v.slice(i + 1, i + 1 + len), 16));
      i += len;
    } else out += n;
  }
  return out;
}

const tomlQuote = (s) =>
  `"${[...String(s)]
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (ch === '\\') return '\\\\';
      if (ch === '"') return '\\"';
      if (ch === '\n') return '\\n';
      if (cp < 0x20 || cp === 0x7f) return `\\u${cp.toString(16).padStart(4, '0')}`;
      return ch;
    })
    .join('')}"`;

// Top-level keys only: they come before the first [table] header.
function tomlRange(lines) {
  const end = lines.findIndex((l) => /^\s*\[/.test(l));
  return end < 0 ? lines.length : end;
}
function velocityGet(text, key) {
  const lines = String(text).split(/\r?\n/);
  const re = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`);
  for (let i = 0; i < tomlRange(lines); i++) {
    const m = re.exec(lines[i]);
    if (m) return tomlString(m[1].replace(/\s+#[^"']*$/, ''));
  }
  return null;
}
function velocitySet(text, key, value) {
  const lines = String(text).split(/\r?\n/);
  const encoded = typeof value === 'number' ? String(value) : tomlQuote(value);
  const re = new RegExp(`^(\\s*)${key}\\s*=`);
  const end = tomlRange(lines);
  for (let i = 0; i < end; i++) {
    if (re.test(lines[i])) {
      lines[i] = `${lines[i].match(re)[1]}${key} = ${encoded}`;
      return lines.join('\n');
    }
  }
  lines.splice(end, 0, `${key} = ${encoded}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- per-server facts

const splitHostPort = (addr, fallbackPort) => {
  const m = /^\[?([^\]]*?)\]?(?::(\d+))?$/.exec(String(addr || '').trim());
  return { ip: m?.[1] || '0.0.0.0', port: Number(m?.[2]) || fallbackPort };
};

/** Where the server listens and how many players it shows, read from its own config file. */
function info(cfg) {
  const kind = kindOf(cfg);
  if (kind === 'velocity') {
    const text = read(cfg.dir, 'velocity.toml') || '';
    const { ip, port } = splitHostPort(velocityGet(text, 'bind'), 25565);
    return { kind, proxy: true, ip, port, maxPlayers: Number(velocityGet(text, 'show-max-players')) || 0, configFile: 'velocity.toml' };
  }
  if (kind === 'bungeecord') {
    const text = read(cfg.dir, 'config.yml') || '';
    const { ip, port } = splitHostPort(bungeeGet(text, 'host'), 25577);
    return { kind, proxy: true, ip, port, maxPlayers: Number(bungeeGet(text, 'max_players')) || 0, configFile: 'config.yml' };
  }
  const props = readProps(cfg);
  return {
    kind,
    proxy: false,
    ip: props['server-ip'] || '0.0.0.0',
    port: Number(props['server-port']) || 25565,
    maxPlayers: Number(props['max-players']) || 0,
    configFile: 'server.properties',
  };
}

function readProps(cfg) {
  return properties.parse(read(cfg.dir, 'server.properties') || '');
}

/** The console command that shuts the server down cleanly. */
const stopCommand = (cfg) => (kindOf(cfg) === 'bungeecord' ? 'end' : 'stop');

/**
 * A first config for a new proxy, so it listens on the chosen port. Velocity gets its own default file (read from
 * the jar, comments included); BungeeCord fills in everything we leave out on its first start.
 */
async function initProxyConfig(cfg, { port, maxPlayers }) {
  if (cfg.type === 'velocity' && !exists(cfg.dir, 'velocity.toml')) {
    const def = await zip.readEntry(path.join(cfg.dir, cfg.jar), 'default-velocity.toml').catch(() => null);
    let text = def ? def.toString('utf8') : '';
    text = velocitySet(text, 'bind', `0.0.0.0:${port}`);
    if (maxPlayers) text = velocitySet(text, 'show-max-players', maxPlayers);
    fs.writeFileSync(path.join(cfg.dir, 'velocity.toml'), text);
    return true;
  }
  if (cfg.type === 'bungeecord' && !exists(cfg.dir, 'config.yml')) {
    fs.writeFileSync(
      path.join(cfg.dir, 'config.yml'),
      `# Created by WebMC. BungeeCord adds every other setting with its default value on the first start.\nlisteners:\n- host: 0.0.0.0:${port}\n  max_players: ${maxPlayers || 100}\n  motd: "&1Another Bungee server"\n`,
    );
    return true;
  }
  return false;
}

module.exports = { PROXIES, kindOf, isProxy, info, readProps, stopCommand, initProxyConfig, bungeeGet, bungeeSet, velocityGet, velocitySet };
