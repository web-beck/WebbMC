'use strict';
// Minecraft Server List Ping: asks a running server for its MOTD, version and player counts.
const net = require('net');

function varint(n) {
  const bytes = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    bytes.push(b);
  } while (v);
  return Buffer.from(bytes);
}

function readVarint(buf, offset) {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) return null;
    const b = buf[pos++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value, size: pos - offset };
    shift += 7;
    if (shift > 35) throw new Error('VarInt too long');
  }
}

const mcString = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(b.length), b]);
};

const packet = (id, payload) => {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
};

function flatten(component) {
  if (component == null) return '';
  if (typeof component === 'string') return component;
  if (Array.isArray(component)) return component.map(flatten).join('');
  return (component.text || '') + (component.extra ? component.extra.map(flatten).join('') : '');
}

function ping(port, host = '127.0.0.1', timeout = 2500) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    sock.setTimeout(timeout, () => finish(new Error('timeout')));
    sock.on('error', finish);
    sock.on('connect', () => {
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      sock.write(packet(0, Buffer.concat([varint(767), mcString(host), portBuf, varint(1)])));
      sock.write(packet(0, Buffer.alloc(0)));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        let off = len.size;
        off += readVarint(buf, off).size; // packet id
        const strLen = readVarint(buf, off);
        off += strLen.size;
        const data = JSON.parse(buf.subarray(off, off + strLen.value).toString('utf8'));
        finish(null, {
          online: data.players?.online ?? 0,
          max: data.players?.max ?? 0,
          // Servers that hide player names send "Anonymous Player" entries with an all-zero UUID.
          sample: (data.players?.sample || []).filter((p) => p.name && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(p.id || '')).map((p) => p.name),
          version: data.version?.name || '',
          motd: flatten(data.description).replace(/§./g, ''),
        });
      } catch (err) {
        finish(err);
      }
    });
  });
}

module.exports = { ping, varint, readVarint, mcString, packet, flatten };
