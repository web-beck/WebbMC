'use strict';
// server-icon.png: the 64x64 picture shown next to the server in Minecraft's multiplayer list.
// The panel UI resizes whatever picture the user picks; this side only checks it is a real 64x64 PNG.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const store = require('./store');
const { httpError } = require('./util');

const NAME = 'server-icon.png';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const fileFor = (inst) => path.join(inst.dir, NAME);

/** Modification time of the icon (used as a cache buster), or null when the server has none. */
function mtime(dir) {
  try {
    return Math.round(fs.statSync(path.join(dir, NAME)).mtimeMs);
  } catch {
    return null;
  }
}

async function send(inst, res) {
  let buf;
  try {
    buf = await fsp.readFile(fileFor(inst));
  } catch {
    throw httpError(404, 'This server has no icon');
  }
  // The URL carries ?v=<mtime>, so a new icon gets a new URL and the old one can be cached for good.
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'private, max-age=31536000, immutable' });
  res.end(buf);
}

async function save(inst, buf) {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE) || buf.toString('latin1', 12, 16) !== 'IHDR') {
    throw httpError(400, 'The icon must be a PNG image');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== 64 || height !== 64) throw httpError(400, `The icon must be 64x64 pixels (got ${width}x${height})`);
  const tmp = `${fileFor(inst)}.uploading`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, fileFor(inst));
  store.logActivity(inst.id, 'Server icon updated');
  inst.emit('status');
  return { icon: mtime(inst.dir) };
}

async function remove(inst) {
  await fsp.rm(fileFor(inst), { force: true });
  store.logActivity(inst.id, 'Server icon removed');
  inst.emit('status');
  return { icon: null };
}

module.exports = { mtime, send, save, remove };
