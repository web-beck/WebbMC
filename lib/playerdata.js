'use strict';
// Every player who ever joined a server, from its files: <world>/players/data/<uuid>.dat on 26.1+ or
// <world>/playerdata/<uuid>.dat before it (gzipped NBT, written by
// the server when a player leaves and on autosave) holds the last position and dimension. Paper and Spigot add
// first and last played times there; on vanilla the file's modified time stands in for "last seen".
// usercache.json gives the names.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');

/** A minimal NBT reader: compounds, lists, numbers and strings. Byte, int and long arrays are skipped. */
function readNbt(buf) {
  let o = 0;
  const str = () => {
    const n = buf.readUInt16BE(o);
    o += 2;
    return buf.toString('utf8', o, (o += n));
  };
  const payload = (t) => {
    switch (t) {
      case 1:
        return buf.readInt8(o++);
      case 2:
        return buf.readInt16BE((o += 2) - 2);
      case 3:
        return buf.readInt32BE((o += 4) - 4);
      case 4:
        return Number(buf.readBigInt64BE((o += 8) - 8));
      case 5:
        return buf.readFloatBE((o += 4) - 4);
      case 6:
        return buf.readDoubleBE((o += 8) - 8);
      case 7:
      case 11:
      case 12: {
        const n = buf.readInt32BE((o += 4) - 4);
        o += n * (t === 7 ? 1 : t === 11 ? 4 : 8);
        if (n < 0 || o > buf.length) throw new Error('Bad NBT array');
        return null;
      }
      case 8:
        return str();
      case 9: {
        const type = buf.readInt8(o++);
        const n = buf.readInt32BE((o += 4) - 4);
        const list = [];
        for (let i = 0; i < n; i++) list.push(payload(type));
        return list;
      }
      case 10: {
        const c = Object.create(null); // keys come from the file: no __proto__ surprises
        for (let type; (type = buf.readInt8(o++)) !== 0; ) c[str()] = payload(type);
        return c;
      }
      default:
        throw new Error(`Bad NBT tag ${t}`);
    }
  };
  if (buf.readInt8(o++) !== 10) throw new Error('Not an NBT compound');
  str(); // the root's name
  return payload(10);
}

const DIMENSIONS = { 'minecraft:overworld': 'Overworld', 'minecraft:the_nether': 'Nether', 'minecraft:the_end': 'The End', 0: 'Overworld', '-1': 'Nether', 1: 'The End' };

/** What the panel shows from one player file. */
function fromNbt(nbt) {
  const pos = Array.isArray(nbt.Pos) && nbt.Pos.length === 3 ? nbt.Pos.map((n) => Math.floor(n)) : null;
  const dim = nbt.Dimension ?? null;
  return {
    pos,
    dimension: dim === null ? null : DIMENSIONS[dim] || String(dim).replace(/^minecraft:/, ''),
    lastPlayed: nbt.bukkit?.lastPlayed || nbt.Paper?.LastSeen || null,
    firstPlayed: nbt.bukkit?.firstPlayed || null,
    name: nbt.bukkit?.lastKnownName || null,
  };
}

// Parsed files by path, kept while their modified time stays the same (the tab asks again every few seconds).
const cache = new Map();
async function readPlayer(file) {
  const st = await fsp.stat(file);
  const hit = cache.get(file);
  if (hit && hit.mtime === st.mtimeMs) return hit.data;
  let data;
  try {
    // Player files are a few KB; the limit stops a broken or hostile file from inflating without end.
    data = { ...fromNbt(readNbt(zlib.gunzipSync(await fsp.readFile(file), { maxOutputLength: 32 << 20 }))), saved: st.mtimeMs };
  } catch {
    data = { pos: null, dimension: null, lastPlayed: null, firstPlayed: null, name: null, saved: st.mtimeMs, unreadable: true };
  }
  cache.set(file, { mtime: st.mtimeMs, data });
  return data;
}

/** Everyone who ever joined, newest first. online: the names online now. */
async function list(inst, online = []) {
  const world = path.join(inst.dir, inst.readProps()['level-name'] || 'world');
  // Minecraft 26.1 moved world/playerdata to world/players/data. A world upgraded in place may still have both,
  // so the newer layout wins for a player found in each.
  const byUuid = new Map();
  for (const dir of [path.join(world, 'playerdata'), path.join(world, 'players', 'data')]) {
    const found = await fsp.readdir(dir).catch(() => []);
    for (const f of found) if (/^[0-9a-f-]{36}\.dat$/i.test(f)) byUuid.set(f.slice(0, 36).toLowerCase(), path.join(dir, f));
  }
  if (!byUuid.size) return [];
  let names = {};
  try {
    for (const e of JSON.parse(await fsp.readFile(path.join(inst.dir, 'usercache.json'), 'utf8'))) names[e.uuid] = e.name;
  } catch {
    names = {};
  }
  const now = new Set(online.map((n) => n.toLowerCase()));
  const players = await Promise.all(
    [...byUuid].map(async ([uuid, file]) => {
      const p = await readPlayer(file).catch(() => null);
      if (!p) return null;
      const name = names[uuid] || p.name || null;
      const isOnline = Boolean(name && now.has(name.toLowerCase()));
      return { uuid, name, online: isOnline, lastSeen: isOnline ? Date.now() : p.lastPlayed || p.saved, firstPlayed: p.firstPlayed, dimension: p.dimension, pos: p.pos };
    }),
  );
  return players.filter(Boolean).sort((a, b) => b.lastSeen - a.lastSeen);
}

module.exports = { list, readNbt, fromNbt };
