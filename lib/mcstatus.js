'use strict';
// Status checker for any Minecraft server, in the spirit of mcsrvstat.us and mcstatus.io.
// Java: SRV lookup, Server List Ping with latency, the legacy ping for 1.6 and older, and Query (UDP).
// Bedrock: the RakNet unconnected ping. Both: DNS records, reverse DNS and Mojang's blocked-server list.
const net = require('net');
const dgram = require('dgram');
const dns = require('dns');
const crypto = require('crypto');
const { varint, readVarint, mcString, packet, flatten } = require('./slp');
const { httpError } = require('./util');

const TIMEOUT = 5000;
const QUERY_TIMEOUT = 2500;
const DEFAULT_PORT = { java: 25565, bedrock: 19132 };
const resolver = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
const HOST_RE = /^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const ANON_UUID = /^0{8}-0{4}-0{4}-0{4}-0{12}$/;
const PLAYER_NAME = /^[.*]?[A-Za-z0-9_]{1,16}$/;
const RAKNET_MAGIC = Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex');
const SOFTWARE = [
  'Paper', 'Purpur', 'Folia', 'Pufferfish', 'Leaves', 'Spigot', 'CraftBukkit', 'Velocity', 'BungeeCord', 'Waterfall',
  'FlameCord', 'Travertine', 'Gate', 'TCPShield', 'NeoForge', 'Forge', 'Fabric', 'Quilt', 'Mohist', 'Arclight', 'Magma',
];

const since = (t) => Date.now() - t;
const num = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const tryq = async (fn) => {
  try {
    return await fn();
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- addresses

/** "play.example.com", "play.example.com:25566", "1.2.3.4", "[2001:db8::1]:25565" -> { host, port } */
function parseAddress(input) {
  const s = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '');
  let host = s;
  let port = null;
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(s);
  if (v6) [, host, port] = v6;
  else if (!net.isIPv6(s)) {
    const m = /^(.*):(\d+)$/.exec(s);
    if (m) [, host, port] = m;
  }
  host = (host || '').replace(/\.$/, '');
  if (!host || !(net.isIP(host) || HOST_RE.test(host))) throw httpError(400, 'Enter a server address like play.example.com or 1.2.3.4:25565');
  if (port != null) {
    port = Number(port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw httpError(400, 'The port must be between 1 and 65535');
  }
  return { host, port };
}

const formatAddress = (host, port) => `${net.isIPv6(host) ? `[${host}]` : host}${port ? `:${port}` : ''}`;

function favorite(address, edition) {
  const { host, port } = parseAddress(address);
  return { address: formatAddress(host, port), edition: edition === 'bedrock' ? 'bedrock' : 'java', addedAt: Date.now() };
}

function describe(err) {
  switch (err.code) {
    case 'ECONNREFUSED':
      return 'Connection refused: nothing is accepting connections on that port';
    case 'ENOTFOUND':
    case 'ENODATA':
      return 'That hostname does not exist';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return 'The host is unreachable from here';
    case 'ECONNRESET':
      return 'The server closed the connection';
    case 'ETIMEDOUT':
      return 'No response within 5 seconds';
    default:
      return err.message;
  }
}

// ---------------------------------------------------------------- Java: Server List Ping

/** Modern status request (1.7+), followed by a ping packet to measure the round trip. */
function javaStatus(ip, port, handshakeHost) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.createConnection({ host: ip, port });
    let buf = Buffer.alloc(0);
    let connectMs = null;
    let status = null;
    let pingSent = 0;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (status) return resolve({ ...status, connectMs });
      const e = err || Object.assign(new Error('The server closed the connection without answering'), { code: 'NOANSWER' });
      e.connected = connectMs != null;
      reject(e);
    };
    sock.setTimeout(TIMEOUT, () => finish(Object.assign(new Error('No response within 5 seconds'), { code: 'ETIMEDOUT' })));
    sock.on('error', (err) => finish(err));
    sock.on('close', () => finish());
    sock.on('connect', () => {
      connectMs = since(started);
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      // Protocol -1 is the convention for "only asking which version you run".
      sock.write(packet(0, Buffer.concat([varint(-1), mcString(handshakeHost), portBuf, varint(1)])));
      sock.write(packet(0, Buffer.alloc(0)));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      try {
        for (;;) {
          const len = readVarint(buf, 0);
          if (!len || buf.length < len.size + len.value) return;
          const body = buf.subarray(len.size, len.size + len.value);
          buf = buf.subarray(len.size + len.value);
          const id = readVarint(body, 0);
          if (id.value === 0 && !status) {
            const str = readVarint(body, id.size);
            const start = id.size + str.size;
            status = { data: JSON.parse(body.subarray(start, start + str.value).toString('utf8')), statusMs: since(started), latency: null };
            const payload = Buffer.alloc(8);
            payload.writeBigInt64BE(BigInt(Date.now()));
            pingSent = Date.now();
            sock.write(packet(1, payload));
            sock.setTimeout(2500); // some proxies never answer the ping; the status alone is enough
          } else if (id.value === 1 && status) {
            status.latency = since(pingSent);
            return finish();
          }
        }
      } catch (err) {
        finish(Object.assign(err, { message: `Unreadable status response: ${err.message}` }));
      }
    });
  });
}

/** The pre-1.7 ping (0xFE 0x01), answered by old servers and by most modern ones for compatibility. */
function legacyStatus(ip, port) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const sock = net.createConnection({ host: ip, port });
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const noAnswer = () => finish(new Error('No answer to the legacy ping either'));
    sock.setTimeout(TIMEOUT, noAnswer);
    sock.on('error', finish);
    sock.on('close', noAnswer);
    sock.on('connect', () => sock.write(Buffer.from([0xfe, 0x01])));
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 3) return;
      if (buf[0] !== 0xff) return finish(new Error('That does not look like a Minecraft server'));
      const chars = buf.readUInt16BE(1);
      if (buf.length < 3 + chars * 2) return;
      const str = Buffer.from(buf.subarray(3, 3 + chars * 2)).swap16().toString('utf16le');
      const latency = since(started);
      if (str.startsWith('§1\0')) {
        const [, protocol, version, motd, online, max] = str.split('\0');
        return finish(null, { protocol: num(protocol), version, motd, online: num(online) ?? 0, max: num(max) ?? 0, latency });
      }
      const parts = str.split('§'); // Beta 1.8 to 1.3: motd§online§max
      const max = num(parts.pop()) ?? 0;
      const online = num(parts.pop()) ?? 0;
      return finish(null, { protocol: null, version: '', motd: parts.join('§'), online, max, latency });
    });
  });
}

// ---------------------------------------------------------------- Java: Query (UDP, needs enable-query=true)

function parseFullStat(msg) {
  let off = 5 + 11; // type + session id, then the constant "splitnum\0\x80\0"
  const readStr = () => {
    const end = msg.indexOf(0, off);
    if (end < 0) throw new Error('Truncated query response');
    const s = msg.toString('utf8', off, end);
    off = end + 1;
    return s;
  };
  const kv = {};
  for (;;) {
    const k = readStr();
    if (!k) break;
    kv[k] = readStr();
  }
  off += 10; // "\x01player_\0\0"
  const players = [];
  while (off < msg.length) {
    const n = readStr();
    if (!n) break;
    players.push(n);
  }
  return { kv, players };
}

function query(ip, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket(net.isIPv6(ip) ? 'udp6' : 'udp4');
    const session = crypto.randomBytes(4).readUInt32BE() & 0x0f0f0f0f;
    const header = (type) => {
      const b = Buffer.alloc(7);
      b.writeUInt16BE(0xfefd, 0);
      b[2] = type;
      b.writeUInt32BE(session, 3);
      return b;
    };
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), QUERY_TIMEOUT);
    sock.on('error', () => finish(null));
    sock.on('message', (msg) => {
      try {
        if (msg[0] === 0x09) {
          const token = Number.parseInt(msg.toString('latin1', 5).replace(/\0[\s\S]*$/, ''), 10);
          const body = Buffer.alloc(8); // challenge token + 4 bytes of padding asks for the full stat
          body.writeUInt32BE(token >>> 0, 0);
          sock.send(Buffer.concat([header(0x00), body]), port, ip);
        } else if (msg[0] === 0x00) {
          finish(parseFullStat(msg));
        }
      } catch {
        finish(null);
      }
    });
    sock.send(header(0x09), port, ip, (err) => err && finish(null));
  });
}

// ---------------------------------------------------------------- Bedrock: RakNet unconnected ping

function bedrockStatus(ip, port) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket(net.isIPv6(ip) ? 'udp6' : 'udp4');
    const started = Date.now();
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.close();
      } catch {
        /* already closed */
      }
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(Object.assign(new Error('No response within 5 seconds'), { code: 'ETIMEDOUT' })), TIMEOUT);
    sock.on('error', finish);
    sock.on('message', (msg) => {
      if (msg[0] !== 0x1c || msg.length < 35) return;
      try {
        // 0x1c, time (8), server GUID (8), magic (16), string length (2), then "MCPE;motd;protocol;version;..."
        const f = msg.toString('utf8', 35, 35 + msg.readUInt16BE(33)).split(';');
        finish(null, {
          latency: since(started),
          edition: f[0] || '',
          motd: f[1] || '',
          protocol: num(f[2]),
          version: f[3] || '',
          online: num(f[4]) ?? 0,
          max: num(f[5]) ?? 0,
          serverId: f[6] || '',
          levelName: f[7] || '',
          gamemode: f[8] || '',
          gamemodeId: num(f[9]),
          portV4: num(f[10]),
          portV6: num(f[11]),
        });
      } catch (err) {
        finish(err);
      }
    });
    const ping = Buffer.alloc(33);
    ping[0] = 0x01;
    ping.writeBigInt64BE(BigInt(Date.now()), 1);
    RAKNET_MAGIC.copy(ping, 9);
    crypto.randomBytes(8).copy(ping, 25);
    sock.send(ping, port, ip, (err) => err && finish(err));
  });
}

// ---------------------------------------------------------------- DNS and Mojang's block list

async function dnsRecords(host, srv) {
  if (net.isIP(host)) return [];
  const [a, aaaa, cname, srvs, txt, mx, ns, caa, soa, srvA, srvAAAA] = await Promise.all([
    tryq(() => resolver.resolve4(host, { ttl: true })),
    tryq(() => resolver.resolve6(host, { ttl: true })),
    tryq(() => resolver.resolveCname(host)),
    tryq(() => resolver.resolveSrv(`_minecraft._tcp.${host}`)),
    tryq(() => resolver.resolveTxt(host)),
    tryq(() => resolver.resolveMx(host)),
    tryq(() => resolver.resolveNs(host)),
    tryq(() => resolver.resolveCaa(host)),
    tryq(() => resolver.resolveSoa(host)),
    srv ? tryq(() => resolver.resolve4(srv.target, { ttl: true })) : null,
    srv ? tryq(() => resolver.resolve6(srv.target, { ttl: true })) : null,
  ]);
  const rows = [];
  const add = (type, name, value, ttl = null) => rows.push({ type, name, value, ttl });
  for (const r of cname || []) add('CNAME', host, r);
  for (const r of a || []) add('A', host, r.address, r.ttl);
  for (const r of aaaa || []) add('AAAA', host, r.address, r.ttl);
  for (const r of srvs || []) add('SRV', `_minecraft._tcp.${host}`, `${r.priority} ${r.weight} ${r.port} ${r.name}`);
  if (srv) {
    for (const r of srvA || []) add('A', srv.target, r.address, r.ttl);
    for (const r of srvAAAA || []) add('AAAA', srv.target, r.address, r.ttl);
  }
  for (const r of mx || []) add('MX', host, `${r.priority} ${r.exchange}`);
  for (const r of ns || []) add('NS', host, r);
  for (const r of txt || []) add('TXT', host, r.join(''));
  for (const r of caa || []) {
    const tag = Object.keys(r).find((k) => k !== 'critical');
    add('CAA', host, `${r.critical} ${tag} "${r[tag]}"`);
  }
  if (soa) add('SOA', host, `${soa.nsname} ${soa.hostmaster} ${soa.serial} ${soa.refresh} ${soa.retry} ${soa.expire} ${soa.minttl}`);
  return rows;
}

let blockedCache = { t: 0, hashes: null };
async function blockedHashes() {
  if (blockedCache.hashes && Date.now() - blockedCache.t < 60 * 60 * 1000) return blockedCache.hashes;
  const res = await fetch('https://sessionserver.mojang.com/blockedservers', { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`Mojang responded with HTTP ${res.status}`);
  const hashes = new Set(
    (await res.text())
      .split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  blockedCache = { t: Date.now(), hashes };
  return hashes;
}

/** The patterns the game checks: the name itself, then wildcards (*.example.com, 1.2.3.*). */
function blockCandidates(host) {
  if (net.isIPv4(host)) {
    const p = host.split('.');
    return [host, `${p.slice(0, 3).join('.')}.*`, `${p.slice(0, 2).join('.')}.*`, `${p[0]}.*`];
  }
  const parts = host.split('.');
  return [host, ...parts.slice(1).map((_, i) => `*.${parts.slice(i + 1).join('.')}`)];
}

async function blockedCheck(names) {
  try {
    const hashes = await blockedHashes();
    for (const name of names) for (const c of blockCandidates(name)) if (hashes.has(sha1(c))) return { blocked: true, match: c };
    return { blocked: false, match: null, listSize: hashes.size };
  } catch {
    return null; // Mojang unreachable: unknown, not "not blocked"
  }
}

// ---------------------------------------------------------------- putting it together

function detectSoftware(versionName) {
  const name = String(versionName || '');
  return SOFTWARE.find((s) => new RegExp(`\\b${s}\\b`, 'i').test(name)) || null;
}

function parsePlugins(s) {
  if (!s) return { software: null, plugins: [] };
  const i = s.indexOf(':');
  if (i < 0) return { software: s.trim() || null, plugins: [] };
  return {
    software: s.slice(0, i).trim() || null,
    plugins: s
      .slice(i + 1)
      .split(';')
      .map((p) => p.trim())
      .filter(Boolean),
  };
}

function applyModern(r, status) {
  const d = status.data || {};
  r.online = true;
  r.latency = status.latency ?? status.connectMs;
  r.latencyMethod = status.latency != null ? 'ping packet' : 'TCP connect';
  Object.assign(r.timings, { connect: status.connectMs, status: status.statusMs });
  r.version = { name: flatten(d.version?.name ?? '').replace(/§./g, ''), protocol: d.version?.protocol ?? null };
  // Real players have a valid name and UUID; servers also use the sample for hover text, which we keep separately.
  const sample = Array.isArray(d.players?.sample) ? d.players.sample : [];
  const isPlayer = (p) => p && PLAYER_NAME.test(p.name || '') && !ANON_UUID.test(p.id || '');
  r.players = {
    online: num(d.players?.online) ?? 0,
    max: num(d.players?.max) ?? 0,
    list: sample.filter(isPlayer).map((p) => ({ name: p.name, id: p.id || null })),
    hover: sample.filter((p) => p && !isPlayer(p) && typeof p.name === 'string').map((p) => p.name),
  };
  r.motd = { raw: d.description ?? '', clean: flatten(d.description).replace(/§./g, '') };
  r.favicon = typeof d.favicon === 'string' && d.favicon.startsWith('data:image/') ? d.favicon : null;
  r.flags = { enforcesSecureChat: d.enforcesSecureChat ?? null, preventsChatReports: d.preventsChatReports ?? null, previewsChat: d.previewsChat ?? null };
  const mods = d.forgeData?.mods?.map((m) => ({ id: m.modId, version: m.modmarker })) || d.modinfo?.modList?.map((m) => ({ id: m.modid, version: m.version })) || [];
  r.mods = mods.filter((m) => m.id);
  r.modLoader = d.forgeData ? 'Forge' : d.modinfo ? d.modinfo.type || 'FML' : d.isModded ? 'Modded' : null;
  r.modsTruncated = Boolean(d.forgeData?.d); // newer Forge packs the mod list into a binary blob
  r.software = detectSoftware(r.version.name);
  const { favicon, ...raw } = d;
  r.raw = raw;
}

function applyLegacy(r, v) {
  r.online = true;
  r.legacy = true;
  r.latency = v.latency;
  r.latencyMethod = 'legacy ping';
  r.version = { name: v.version, protocol: v.protocol };
  r.players = { online: v.online, max: v.max, list: [], hover: [] };
  r.motd = { raw: v.motd, clean: v.motd.replace(/§./g, '') };
  r.software = detectSoftware(v.version);
  r.raw = v;
}

function applyQuery(r, q) {
  const { kv, players } = q;
  const p = parsePlugins(kv.plugins);
  r.query = {
    enabled: true,
    software: p.software,
    plugins: p.plugins,
    map: kv.map || null,
    gameType: kv.gametype || null,
    gameId: kv.game_id || null,
    version: kv.version || null,
    hostIp: kv.hostip || null,
    hostPort: num(kv.hostport),
    motd: kv.hostname || null,
    players,
  };
  if (p.software) r.software = p.software;
  if (!r.online) {
    // The TCP ping failed but Query answered, so the server is up.
    r.online = true;
    r.error = null;
    r.version = { name: kv.version || '', protocol: null };
    r.players = { online: num(kv.numplayers) ?? players.length, max: num(kv.maxplayers) ?? 0, list: [], hover: [] };
    r.motd = { raw: kv.hostname || '', clean: (kv.hostname || '').replace(/§./g, '') };
  }
  const known = new Set(r.players.list.map((x) => x.name.toLowerCase()));
  for (const name of players) if (!known.has(name.toLowerCase())) r.players.list.push({ name, id: null });
}

async function checkJava(r, handshakeHost, quick) {
  const [status, q] = await Promise.all([javaStatus(r.ip, r.port, handshakeHost).catch((err) => err), quick ? null : query(r.ip, r.port)]);
  if (!(status instanceof Error)) applyModern(r, status);
  else if (status.connected) {
    try {
      applyLegacy(r, await legacyStatus(r.ip, r.port));
    } catch {
      r.error = describe(status);
    }
  } else r.error = describe(status);
  if (q) applyQuery(r, q);
  else if (!quick) r.query = { enabled: false };
}

async function checkBedrock(r) {
  try {
    const b = await bedrockStatus(r.ip, r.port);
    const { latency, ...raw } = b;
    r.online = true;
    r.latency = latency;
    r.latencyMethod = 'RakNet ping';
    r.version = { name: b.version, protocol: b.protocol };
    r.players = { online: b.online, max: b.max, list: [], hover: [] };
    const motd = [b.motd, b.levelName].filter(Boolean).join('\n');
    r.motd = { raw: motd, clean: motd.replace(/§./g, '') };
    r.bedrock = { edition: b.edition, serverId: b.serverId, levelName: b.levelName, gamemode: b.gamemode, gamemodeId: b.gamemodeId, portV4: b.portV4, portV6: b.portV6 };
    r.raw = raw;
  } catch (err) {
    r.error = describe(err);
  }
}

/** Everything about one server. quick=true (used for the favorites list) skips DNS dumps, Query and the block list. */
async function check(address, edition = 'java', { quick = false } = {}) {
  const started = Date.now();
  const { host, port: explicitPort } = parseAddress(address);
  const r = {
    edition,
    address: formatAddress(host, explicitPort),
    host,
    port: explicitPort || DEFAULT_PORT[edition],
    ip: null,
    srv: null,
    online: false,
    error: null,
    latency: null,
    timings: {},
    checkedAt: started,
  };

  // Like the game, only Java looks for an SRV record, and only when no port was typed.
  if (edition === 'java' && !explicitPort && !net.isIP(host)) {
    const t = Date.now();
    const recs = await tryq(() => resolver.resolveSrv(`_minecraft._tcp.${host}`));
    r.timings.srv = since(t);
    if (recs?.length) {
      recs.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      r.srv = { target: recs[0].name.replace(/\.$/, ''), port: recs[0].port, priority: recs[0].priority, weight: recs[0].weight };
      r.port = r.srv.port;
    }
  }
  const connectHost = r.srv?.target || host;
  const records = quick ? null : dnsRecords(host, r.srv);

  try {
    const t = Date.now();
    r.ip = net.isIP(connectHost) ? connectHost : (await dns.promises.lookup(connectHost)).address;
    r.timings.lookup = since(t);
  } catch (err) {
    r.error = err.code === 'ENOTFOUND' ? `${connectHost} does not resolve to an IP address` : describe(err);
  }

  if (r.ip) {
    const extras = quick
      ? null
      : Promise.all([tryq(() => resolver.reverse(r.ip)), edition === 'java' ? blockedCheck([...new Set([host, connectHost, r.ip])]) : null]);
    if (edition === 'java') await checkJava(r, host, quick);
    else await checkBedrock(r);
    if (extras) [r.reverse, r.blocked] = await extras;
    r.reverse = r.reverse || [];
  }
  if (records) r.dns = await records;
  r.timings.total = since(started);
  return r;
}

module.exports = { check, favorite, parseAddress };
