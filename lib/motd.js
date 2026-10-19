'use strict';
// The server-list message (MOTD) in each server type's own format. The editor uses one syntax for all of them:
// "&" codes (&c red, &l bold, &r reset...) with &#rrggbb for hex colors, the syntax most plugins use. It is
// converted on the way in and out:
//   vanilla     server.properties "motd" with § codes. No hex colors: they become the nearest of the 16 colors.
//   spigot      server.properties "motd" with § codes and §x§r§r§g§g§b§b hex colors (Minecraft 1.16 and newer).
//   bungeecord  the first listener's "motd" in config.yml, with & codes and &x&r&r&g&g&b&b hex colors.
//   velocity    "motd" in velocity.toml, in MiniMessage (<red>, <bold>, <#rrggbb>, <gradient>...).
const fs = require('fs');
const path = require('path');
const properties = require('./properties');
const software = require('./software');
const { httpError } = require('./util');

const COLORS = {
  0: '000000', 1: '0000aa', 2: '00aa00', 3: '00aaaa', 4: 'aa0000', 5: 'aa00aa', 6: 'ffaa00', 7: 'aaaaaa',
  8: '555555', 9: '5555ff', a: '55ff55', b: '55ffff', c: 'ff5555', d: 'ff55ff', e: 'ffff55', f: 'ffffff',
};
const NAMES = {
  black: '0', dark_blue: '1', dark_green: '2', dark_aqua: '3', dark_red: '4', dark_purple: '5', gold: '6', gray: '7',
  dark_gray: '8', blue: '9', green: 'a', aqua: 'b', red: 'c', light_purple: 'd', yellow: 'e', white: 'f',
};
const CODE_NAME = Object.fromEntries(Object.entries(NAMES).map(([n, c]) => [c, n]));
const FORMATS = { l: 'bold', o: 'italic', n: 'underlined', m: 'strikethrough', k: 'obfuscated' };
const FORMAT_CODE = Object.fromEntries(Object.entries(FORMATS).map(([c, n]) => [n, c]));
const MINI_FORMATS = {
  bold: 'bold', b: 'bold', italic: 'italic', i: 'italic', em: 'italic', underlined: 'underlined', u: 'underlined',
  strikethrough: 'strikethrough', st: 'strikethrough', obfuscated: 'obfuscated', obf: 'obfuscated',
};

// ---------------------------------------------------------------- runs: [{ text, color, bold, italic, ... }]
// color is a 6-digit hex string or null (the default gray).

const sameStyle = (a, b) => a.color === b.color && Object.values(FORMATS).every((f) => Boolean(a[f]) === Boolean(b[f]));

function pushRun(runs, text, style) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && sameStyle(last, style)) last.text += text;
  else runs.push({ ...style, text });
}

/** "&" syntax (or § codes) to runs. */
function parseAmp(src) {
  const runs = [];
  let style = { color: null };
  const re = /[&§]#([0-9a-f]{6})|[&§]x((?:[&§][0-9a-f]){6})|[&§]([0-9a-fk-or])/gi;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    pushRun(runs, src.slice(last, m.index), style);
    last = re.lastIndex;
    if (m[1] || m[2]) style = { color: (m[1] || m[2].replace(/[&§]/g, '')).toLowerCase() };
    else {
      const c = m[3].toLowerCase();
      if (COLORS[c]) style = { color: COLORS[c] }; // a color also ends bold, italic and the rest
      else if (c === 'r') style = { color: null };
      else style = { ...style, [FORMATS[c]]: true };
    }
  }
  pushRun(runs, src.slice(last), style);
  return runs;
}

const hexToRgb = (h) => [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
function nearestCode(hex) {
  const [r, g, b] = hexToRgb(hex);
  let best = 'f';
  let dist = Infinity;
  for (const [code, h] of Object.entries(COLORS)) {
    const [r2, g2, b2] = hexToRgb(h);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < dist) [best, dist] = [code, d];
  }
  return best;
}

/**
 * Runs back to codes. `hex` is how a hex color is written: '&#' (editor), '§x' (Spigot), '&x' (BungeeCord), or
 * null to use the nearest standard color.
 */
function toCodes(runs, { prefix = '&', hex = '&#' } = {}) {
  let out = '';
  let cur = { color: null };
  const colorCode = (color) => {
    if (color == null) return `${prefix}r`;
    const named = Object.entries(COLORS).find(([, h]) => h === color)?.[0];
    if (named) return `${prefix}${named}`;
    if (!hex) return `${prefix}${nearestCode(color)}`;
    if (hex === '&#') return `&#${color}`;
    const p = hex[0];
    return `${p}x${[...color].map((d) => `${p}${d}`).join('')}`;
  };
  for (const run of runs) {
    if (!sameStyle(run, cur)) {
      const dropsFormat = Object.values(FORMATS).some((f) => cur[f] && !run[f]);
      if (run.color !== cur.color || dropsFormat) {
        out += colorCode(run.color);
        cur = { color: run.color };
      }
      for (const [code, f] of Object.entries(FORMATS)) {
        if (run[f] && !cur[f]) {
          out += `${prefix}${code}`;
          cur[f] = true;
        }
      }
    }
    out += run.text;
  }
  return out;
}

// ---------------------------------------------------------------- MiniMessage

const hsvHex = (h) => {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (1 - Math.max(0, Math.min(k, 4 - k, 1))));
  };
  return [f(5), f(3), f(1)].map((v) => v.toString(16).padStart(2, '0')).join('');
};
function lerpHex(stops, t) {
  if (stops.length === 1) return stops[0];
  const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
  const local = t * (stops.length - 1) - seg;
  const [a, b] = [hexToRgb(stops[seg]), hexToRgb(stops[seg + 1])];
  return a.map((v, i) => Math.round(v + (b[i] - v) * local).toString(16).padStart(2, '0')).join('');
}
const colorArg = (s) => {
  const v = String(s || '').toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v.slice(1);
  if (NAMES[v]) return COLORS[NAMES[v]];
  if (v === 'grey' || v === 'dark_grey') return COLORS[v === 'grey' ? '7' : '8'];
  return null;
};

/** MiniMessage to runs. Gradients and rainbows become one hex color per character. Unknown tags stay as text. */
function parseMini(src) {
  const runs = [];
  const stack = [{ style: { color: null }, tag: null }];
  const top = () => stack[stack.length - 1];
  const re = /\\<|<(\/?)([a-z_:#0-9.!-]+)>/gi;
  let last = 0;
  let m;
  const emit = (text) => {
    if (!text) return;
    const fx = [...stack].reverse().find((f) => f.effect)?.effect;
    if (!fx) return pushRun(runs, text, top().style);
    for (const ch of [...text]) {
      const t = fx.total > 1 ? fx.index / (fx.total - 1) : 0;
      const color = fx.type === 'rainbow' ? hsvHex((t * 360 + fx.phase) % 360) : lerpHex(fx.stops, t);
      pushRun(runs, ch, { ...top().style, color });
      if (ch.trim()) fx.index++;
    }
  };
  // Gradients need the length of the text they cover up front.
  const coveredLength = (from, tag) => {
    const close = src.toLowerCase().indexOf(`</${tag}`, from);
    const inner = src.slice(from, close < 0 ? undefined : close).replace(/\\</g, '<').replace(/<[^>]*>/g, '');
    return [...inner].filter((c) => c.trim()).length;
  };
  while ((m = re.exec(src))) {
    emit(src.slice(last, m.index));
    last = re.lastIndex;
    if (m[0] === '\\<') {
      emit('<');
      continue;
    }
    const [closing, body] = [m[1] === '/', m[2]];
    const [name, ...args] = body.split(':');
    const lname = name.toLowerCase();
    if (closing) {
      const at = stack.map((f) => f.tag).lastIndexOf(lname === 'c' || lname === 'colour' ? 'color' : MINI_FORMATS[lname] || lname);
      if (at > 0) stack.length = at;
      continue;
    }
    if (lname === 'reset' || lname === 'r') {
      stack.length = 1;
      continue;
    }
    if (lname === 'newline' || lname === 'br') {
      emit('\n');
      continue;
    }
    const color = name.startsWith('#') ? colorArg(name) : ['color', 'colour', 'c'].includes(lname) ? colorArg(args[0]) : colorArg(lname);
    if (color) {
      stack.push({ tag: name.startsWith('#') || !['color', 'colour', 'c'].includes(lname) ? lname : 'color', style: { ...top().style, color } });
      continue;
    }
    if (MINI_FORMATS[lname]) {
      const on = args[0] !== 'false' && !name.startsWith('!');
      stack.push({ tag: MINI_FORMATS[lname], style: { ...top().style, [MINI_FORMATS[lname]]: on } });
      continue;
    }
    if (lname === 'gradient' || lname === 'rainbow') {
      const total = coveredLength(last, lname);
      const effect =
        lname === 'rainbow'
          ? { type: 'rainbow', phase: Number(args[0]?.replace('!', '')) || 0, index: 0, total }
          : { type: 'gradient', stops: (args.map(colorArg).filter(Boolean).length >= 2 ? args.map(colorArg).filter(Boolean) : ['ffffff', '000000']), index: 0, total };
      stack.push({ tag: lname, style: top().style, effect });
      continue;
    }
    emit(m[0]); // not a tag we know: keep it as text
  }
  emit(src.slice(last));
  return runs;
}

/** keepTags: leave text that looks like a tag (<online_players>, a placeholder) as a tag instead of escaping it. */
function toMini(runs, { keepTags = false } = {}) {
  const lt = keepTags ? /<(?![a-z_!/#][\w:.!#-]*>)/gi : /</g;
  let out = '';
  let cur = { color: null };
  for (const run of runs) {
    if (!sameStyle(run, cur)) {
      // Adding bold (and so on) just opens a tag; changing the color or dropping a format starts over.
      const onlyAdds = run.color === cur.color && !Object.values(FORMATS).some((f) => cur[f] && !run[f]);
      if (!onlyAdds) {
        if (cur.color || Object.values(FORMATS).some((f) => cur[f])) out += '<reset>';
        if (run.color) out += `<${CODE_NAME[Object.entries(COLORS).find(([, h]) => h === run.color)?.[0]] || `#${run.color}`}>`;
      }
      for (const f of Object.values(FORMATS)) if (run[f] && !(onlyAdds && cur[f])) out += `<${f}>`;
      cur = run;
    }
    out += run.text.replace(/\\/g, '\\\\').replace(lt, '\\<').replace(/\n/g, '<newline>');
  }
  return out;
}

// ---------------------------------------------------------------- per server type

const atLeast = (version, min) => {
  const [a, b] = [String(version).split('.').map(Number), min.split('.').map(Number)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
};

/** Where this server keeps its MOTD and what it supports. */
function detect(cfg) {
  const kind = software.kindOf(cfg);
  const modern = !/^\d+(\.\d+)+$/.test(cfg.version || '') || atLeast(cfg.version, '1.16');
  if (kind === 'velocity') return { kind, file: 'velocity.toml', key: 'motd', hex: true, format: 'MiniMessage' };
  if (kind === 'bungeecord') return { kind, file: 'config.yml', key: 'listeners → motd', hex: true, format: '& color codes' };
  if (kind === 'spigot') return { kind, file: 'server.properties', key: 'motd', hex: modern, format: '§ color codes' };
  return { kind, file: 'server.properties', key: 'motd', hex: false, format: '§ color codes' };
}

const fileOf = (cfg, d) => path.join(cfg.dir, d.file);
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** The current MOTD: raw (as stored) and text (in the editor's & syntax). */
function read(cfg) {
  const d = detect(cfg);
  const text = readText(fileOf(cfg, d));
  let raw = null;
  if (text != null) {
    if (d.kind === 'velocity') raw = software.velocityGet(text, 'motd');
    else if (d.kind === 'bungeecord') raw = software.bungeeGet(text, 'motd');
    else raw = properties.parse(text).motd ?? null;
  }
  const defaults = { velocity: '<#09add3>A Velocity Server', bungeecord: '&1Another Bungee server' };
  const value = raw ?? defaults[d.kind] ?? 'A Minecraft Server';
  const runs = d.kind === 'velocity' ? parseMini(value) : parseAmp(value);
  return { ...d, exists: text != null, raw: value, text: toCodes(runs) };
}

/** Save `text` (& syntax, lines separated by \n) in the server's own format. */
function write(cfg, input) {
  const text = String(input ?? '').replace(/\r\n?/g, '\n');
  if (text.length > 2000) throw httpError(400, 'That MOTD is too long');
  if (text.split('\n').length > 2) throw httpError(400, 'The server list shows two lines at most');
  const d = detect(cfg);
  const runs = parseAmp(text);
  const file = fileOf(cfg, d);
  const current = readText(file);
  let next;
  if (d.kind === 'velocity') {
    if (current == null) throw httpError(409, 'velocity.toml does not exist yet. Start the proxy once, then edit the MOTD.');
    next = software.velocitySet(current, 'motd', toMini(runs));
  } else if (d.kind === 'bungeecord') {
    if (current == null) throw httpError(409, 'config.yml does not exist yet. Start the proxy once, then edit the MOTD.');
    next = software.bungeeSet(current, 'motd', toCodes(runs, { prefix: '&', hex: '&x' }));
    if (next == null) throw httpError(409, 'config.yml has no listeners section, so there is nowhere to put the MOTD');
  } else {
    const motd = toCodes(runs, { prefix: '§', hex: d.hex ? '§x' : null });
    next = properties.stringify({ motd }, current || '');
  }
  fs.writeFileSync(file, next);
  return read(cfg);
}

module.exports = { detect, read, write, parseAmp, parseMini, toCodes, toMini };
