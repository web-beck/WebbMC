'use strict';
// ZIP archives without dependencies: a writer (deflate, or stored for files that are already compressed, with
// ZIP64 when sizes or counts need it) and a reader for archives made by common tools, including jar files.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
/** CRC-32 (zlib.crc32 where Node has it). */
function crc32(buf, crc = 0) {
  if (zlib.crc32) return zlib.crc32(buf, crc);
  let c = ~crc;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// Already compressed: deflating these again costs time and saves nothing. Region files compress each chunk.
const STORED = /\.(zip|jar|gz|tgz|xz|bz2|zst|7z|rar|png|jpe?g|gif|webp|ogg|mp3|mp4|mca|mcr|mcc|br)$/i;
const MAX32 = 0xffffffff;

function dosTime(ms) {
  const d = new Date(ms);
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Write `entries` ({ rel, abs, isDir, size, mtime }, rel using "/") into a new zip at `dest`.
 * Calls onFile(entry) before each file, for progress.
 */
async function writeZip(dest, entries, onFile) {
  const fd = await fsp.open(dest, 'w');
  let offset = 0;
  const central = [];
  const put = async (buf, pos) => {
    await fd.write(buf, 0, buf.length, pos);
  };
  try {
    for (const e of entries) {
      onFile?.(e);
      const name = Buffer.from(e.isDir ? `${e.rel}/` : e.rel, 'utf8');
      const method = e.isDir || !e.size || STORED.test(e.rel) ? 0 : 8;
      const zip64 = !e.isDir && e.size >= 0xfff00000; // leaves room for the file growing while it is read
      const { time, date } = dosTime(e.mtime);
      const headerAt = offset;
      const lh = Buffer.alloc(30 + name.length + (zip64 ? 20 : 0));
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(zip64 ? 45 : 20, 4);
      lh.writeUInt16LE(0x0800, 6); // names are UTF-8
      lh.writeUInt16LE(method, 8);
      lh.writeUInt16LE(time, 10);
      lh.writeUInt16LE(date, 12);
      lh.writeUInt16LE(name.length, 26);
      lh.writeUInt16LE(zip64 ? 20 : 0, 28);
      name.copy(lh, 30);
      if (zip64) {
        lh.writeUInt16LE(0x0001, 30 + name.length);
        lh.writeUInt16LE(16, 32 + name.length);
      }
      await put(lh, offset);
      offset += lh.length;

      let crc = 0;
      let usize = 0;
      let csize = 0;
      if (!e.isDir) {
        const dataAt = offset;
        const count = async function* (source) {
          for await (const chunk of source) {
            crc = crc32(chunk, crc);
            usize += chunk.length;
            yield chunk;
          }
        };
        const sink = async (source) => {
          for await (const chunk of source) {
            await put(chunk, dataAt + csize);
            csize += chunk.length;
          }
        };
        const input = fs.createReadStream(e.abs);
        if (method === 8) await pipeline(input, count, zlib.createDeflateRaw({ level: 6 }), sink);
        else await pipeline(input, count, sink);
        if (!zip64 && (usize >= MAX32 || csize >= MAX32)) throw new Error(`${e.rel} grew past 4 GB while it was being backed up`);
        offset += csize;
      }

      // Fill in the CRC and sizes now that they are known.
      const fix = Buffer.alloc(12);
      fix.writeUInt32LE(crc >>> 0, 0);
      fix.writeUInt32LE(zip64 ? MAX32 : csize, 4);
      fix.writeUInt32LE(zip64 ? MAX32 : usize, 8);
      await put(fix, headerAt + 14);
      if (zip64) {
        const sizes = Buffer.alloc(16);
        sizes.writeBigUInt64LE(BigInt(usize), 0);
        sizes.writeBigUInt64LE(BigInt(csize), 8);
        await put(sizes, headerAt + 34 + name.length);
      }
      central.push({ name, method, time, date, crc, csize, usize, headerAt, isDir: e.isDir, zip64 });
    }

    const cdStart = offset;
    for (const c of central) {
      const big = { u: c.zip64 || c.usize >= MAX32, c: c.zip64 || c.csize >= MAX32, o: c.headerAt >= MAX32 };
      const extraLen = (big.u ? 8 : 0) + (big.c ? 8 : 0) + (big.o ? 8 : 0);
      const h = Buffer.alloc(46 + c.name.length + (extraLen ? extraLen + 4 : 0));
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE((3 << 8) | 45, 4); // made by: Unix, so the permission bits below are used
      h.writeUInt16LE(extraLen ? 45 : 20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(c.method, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc >>> 0, 16);
      h.writeUInt32LE(big.c ? MAX32 : c.csize, 20);
      h.writeUInt32LE(big.u ? MAX32 : c.usize, 24);
      h.writeUInt16LE(c.name.length, 28);
      h.writeUInt16LE(extraLen ? extraLen + 4 : 0, 30);
      h.writeUInt32LE((((c.isDir ? 0o40755 : 0o100644) << 16) | (c.isDir ? 0x10 : 0)) >>> 0, 38);
      h.writeUInt32LE(big.o ? MAX32 : c.headerAt, 42);
      c.name.copy(h, 46);
      if (extraLen) {
        let p = 46 + c.name.length;
        h.writeUInt16LE(0x0001, p);
        h.writeUInt16LE(extraLen, p + 2);
        p += 4;
        for (const [on, v] of [
          [big.u, c.usize],
          [big.c, c.csize],
          [big.o, c.headerAt],
        ]) {
          if (!on) continue;
          h.writeBigUInt64LE(BigInt(v), p);
          p += 8;
        }
      }
      await put(h, offset);
      offset += h.length;
    }
    const cdSize = offset - cdStart;
    const need64 = central.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
    if (need64) {
      const z = Buffer.alloc(56 + 20);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE((3 << 8) | 45, 12);
      z.writeUInt16LE(45, 14);
      z.writeBigUInt64LE(BigInt(central.length), 24);
      z.writeBigUInt64LE(BigInt(central.length), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      z.writeUInt32LE(0x07064b50, 56); // locator
      z.writeBigUInt64LE(BigInt(offset), 64);
      z.writeUInt32LE(1, 72);
      await put(z, offset);
      offset += z.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(need64 ? 0xffff : central.length, 8);
    end.writeUInt16LE(need64 ? 0xffff : central.length, 10);
    end.writeUInt32LE(need64 ? MAX32 : cdSize, 12);
    end.writeUInt32LE(need64 ? MAX32 : cdStart, 16);
    await put(end, offset);
  } finally {
    await fd.close();
  }
}

// ---------------------------------------------------------------- reading

async function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fd.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

/** The archive's entries: { name, method, crc, csize, usize, offset, isDir }. */
async function listEntries(fd) {
  const { size } = await fd.stat();
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = await readAt(fd, size - tailLen, tailLen);
  let at = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error('Not a zip file (no end of central directory)');
  let count = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdStart = tail.readUInt32LE(at + 16);
  if (count === 0xffff || cdSize === MAX32 || cdStart === MAX32) {
    const locAt = size - tailLen + at - 20;
    const loc = await readAt(fd, locAt, 20);
    if (loc.readUInt32LE(0) !== 0x07064b50) throw new Error('Broken ZIP64 archive');
    const z = await readAt(fd, Number(loc.readBigUInt64LE(8)), 56);
    if (z.readUInt32LE(0) !== 0x06064b50) throw new Error('Broken ZIP64 archive');
    count = Number(z.readBigUInt64LE(32));
    cdSize = Number(z.readBigUInt64LE(40));
    cdStart = Number(z.readBigUInt64LE(48));
  }
  const cd = await readAt(fd, cdStart, cdSize);
  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken zip central directory');
    const flags = cd.readUInt16LE(p + 8);
    const e = {
      method: cd.readUInt16LE(p + 10),
      crc: cd.readUInt32LE(p + 16),
      csize: cd.readUInt32LE(p + 20),
      usize: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42),
      encrypted: Boolean(flags & 1),
    };
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    e.name = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = cd.readUInt16LE(x);
      const len = cd.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        for (const k of ['usize', 'csize', 'offset']) {
          if (e[k] !== MAX32) continue;
          e[k] = Number(cd.readBigUInt64LE(q));
          q += 8;
        }
      }
      x += 4 + len;
    }
    e.isDir = e.name.endsWith('/');
    entries.push(e);
    p = xEnd + commentLen;
  }
  return entries;
}

/** A readable stream of one entry's uncompressed bytes. */
async function entryStream(fd, file, e) {
  if (e.encrypted) throw new Error(`${e.name} is encrypted`);
  if (e.method !== 0 && e.method !== 8) throw new Error(`${e.name} uses an unsupported compression method (${e.method})`);
  const lh = await readAt(fd, e.offset, 30);
  if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`Broken zip entry ${e.name}`);
  const start = e.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const raw = e.csize ? fs.createReadStream(file, { start, end: start + e.csize - 1 }) : require('stream').Readable.from([]);
  return e.method === 8 ? raw.pipe(zlib.createInflateRaw()) : raw;
}

/** One file from an archive (for example a default config inside a jar), or null when it is not there. */
async function readEntry(file, name) {
  const fd = await fsp.open(file, 'r');
  try {
    const e = (await listEntries(fd)).find((x) => x.name === name);
    if (!e) return null;
    const chunks = [];
    for await (const c of await entryStream(fd, file, e)) chunks.push(c);
    return Buffer.concat(chunks);
  } finally {
    await fd.close();
  }
}

/** The names of every entry in an archive. */
async function entryNames(file) {
  const fd = await fsp.open(file, 'r');
  try {
    return (await listEntries(fd)).map((e) => e.name);
  } finally {
    await fd.close();
  }
}

/** Unpack `file` into `destDir`, refusing paths that would land outside it and checking every CRC. */
async function extractZip(file, destDir) {
  const dest = path.resolve(destDir);
  const fd = await fsp.open(file, 'r');
  try {
    for (const e of await listEntries(fd)) {
      const rel = e.name.replace(/\\/g, '/');
      const target = path.resolve(dest, rel);
      if (target !== dest && !target.startsWith(dest + path.sep)) throw new Error(`Refusing to unpack ${e.name}: it points outside the folder`);
      if (e.isDir) {
        await fsp.mkdir(target, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(target), { recursive: true });
      let crc = 0;
      await pipeline(
        await entryStream(fd, file, e),
        async function* (source) {
          for await (const chunk of source) {
            crc = crc32(chunk, crc);
            yield chunk;
          }
        },
        fs.createWriteStream(target),
      );
      if (crc >>> 0 !== e.crc >>> 0) throw new Error(`${e.name} is damaged (checksum mismatch)`);
    }
  } finally {
    await fd.close();
  }
}

module.exports = { writeZip, extractZip, readEntry, entryNames, crc32 };
