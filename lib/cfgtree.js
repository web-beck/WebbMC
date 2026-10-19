'use strict';
// Plugin config files as a list of settings, for the Plugin config tab: YAML (Geyser, DiscordSRV, TAB...), HOCON
// .conf files (BlueMap, MiniMOTD) and TOML (velocity.toml). Line based: saving rewrites only the lines of the settings that changed, so every
// comment and the rest of the file stay as they were. The comment lines above a setting become its description.
//
// parse() gives items in file order:
//   { kind: 'section', path, line, note }                       a group of settings (YAML "key:", HOCON "key {")
//   { kind: 'value', path, line, end, type, value, note }       a setting; type is
//      bool | number | string | list (of plain values) | raw (an inline {...} or [...] kept as text) | complex
//      (anything else, such as a list of objects: shown, but edited in the Files tab)

const isConf = (file) => /\.conf$/i.test(file);
const isToml = (file) => /\.toml$/i.test(file);
const kindOf = (file) => (isConf(file) ? 'hocon' : isToml(file) ? 'toml' : 'yaml');
const spaces = (s) => /^\s*/.exec(s)[0].length;
const isBlankOrNote = (s, hocon) => !s.trim() || /^\s*#/.test(s) || (hocon && /^\s*\/\//.test(s));

/** The value part of "key: value  # note": { value, tail } with the note (and spaces before it) in tail. */
function splitValue(rest, hocon) {
  const s = rest.trim();
  if (s[0] === '"' || (s[0] === "'" && !hocon)) {
    const q = s[0];
    let i = 1;
    for (; i < s.length; i++) {
      if (q === '"' && s[i] === '\\') i++;
      else if (s[i] === q) {
        if (q === "'" && s[i + 1] === "'") i++;
        else break;
      }
    }
    return { value: s.slice(0, i + 1), tail: s.slice(i + 1) };
  }
  const m = (hocon ? /\s+(#|\/\/)/ : /\s+#/).exec(s);
  return m ? { value: s.slice(0, m.index).trimEnd(), tail: s.slice(m.index) } : { value: s, tail: '' };
}

/** A plain value as written in the file: { type, value, quote }. */
function decode(v, hocon) {
  if (v[0] === '"') {
    try {
      return { type: 'string', value: JSON.parse(v), quote: '"' };
    } catch {
      return { type: 'string', value: v.slice(1, -1), quote: '"' };
    }
  }
  if (v[0] === "'" && !hocon) return { type: 'string', value: v.slice(1, -1).replace(/''/g, "'"), quote: "'" };
  if (/^(true|false)$/i.test(v)) return { type: 'bool', value: v.toLowerCase() === 'true' };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { type: 'number', value: v };
  if (v === '~' || v === 'null') return { type: 'string', value: '', quote: '' };
  return { type: 'string', value: v, quote: '' };
}

/** Items of an inline [a, "b"] list, or null when it holds anything but plain values. */
function inlineList(v, hocon) {
  const body = v.slice(1, -1).trim();
  if (!body) return [];
  if (/[[\]{}]/.test(body.replace(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, ''))) return null;
  const parts = body.match(/"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^,]+/g) || [];
  return parts.map((p) => p.trim()).filter((p) => p && p !== ',').map((p) => String(decode(p, hocon).value));
}

/** Bracket depth change of a line, ignoring brackets inside quotes. */
function depthOf(s) {
  const bare = s.replace(/"(?:[^"\\]|\\.)*"/g, '');
  return (bare.match(/[[{]/g) || []).length - (bare.match(/[\]}]/g) || []).length;
}

const unquoteKey = (k) => {
  if (k[0] === '"') {
    try {
      return JSON.parse(k);
    } catch {
      return k.slice(1, -1);
    }
  }
  return k[0] === "'" ? k.slice(1, -1).replace(/''/g, "'") : k;
};

const YAML_KEY = /^(\s*)("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"{}[\],&*!|>%@`-][^:]*?)(\s*:)(\s+.*|)$/;

function parseYaml(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  const stack = []; // { indent, key }
  let notes = [];
  const nextContent = (from) => {
    for (let k = from; k < lines.length; k++) if (!isBlankOrNote(lines[k])) return k;
    return -1;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) {
      notes = [];
      continue;
    }
    const c = /^\s*#\s?(.*)$/.exec(raw);
    if (c) {
      notes.push(c[1]);
      continue;
    }
    const m = YAML_KEY.exec(raw);
    if (!m) {
      notes = [];
      continue;
    }
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const path = [...stack.map((x) => x.key), unquoteKey(m[2])];
    const note = notes.join('\n').trim();
    notes = [];
    const head = `${m[1]}${m[2]}${m[3]}`;
    const { value, tail } = splitValue(m[4], false);
    const base = { kind: 'value', path, line: i, end: i, note, head, tail, indent };
    if (!value) {
      const j = nextContent(i + 1);
      if (j >= 0 && /^\s*-(\s|$)/.test(lines[j]) && spaces(lines[j]) >= indent) {
        // A block list ("- item" lines). Lists of maps or nested lists are left for the Files tab.
        const itemIndent = spaces(lines[j]);
        const list = [];
        let complex = false;
        let end = i;
        for (let k = i + 1; k < lines.length; k++) {
          const l = lines[k];
          if (isBlankOrNote(l)) continue;
          const sp = spaces(l);
          const li = /^\s*-(?:\s+(.*))?$/.exec(l);
          if (li && sp === itemIndent) {
            const v = splitValue(li[1] || '', false).value;
            if (!v || /^[^'"][^:]*:(\s|$)/.test(v) || /^[[{]/.test(v)) complex = true;
            else list.push(String(decode(v, false).value));
            end = k;
          } else if (sp > itemIndent) {
            complex = true;
            end = k;
          } else break;
        }
        items.push({ ...base, end, type: complex ? 'complex' : 'list', value: complex ? null : list, itemIndent, style: 'block' });
        i = end;
        continue;
      }
      if (j >= 0 && spaces(lines[j]) > indent) {
        stack.push({ indent, key: path[path.length - 1] });
        items.push({ kind: 'section', path, line: i, note });
        continue;
      }
      items.push({ ...base, type: 'string', value: '', quote: '' });
      continue;
    }
    if (/^[|>][+-]?\d*$/.test(value)) {
      // A multi-line text block: shown, edited in Files.
      let end = i;
      for (let k = i + 1; k < lines.length && (!lines[k].trim() || spaces(lines[k]) > indent); k++) if (lines[k].trim()) end = k;
      items.push({ ...base, end, type: 'complex', value: null });
      i = end;
      continue;
    }
    if (value[0] === '[' || value[0] === '{') {
      if (depthOf(value) !== 0) {
        let end = i;
        let depth = depthOf(value);
        for (let k = i + 1; k < lines.length && depth > 0; k++) {
          depth += depthOf(lines[k]);
          end = k;
        }
        items.push({ ...base, end, type: 'complex', value: null });
        i = end;
        continue;
      }
      const list = value[0] === '[' ? inlineList(value, false) : null;
      items.push(list ? { ...base, type: 'list', value: list, itemIndent: indent + 2, style: 'inline' } : { ...base, type: 'raw', value });
      continue;
    }
    items.push({ ...base, ...decode(value, false) });
  }
  return items;
}

const CONF_KEY = /^(\s*)("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.\-]+)(\s*[:=]\s*|\s*(?=[{[])|\s+(?=\{))(.*)$/;

function parseConf(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  const stack = [];
  let notes = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (!t) {
      notes = [];
      continue;
    }
    const c = /^\s*(?:#|\/\/)\s?(.*)$/.exec(raw);
    if (c) {
      notes.push(c[1]);
      continue;
    }
    if (/^}\s*,?$/.test(t)) {
      stack.pop();
      notes = [];
      continue;
    }
    const m = CONF_KEY.exec(raw);
    if (!m) {
      notes = [];
      continue;
    }
    const indent = m[1].length;
    const path = [...stack, unquoteKey(m[2])];
    const note = notes.join('\n').trim();
    notes = [];
    const head = `${m[1]}${m[2]}${m[3]}`;
    const split = splitValue(m[4], true);
    const value = split.value.replace(/,$/, '').trim();
    const base = { kind: 'value', path, line: i, end: i, note, head, tail: split.tail, indent };
    if (value === '{') {
      stack.push(path[path.length - 1]);
      items.push({ kind: 'section', path, line: i, note });
      continue;
    }
    if (value[0] === '[' || value[0] === '{') {
      if (depthOf(value) === 0) {
        const list = value[0] === '[' ? inlineList(value, true) : null;
        items.push(list ? { ...base, type: 'list', value: list, itemIndent: indent + 2, style: 'inline' } : { ...base, type: 'raw', value });
        continue;
      }
      // Spans lines: a list of plain values ("[", one per line, "]"), or something bigger.
      let depth = depthOf(value);
      let end = i;
      const list = [];
      let complex = value[0] !== '[' || value !== '[';
      for (let k = i + 1; k < lines.length && depth > 0; k++) {
        const l = lines[k].trim();
        end = k;
        const before = depth;
        depth += depthOf(l);
        if (depth <= 0 || !l || /^(#|\/\/)/.test(l)) continue;
        if (before !== 1 || depthOf(l) !== 0) complex = true;
        else list.push(String(decode(splitValue(l, true).value.replace(/,$/, '').trim(), true).value));
      }
      const itemIndent = lines[i + 1] && end > i + 1 ? spaces(lines[i + 1]) : indent + 2;
      items.push(complex ? { ...base, end, type: 'complex', value: null } : { ...base, end, type: 'list', value: list, itemIndent, style: 'block' });
      i = end;
      continue;
    }
    if (!value) continue;
    items.push({ ...base, ...decode(value, true) });
  }
  return items;
}

// ---------------------------------------------------------------- TOML

/** A TOML value as written: strings ("..." basic, '...' literal), true/false, numbers; dates and the like stay raw. */
function tomlDecode(v) {
  if (v[0] === '"') {
    try {
      return { type: 'string', value: JSON.parse(v.replace(/\\U([0-9a-fA-F]{8})/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))), quote: '"' };
    } catch {
      return { type: 'string', value: v.slice(1, -1), quote: '"' };
    }
  }
  if (v[0] === "'") return { type: 'string', value: v.slice(1, -1), quote: "'" };
  if (/^(true|false)$/.test(v)) return { type: 'bool', value: v === 'true' };
  if (/^[-+]?\d+(\.\d+)?$/.test(v)) return { type: 'number', value: v.replace(/^\+/, '') };
  return { type: 'raw', value: v, rawAny: true };
}

const TOML_KEY = /^(\s*)("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(\s*=\s*)(.*)$/;
const tomlKeyParts = (k) => (k.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.\s]+/g) || []).map(unquoteKey);

function parseToml(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let table = [];
  let notes = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) {
      notes = [];
      continue;
    }
    const c = /^\s*#\s?(.*)$/.exec(raw);
    if (c) {
      notes.push(c[1]);
      continue;
    }
    if (/^\s*\[\[/.test(raw)) {
      table = null; // an array of tables: left for the Files tab
      notes = [];
      continue;
    }
    const h = /^\s*\[\s*([^[\]]+?)\s*\]\s*(#.*)?$/.exec(raw);
    if (h) {
      table = tomlKeyParts(h[1]);
      items.push({ kind: 'section', path: table, line: i, note: notes.join('\n').trim() });
      notes = [];
      continue;
    }
    const m = TOML_KEY.exec(raw);
    if (!m || !table) {
      notes = [];
      continue;
    }
    const indent = m[1].length;
    const path = [...table, unquoteKey(m[2])];
    const note = notes.join('\n').trim();
    notes = [];
    const head = `${m[1]}${m[2]}${m[3]}`;
    const split = splitValue(m[4], false);
    const value = split.value;
    const base = { kind: 'value', path, line: i, end: i, note, head, tail: split.tail, indent };
    if (value[0] === '[' || value[0] === '{') {
      if (depthOf(value) === 0) {
        const list = value[0] === '[' ? inlineList(value, true) : null;
        items.push(list ? { ...base, type: 'list', value: list, itemIndent: indent + 4, style: 'inline' } : { ...base, type: 'raw', value });
        continue;
      }
      let depth = depthOf(value);
      let end = i;
      const list = [];
      let complex = value !== '[';
      for (let k = i + 1; k < lines.length && depth > 0; k++) {
        const l = lines[k].trim();
        end = k;
        const before = depth;
        depth += depthOf(l);
        if (depth <= 0 || !l || l[0] === '#') continue;
        if (before !== 1 || depthOf(l) !== 0) complex = true;
        else list.push(String(tomlDecode(splitValue(l, false).value.replace(/,$/, '').trim()).value));
      }
      const itemIndent = lines[i + 1] && end > i + 1 ? spaces(lines[i + 1]) : indent + 4;
      items.push(complex ? { ...base, end, type: 'complex', value: null } : { ...base, end, type: 'list', value: list, itemIndent, style: 'block' });
      i = end;
      continue;
    }
    items.push({ ...base, ...tomlDecode(value) });
  }
  return items;
}

/** The settings of a file, in order. */
const parse = (text, file) => ({ hocon: parseConf, toml: parseToml, yaml: parseYaml })[kindOf(file)](text);

// ---------------------------------------------------------------- writing

const YAML_WORDS = /^(true|false|yes|no|on|off|null|~)$/i;
function encodeString(v, quote, hocon) {
  const s = String(v ?? '');
  if (quote === '"') return JSON.stringify(s);
  if (quote === "'" && !hocon) return `'${s.replace(/'/g, "''")}'`;
  const bare = hocon
    ? /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(s) && !/^(true|false|null)$/i.test(s)
    : s !== '' &&
      s.trim() === s &&
      /^[^\s'"#&*!|>%@`{}[\],?:-]/.test(s) &&
      !/:(\s|$)|\s#/.test(s) &&
      !YAML_WORDS.test(s) &&
      !/^[-+]?(\d|\.\d)/.test(s);
  return bare ? s : JSON.stringify(s);
}

/** A TOML string: a literal '...' when it was one and still can be, otherwise a basic "..." string. */
const tomlString = (s, quote) => (quote === "'" && !/['\r\n]/.test(s) ? `'${s}'` : JSON.stringify(s));

/** The lines that replace a setting for a new value. kind: 'yaml', 'hocon' or 'toml'. */
function render(it, value, kind) {
  const hocon = kind === 'hocon';
  const toml = kind === 'toml';
  const sep = it.head.endsWith(':') && kind === 'yaml' ? ' ' : '';
  if (it.type === 'bool') {
    if (typeof value !== 'boolean' && !['true', 'false'].includes(String(value))) throw new Error(`${it.path.join('.')} must be true or false`);
    return [`${it.head}${sep}${String(value) === 'true'}${it.tail}`];
  }
  if (it.type === 'number') {
    const n = String(value).trim();
    if (!/^-?\d+(\.\d+)?$/.test(n)) throw new Error(`${it.path.join('.')} must be a number`);
    return [`${it.head}${sep}${n}${it.tail}`];
  }
  if (it.type === 'string') {
    const s = String(value ?? '');
    if (/[\r\n]/.test(s)) throw new Error(`${it.path.join('.')} must be one line`);
    return [`${it.head}${sep}${toml ? tomlString(s, it.quote) : encodeString(s, it.quote, hocon)}${it.tail}`];
  }
  if (it.type === 'raw') {
    const s = String(value ?? '').trim();
    if (/[\r\n]/.test(s) || (!it.rawAny && (!/^[[{]/.test(s) || depthOf(s) !== 0))) throw new Error(`${it.path.join('.')} must stay one balanced {...} or [...]`);
    return [`${it.head}${sep}${s}${it.tail}`];
  }
  if (it.type === 'list') {
    if (!Array.isArray(value) || value.some((v) => /[\r\n]/.test(String(v)))) throw new Error(`${it.path.join('.')} must be a list of single lines`);
    const items = value.map(String);
    const pad = ' '.repeat(it.itemIndent ?? it.indent + 2);
    if (!items.length) return [`${it.head}${sep}[]`];
    if (it.style === 'inline') return [`${it.head}${sep}[${items.map((v) => JSON.stringify(v)).join(', ')}]${it.tail}`];
    if (toml) return [`${it.head}${sep}[`, ...items.map((v) => `${pad}${JSON.stringify(v)},`), `${' '.repeat(it.indent)}]`];
    if (hocon) return [`${it.head}${sep}[`, ...items.map((v) => `${pad}${JSON.stringify(v)}`), `${' '.repeat(it.indent)}]`];
    return [it.head, ...items.map((v) => `${pad}- ${encodeString(v, '', false)}`)];
  }
  throw new Error(`${it.path.join('.')} can only be changed in the Files tab`);
}

/**
 * Apply edits ([{ line, path, value }], line and path as parse() gave them) to the text. Each edit must still point at
 * the same setting, so edits made on an old copy of the file are refused.
 */
function apply(text, file, edits) {
  const kind = kindOf(file);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const byLine = new Map(parse(text, file).filter((x) => x.kind === 'value').map((x) => [x.line, x]));
  for (const e of [...edits].sort((a, b) => b.line - a.line)) {
    const it = byLine.get(Number(e.line));
    if (!it || it.path.join('\u0000') !== (e.path || []).join('\u0000')) throw new Error('The file changed since it was opened. Reload and try again.');
    lines.splice(it.line, it.end - it.line + 1, ...render(it, e.value, kind));
  }
  return lines.join(eol);
}

/** What the page needs of an item (no line-writing details). */
const view = ({ head, tail, indent, itemIndent, quote, style, ...rest }) => rest;

module.exports = { parse, apply, view, decode, splitValue, encodeString, depthOf, isConf, tomlString, unquoteKey };
