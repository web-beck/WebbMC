'use strict';
// Run with: node --test test/playerdata.test.js
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { readNbt, fromNbt } = require('../lib/playerdata');

// A tiny NBT writer, just enough to build a player file.
const name = (s) => { const b = Buffer.from(s); const len = Buffer.alloc(2); len.writeUInt16BE(b.length); return Buffer.concat([len, b]); };
const tag = (type, key, body) => Buffer.concat([Buffer.from([type]), name(key), body]);
const dbl = (n) => { const b = Buffer.alloc(8); b.writeDoubleBE(n); return b; };
const lng = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const compound = (...tags) => Buffer.concat([...tags, Buffer.from([0])]);

const file = tag(10, '', compound(
  tag(9, 'Pos', Buffer.concat([Buffer.from([6]), i32(3), dbl(120.7), dbl(64), dbl(-30.2)])),
  tag(8, 'Dimension', name('minecraft:the_nether')),
  tag(11, 'UUID', Buffer.concat([i32(4), i32(1), i32(2), i32(3), i32(4)])),
  tag(10, 'bukkit', compound(tag(4, 'lastPlayed', lng(1793387418658)), tag(4, 'firstPlayed', lng(1700000000000)), tag(8, 'lastKnownName', name('MrMaximoo')))),
));

test('reads position, dimension and Bukkit times from a gzipped player file', () => {
  const p = fromNbt(readNbt(zlib.gunzipSync(zlib.gzipSync(file))));
  assert.deepStrictEqual(p, { pos: [120, 64, -31], dimension: 'Nether', lastPlayed: 1793387418658, firstPlayed: 1700000000000, name: 'MrMaximoo' });
});

test('old number dimensions and a vanilla file without Bukkit data', () => {
  const p = fromNbt(readNbt(tag(10, '', compound(tag(3, 'Dimension', i32(-1))))));
  assert.strictEqual(p.dimension, 'Nether');
  assert.strictEqual(p.lastPlayed, null);
});

test('a broken file throws instead of looping', () => {
  assert.throws(() => readNbt(file.subarray(0, 20)));
});
