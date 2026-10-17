'use strict';
// Minimal Java .properties reader/writer that keeps comments and key order when saving.

function unescape(str) {
  return str.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => {
    if (c.length === 5) return String.fromCharCode(Number.parseInt(c.slice(1), 16));
    return { t: '\t', n: '\n', r: '\r', f: '\f' }[c] ?? c;
  });
}

function escapeValue(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

const KEY_RE = /^((?:\\.|[^=:\s\\])+)/;

function isEntry(line) {
  return line && line[0] !== '#' && line[0] !== '!';
}

function parse(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trimStart();
    if (!isEntry(line)) continue;
    const m = line.match(/^((?:\\.|[^=:\s\\])+)\s*[=:]?\s*(.*)$/);
    if (m) out[unescape(m[1])] = unescape(m[2]);
  }
  return out;
}

/** Write `values` back into `original`, replacing existing keys in place and appending new ones. */
function stringify(values, original = '') {
  const remaining = new Map(Object.entries(values));
  const written = new Set();
  const out = [];
  for (const raw of original ? original.split(/\r?\n/) : []) {
    const line = raw.trimStart();
    const m = isEntry(line) && line.match(KEY_RE);
    if (m) {
      const key = unescape(m[1]);
      if (written.has(key)) continue; // drop duplicate keys so the saved value wins
      if (remaining.has(key)) {
        out.push(`${m[1]}=${escapeValue(remaining.get(key))}`);
        remaining.delete(key);
        written.add(key);
        continue;
      }
    }
    out.push(raw);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  for (const [key, value] of remaining) out.push(`${key}=${escapeValue(value)}`);
  return `${out.join('\n')}\n`;
}

module.exports = { parse, stringify };
