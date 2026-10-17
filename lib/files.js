'use strict';
// File manager operations, all confined to a server's folder.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { pipeline } = require('stream/promises');
const { httpError } = require('./util');

const MAX_EDIT = 5 * 1024 * 1024;

function resolveIn(root, rel = '') {
  const base = path.resolve(root);
  const target = path.resolve(base, `.${path.sep}${String(rel).replace(/^[\\/]+/, '')}`);
  if (target !== base && !target.startsWith(base + path.sep)) throw httpError(400, 'That path is outside the server folder');
  return target;
}

function notRoot(root, target) {
  if (target === path.resolve(root)) throw httpError(400, 'The server folder itself cannot be changed');
  return target;
}

async function list(root, rel) {
  const dir = resolveIn(root, rel);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = await Promise.all(
    entries.map(async (e) => {
      let st = null;
      try {
        st = await fsp.stat(path.join(dir, e.name));
      } catch {
        /* broken link or locked file */
      }
      return { name: e.name, dir: st ? st.isDirectory() : e.isDirectory(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
    }),
  );
  out.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return out;
}

async function readText(root, rel) {
  const file = resolveIn(root, rel);
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw httpError(400, 'That is a folder');
  if (st.size > MAX_EDIT) throw httpError(413, 'File is larger than 5 MB. Download it instead.');
  const buf = await fsp.readFile(file);
  if (buf.subarray(0, 8000).includes(0)) throw httpError(415, 'Binary file. Download it instead.');
  return buf.toString('utf8');
}

async function writeText(root, rel, text) {
  const file = notRoot(root, resolveIn(root, rel));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, text);
}

async function mkdir(root, rel) {
  await fsp.mkdir(notRoot(root, resolveIn(root, rel)), { recursive: true });
}

async function rename(root, from, to) {
  const src = notRoot(root, resolveIn(root, from));
  const dest = notRoot(root, resolveIn(root, to));
  if (fs.existsSync(dest)) throw httpError(409, 'Something with that name already exists');
  await fsp.rename(src, dest);
}

async function remove(root, rel) {
  await fsp.rm(notRoot(root, resolveIn(root, rel)), { recursive: true, force: false });
}

async function upload(root, rel, req) {
  const target = notRoot(root, resolveIn(root, rel));
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.uploading`;
  try {
    await pipeline(req, fs.createWriteStream(tmp));
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

async function sendFile(res, file, name, contentType = 'application/octet-stream') {
  const st = await fsp.stat(file);
  if (st.isDirectory()) throw httpError(400, 'Folders cannot be downloaded. Create a backup instead.');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': st.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  await pipeline(fs.createReadStream(file), res);
}

async function dirSize(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        try {
          total += (await fsp.stat(p)).size;
        } catch {
          /* vanished */
        }
      }
    }
  }
  return total;
}

module.exports = { resolveIn, list, readText, writeText, mkdir, rename, remove, upload, sendFile, dirSize };
