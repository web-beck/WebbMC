'use strict';
// Every port the panel's servers use: the game port, RCON and Query from server.properties, and the ports plugins
// and mods open (web maps such as BlueMap and Dynmap, Geyser for Bedrock players, voice chat, Votifier, Plan).
// TCP ports are tried on this machine, which shows ports that are open, closed, or taken by another program.
const fs = require('fs');
const net = require('net');
const path = require('path');
const software = require('./software');
const properties = require('./properties');

const read = (dir, rel) => {
  try {
    return fs.readFileSync(path.join(dir, rel), 'utf8');
  } catch {
    return null;
  }
};

/** A value from an indented YAML (or HOCON-style "key: value") file by its key path, such as ['bedrock', 'port']. */
function yamlGet(text, keys) {
  const want = keys.join('.').toLowerCase();
  const stack = []; // { indent, key } of the keys that enclose the current line
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^(\s*)([A-Za-z0-9_.\-"']+)\s*[:=]\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[2].replace(/["']/g, '').toLowerCase() });
    if (stack.map((k) => k.key).join('.') === want) return m[3].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
  }
  return null;
}

const portOf = (v) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
};
const isOff = (v) => v != null && /^(false|no|off)$/i.test(String(v).trim());
const isOn = (v) => v != null && /^(true|yes|on)$/i.test(String(v).trim());

/**
 * Plugins and mods that open a port. `files` are tried in order (Paper plugin folder, then Fabric config); when none
 * exists yet but the jar is installed, the default port is shown until the plugin writes its config.
 */
const ADDONS = [
  {
    what: 'BlueMap web map',
    jar: /bluemap/i,
    proto: 'tcp',
    files: ['plugins/BlueMap/webserver.conf', 'config/bluemap/webserver.conf'],
    port: (t) => (isOff(yamlGet(t, ['enabled'])) ? null : portOf(yamlGet(t, ['port']))),
    fallback: 8100,
  },
  {
    what: 'Dynmap web map',
    jar: /dynmap/i,
    proto: 'tcp',
    files: ['plugins/dynmap/configuration.txt', 'dynmap/configuration.txt'],
    port: (t) => (isOn(yamlGet(t, ['disable-webserver'])) ? null : portOf(yamlGet(t, ['webserver-port']))),
    fallback: 8123,
  },
  {
    what: 'squaremap web map',
    jar: /squaremap/i,
    proto: 'tcp',
    files: ['plugins/squaremap/config.yml', 'config/squaremap/config.yml'],
    port: (t) => (isOff(yamlGet(t, ['settings', 'internal-webserver', 'enabled'])) ? null : portOf(yamlGet(t, ['settings', 'internal-webserver', 'port']))),
    fallback: 8080,
  },
  {
    what: 'Pl3xMap web map',
    jar: /pl3xmap/i,
    proto: 'tcp',
    files: ['plugins/Pl3xMap/config.yml', 'config/pl3xmap/config.yml'],
    port: (t) => (isOff(yamlGet(t, ['settings', 'internal-webserver', 'enabled'])) ? null : portOf(yamlGet(t, ['settings', 'internal-webserver', 'port']))),
    fallback: 8080,
  },
  {
    what: 'Geyser (Bedrock players)',
    jar: /geyser/i,
    proto: 'udp',
    files: ['plugins/Geyser-Spigot/config.yml', 'plugins/Geyser-Velocity/config.yml', 'plugins/Geyser-BungeeCord/config.yml', 'config/Geyser-Fabric/config.yml', 'config/geyser/config.yml'],
    port: (t, game) => (isOn(yamlGet(t, ['bedrock', 'clone-remote-port'])) ? game : portOf(yamlGet(t, ['bedrock', 'port']))),
    fallback: 19132,
  },
  {
    what: 'Simple Voice Chat',
    jar: /voicechat/i,
    proto: 'udp',
    files: ['plugins/voicechat/voicechat-server.properties', 'config/voicechat/voicechat-server.properties'],
    // -1 means the voice chat shares the game's port (over UDP).
    port: (t, game) => {
      const v = properties.parse(t).port;
      return Number(v) === -1 ? game : portOf(v);
    },
    fallback: 24454,
  },
  {
    what: 'Votifier (vote listener)',
    jar: /votifier/i,
    proto: 'tcp',
    files: ['plugins/Votifier/config.yml', 'plugins/NuVotifier/config.yml', 'plugins/nuvotifier/config.yml', 'config/nuvotifier/config.yml'],
    port: (t) => portOf(yamlGet(t, ['port'])),
    fallback: 8192,
  },
  {
    what: 'Plan web panel',
    jar: /^plan/i,
    proto: 'tcp',
    files: ['plugins/Plan/config.yml', 'config/plan/config.yml'],
    port: (t) => (isOn(yamlGet(t, ['webserver', 'disable_webserver'])) ? null : portOf(yamlGet(t, ['webserver', 'port']))),
    fallback: 8804,
  },
];

function jarsIn(dir) {
  const out = [];
  for (const sub of ['plugins', 'mods']) {
    try {
      for (const f of fs.readdirSync(path.join(dir, sub))) if (/\.jar$/i.test(f)) out.push(f);
    } catch {
      /* no such folder */
    }
  }
  return out;
}

/** The ports one server uses, read from its files. */
function forServer(inst) {
  const cfg = inst.cfg;
  const dir = cfg.dir;
  const info = software.info(cfg);
  const base = { serverId: cfg.id, server: cfg.name, owner: cfg.owner || null, running: Boolean(inst.proc) };
  const list = [{ ...base, what: info.proxy ? `${info.kind === 'velocity' ? 'Velocity' : 'BungeeCord'} proxy` : 'Minecraft (Java players)', port: info.port, proto: 'tcp', file: info.configFile, ip: info.ip, game: true, public: inst.publicAddress(info.port) || null }];

  if (!info.proxy) {
    const props = properties.parse(read(dir, 'server.properties') || '');
    if (isOn(props['enable-rcon'])) list.push({ ...base, what: 'RCON (remote console)', port: portOf(props['rcon.port']) || 25575, proto: 'tcp', file: 'server.properties' });
    if (isOn(props['enable-query'])) list.push({ ...base, what: 'Query', port: portOf(props['query.port']) || info.port, proto: 'udp', file: 'server.properties' });
  }

  const jars = jarsIn(dir);
  for (const a of ADDONS) {
    const file = a.files.find((f) => fs.existsSync(path.join(dir, f)));
    if (file) {
      const port = a.port(read(dir, file), info.port);
      if (port) list.push({ ...base, what: a.what, port, proto: a.proto, file });
    } else if (jars.some((j) => a.jar.test(j))) {
      list.push({ ...base, what: a.what, port: a.fallback, proto: a.proto, file: null, note: 'Default port: the config file is written on the first start' });
    }
  }
  return list;
}

/** Resolves true when something accepts a TCP connection on the port. */
function listening(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(600, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/**
 * Every port on the panel, sorted by number. status: 'open' (running and answering), 'closed' (running but nothing
 * answers yet), 'free' (stopped), 'taken' (stopped, yet another program answers on it) or 'udp' (cannot be tried).
 * `clash` lists the other uses of the same port and protocol.
 */
async function list(instances, panelPort) {
  const rows = [{ serverId: null, server: 'WebbMC panel', owner: null, running: true, what: 'Panel website', port: panelPort, proto: 'tcp', file: null }];
  for (const inst of instances) rows.push(...forServer(inst));
  await Promise.all(
    rows.map(async (r) => {
      if (r.proto !== 'tcp') return void (r.status = 'udp');
      const host = r.ip && !['0.0.0.0', '::', '*', ''].includes(r.ip) ? r.ip : '127.0.0.1';
      const up = await listening(r.port, host);
      r.status = r.running ? (up ? 'open' : 'closed') : up ? 'taken' : 'free';
    }),
  );
  for (const r of rows) {
    const others = rows.filter((o) => o !== r && o.port === r.port && o.proto === r.proto);
    if (others.length) r.clash = others.map((o) => `${o.server}: ${o.what}`);
  }
  return rows.sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

module.exports = { list, forServer, yamlGet };
