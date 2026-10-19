'use strict';
// Registry of servers plus the background monitor (CPU/RAM sampling and status pings).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const store = require('./store');
const Instance = require('./instance');
const providers = require('./providers');
const properties = require('./properties');
const files = require('./files');
const stats = require('./stats');
const slp = require('./slp');
const software = require('./software');
const motd = require('./motd');
const java = require('./java');
const auth = require('./auth');
const { httpError, int } = require('./util');

const instances = new Map();
const SAMPLE_MS = 3000;
const HISTORY = 200; // 10 minutes at 3s
const TYPES = [...providers.TYPES, 'custom', 'import'];

let host = { cpu: 0, cores: os.cpus().length, memTotal: os.totalmem(), memUsed: 0, disk: null };

function init() {
  java.cleanup();
  for (const cfg of store.state.servers) {
    // Server folders are saved as absolute paths. If the panel folder was renamed or moved, find them again.
    const own = path.join(store.SERVERS_DIR, cfg.id);
    if (cfg.type !== 'import' && !fs.existsSync(cfg.dir) && fs.existsSync(own)) {
      console.log(`[webbmc] ${cfg.name}: folder moved, now using ${own}`);
      cfg.dir = own;
    }
    const inst = new Instance(cfg);
    instances.set(cfg.id, inst);
    if (cfg.lastPid && isAlive(cfg.lastPid)) {
      inst.panel(
        `A process (PID ${cfg.lastPid}) from a previous panel session may still be running. ` +
          'If the port is in use, end that process before starting.',
      );
    }
    delete cfg.lastPid;
  }
  // Servers that were running when the panel restarted to update start again, like auto-start ones.
  const resume = new Set(store.state.resume || []);
  store.state.resume = [];
  store.save();
  monitor();
  let delay = 1000;
  for (const inst of instances.values()) {
    if (!inst.cfg.autoStart && !resume.has(inst.id)) continue;
    setTimeout(() => inst.start().catch((e) => inst.panel(`Auto-start failed: ${e.message}`)), delay);
    delay += 3000;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function get(id) {
  const inst = instances.get(id);
  if (!inst) throw httpError(404, 'Server not found');
  return inst;
}

const list = () => [...instances.values()].map((i) => i.summary());

function nextPort() {
  const used = new Set([...store.reservedPorts, ...[...instances.values()].map((i) => software.info(i.cfg).port)]);
  let port = 25565;
  while (used.has(port)) port++;
  return port;
}

/**
 * Who a new server belongs to: an account id (a Google email or a username). Admins may create one for anyone;
 * everyone else owns what they create. Without accounts (no sign-in, or a shared key) servers have no owner.
 */
function ownerFor(b, user) {
  if (!user.id) return null;
  if (!user.admin || !b.owner) return user.id;
  const owner = String(b.owner).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner) && !/^[a-z0-9_.-]{3,24}$/.test(owner)) throw httpError(400, 'The owner must be an email address or a username');
  return owner;
}

/** Non-admins may only pick a Java the panel already knows about, not run any program on the host. */
function checkJavaPath(javaPath, user) {
  const p = String(javaPath || '').trim();
  if (p && !user.admin && !java.candidates().includes(p)) throw httpError(403, 'Pick one of the Java versions in the list. Only the admin can use another path.');
  return p;
}

async function create(b, user) {
  const name = String(b.name || '').trim().slice(0, 64);
  if (!name) throw httpError(400, 'Give the server a name');
  const type = String(b.type || '');
  if (!TYPES.includes(type)) throw httpError(400, 'Pick the server software');
  if (type === 'import' && !user.admin) throw httpError(403, 'Only the admin can import a folder from the host');
  const s = store.state.settings;
  const id = crypto.randomBytes(4).toString('hex');
  const maxRam = int(b.maxRam, s.defaultMaxRam, 256, 1 << 20);
  const cfg = {
    id,
    name,
    type,
    version: String(b.version || ''),
    dir: '',
    jar: 'server.jar',
    javaPath: '',
    minRam: Math.min(int(b.minRam, s.defaultMinRam, 0, 1 << 20), maxRam),
    maxRam,
    jvmArgs: '',
    serverArgs: 'nogui',
    autoStart: Boolean(b.autoStart),
    autoRestart: b.autoRestart !== false,
    stopTimeout: 60,
    eula: Boolean(b.eula),
    backup: { keep: 10, exclude: [] },
    owner: ownerFor(b, user),
    createdAt: Date.now(),
  };

  if (type === 'import') {
    const dir = path.resolve(String(b.importDir || '').trim() || '.');
    if (!b.importDir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, 'That folder does not exist');
    if ([...instances.values()].some((i) => path.resolve(i.dir) === dir)) throw httpError(409, 'That folder is already managed by another server');
    const jars = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.jar'));
    cfg.dir = dir;
    cfg.jar = String(b.jar || '').trim() || jars.find((j) => /server|paper|purpur|spigot|fabric|forge|minecraft/i.test(j)) || jars[0] || 'server.jar';
    cfg.serverArgs = String(b.serverArgs ?? 'nogui');
    if (fs.existsSync(path.join(dir, 'eula.txt')) && /eula\s*=\s*true/i.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8'))) cfg.eula = true;
  } else {
    const proxy = software.PROXIES.includes(type);
    if (type !== 'custom' && !cfg.version) throw httpError(400, 'Pick a version');
    if (!cfg.eula && !proxy) throw httpError(400, 'You need to accept the Minecraft EULA to run a server');
    const port = int(b.port, nextPort(), 1, 65535);
    const motdText = String(b.motd || `${name}, powered by WebbMC`).slice(0, 300);
    cfg.dir = path.join(store.SERVERS_DIR, id);
    fs.mkdirSync(cfg.dir, { recursive: true });
    if (proxy) {
      // The config file is written once the jar is downloaded (Velocity's default config comes from the jar).
      cfg.pendingProxy = { port, maxPlayers: int(b.maxPlayers, 500, 1, 100000), motd: motdText };
    } else {
      const props = {
        'server-port': port,
        'max-players': int(b.maxPlayers, 20, 1, 10000),
        gamemode: ['survival', 'creative', 'adventure', 'spectator'].includes(b.gamemode) ? b.gamemode : 'survival',
        difficulty: ['peaceful', 'easy', 'normal', 'hard'].includes(b.difficulty) ? b.difficulty : 'easy',
        'online-mode': b.onlineMode === false ? 'false' : 'true',
        'white-list': b.whitelist === false ? 'false' : 'true',
      };
      if (b.seed) props['level-seed'] = String(b.seed);
      fs.writeFileSync(path.join(cfg.dir, 'server.properties'), properties.stringify(props, '#Minecraft server properties (created by WebbMC)\n'));
      motd.write(cfg, motdText); // & color codes become § codes
      fs.writeFileSync(path.join(cfg.dir, 'eula.txt'), '# Accepted in the WebbMC panel\neula=true\n');
    }
  }

  store.state.servers.push(cfg);
  store.save();
  const inst = new Instance(cfg);
  instances.set(id, inst);
  store.logActivity(id, `Created server "${name}"${cfg.owner && cfg.owner !== user.id ? ` for ${cfg.owner}` : ''}`);

  if (providers.TYPES.includes(type)) {
    inst
      .install(type, cfg.version)
      .then(() => b.startAfter && inst.start())
      .catch((e) => inst.panel(`Could not finish setup: ${e.message}`));
  } else if (type === 'custom') {
    inst.panel('Custom server created. Upload your server jar in the Files tab (or set its name in Settings), then press Start.');
  } else if (b.startAfter) {
    inst.start().catch((e) => inst.panel(`Start failed: ${e.message}`));
  }
  return inst.summary();
}

function update(inst, b, user) {
  const c = inst.cfg;
  // First, so a refused rename changes nothing else. The file is renamed with the name (new versions are downloaded
  // under it too), unless a jar by the new name is already there: then that one is used.
  if (b.jar !== undefined) {
    const jar = String(b.jar).trim().replace(/\\/g, '/');
    if (!jar) throw httpError(400, 'Jar file cannot be empty');
    if (!/\.jar$/i.test(jar)) throw httpError(400, 'The server jar must end in .jar');
    const to = files.resolveIn(c.dir, jar);
    if (jar !== c.jar) {
      const from = files.resolveIn(c.dir, c.jar);
      if (fs.existsSync(from) && !fs.existsSync(to)) {
        if (inst.proc) throw httpError(409, 'Stop the server to rename its jar');
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.renameSync(from, to);
        store.logActivity(c.id, `Server jar renamed from ${c.jar} to ${jar}`);
      }
      c.jar = jar;
    }
  }
  if (b.owner !== undefined && (String(b.owner || '').trim().toLowerCase() || null) !== (c.owner || null)) {
    if (!user.admin) throw httpError(403, 'Only the admin can give a server to someone else');
    c.owner = b.owner ? ownerFor({ owner: b.owner }, user) : null;
    store.logActivity(c.id, c.owner ? `Server now belongs to ${c.owner}` : 'Server now belongs to the admins');
  }
  if (b.shared !== undefined) setShared(inst, b.shared, user);
  if (b.name !== undefined) {
    const name = String(b.name).trim().slice(0, 64);
    if (!name) throw httpError(400, 'Name cannot be empty');
    c.name = name;
  }
  if (b.javaPath !== undefined) c.javaPath = checkJavaPath(b.javaPath, user);
  if (b.maxRam !== undefined) c.maxRam = int(b.maxRam, c.maxRam, 256, 1 << 20);
  if (b.minRam !== undefined) c.minRam = int(b.minRam, c.minRam, 0, 1 << 20);
  if (c.minRam > c.maxRam) c.minRam = c.maxRam;
  for (const k of ['jvmArgs', 'serverArgs']) if (b[k] !== undefined) c[k] = String(b[k]);
  for (const k of ['autoStart', 'autoRestart', 'eula']) if (b[k] !== undefined) c[k] = Boolean(b[k]);
  if (b.stopTimeout !== undefined) c.stopTimeout = int(b.stopTimeout, 60, 10, 3600);
  if (b.publicAddress !== undefined) c.publicAddress = String(b.publicAddress).trim().slice(0, 255);
  if (b.backup) {
    const prev = c.backup || {};
    c.backup = {
      keep: int(b.backup.keep, prev.keep ?? 10, 0, 1000),
      format: ['tar.gz', 'tar', 'zip'].includes(b.backup.format) ? b.backup.format : prev.format || 'tar.gz',
      exclude: (Array.isArray(b.backup.exclude) ? b.backup.exclude : prev.exclude || [])
        .map((x) => String(x).trim())
        .filter(Boolean)
        .slice(0, 200),
    };
  }
  store.save();
  inst.emit('status');
  return inst.summary();
}

/** Accounts that may run and change this server besides its owner. They cannot delete it or change who it is shared with. */
function setShared(inst, list, user) {
  const c = inst.cfg;
  if (!auth.isOwner(user, c)) throw httpError(403, 'Only the owner can choose who this server is shared with');
  if (!Array.isArray(list)) throw httpError(400, 'Send a list of accounts');
  const next = [...new Set(list.map((n) => auth.accountId(n)))].filter((id) => id !== c.owner).slice(0, 50);
  const before = c.shared || [];
  for (const id of next.filter((x) => !before.includes(x))) store.logActivity(c.id, `${user.id || 'An admin'} shared "${c.name}" with ${id}`, 'info', id);
  for (const id of before.filter((x) => !next.includes(x))) store.logActivity(c.id, `${user.id || 'An admin'} stopped sharing "${c.name}" with ${id}`, 'info', id);
  if (next.length) c.shared = next;
  else delete c.shared;
}

async function remove(inst, { deleteFiles, deleteBackups }) {
  inst.assertIdle('delete it');
  instances.delete(inst.id);
  store.state.servers = store.state.servers.filter((c) => c.id !== inst.id);
  store.state.schedules = store.state.schedules.filter((s) => s.serverId !== inst.id);
  store.logActivity(inst.id, `Deleted server "${inst.cfg.name}"`);
  store.save();
  const managed = path.resolve(inst.dir).startsWith(path.resolve(store.SERVERS_DIR) + path.sep);
  if (deleteFiles && managed) await fs.promises.rm(inst.dir, { recursive: true, force: true });
  if (deleteBackups) await fs.promises.rm(path.join(store.BACKUPS_DIR, inst.id), { recursive: true, force: true });
  inst.removeAllListeners();
  return { ok: true, filesKept: !(deleteFiles && managed) };
}

let ticks = 0;
async function tick() {
  ticks++;
  host.cpu = stats.hostCpu();
  const mem = stats.memory();
  host.memTotal = mem.total;
  host.memUsed = mem.used;
  host.memLimited = mem.limited;
  if (ticks % 10 === 1) host.disk = await stats.disk(store.DATA_DIR);

  const running = [...instances.values()].filter((i) => i.proc?.pid);
  const samples = await stats.sampleProcs(running.map((i) => i.proc.pid));
  const now = Date.now();
  for (const inst of running) {
    const pid = inst.proc?.pid;
    const s = samples.get(pid);
    if (!s) continue;
    const prev = inst.lastSample;
    const cpu = prev && prev.pid === pid ? ((s.cpuMs - prev.cpuMs) / (now - prev.t) / host.cores) * 100 : 0;
    inst.lastSample = { pid, cpuMs: s.cpuMs, t: now };
    inst.stats = { cpu: Math.max(0, Math.min(100, cpu)), mem: s.rss };
    inst.history.push({ t: now, cpu: inst.stats.cpu, mem: s.rss, players: inst.playerCount() });
    if (inst.history.length > HISTORY) inst.history.splice(0, inst.history.length - HISTORY);
  }

  // Ask running servers for their status (player count and names) every tick. A successful ping also marks a slow
  // "starting" server as ready. Failures are kept so the Players tab can say why the count may be off.
  await Promise.all(
    running
      .filter((i) => i.status === 'running' || i.status === 'starting')
      .map(async (inst) => {
        const where = software.info(inst.cfg);
        const ip = where.ip && !['0.0.0.0', '::', '*'].includes(where.ip) ? where.ip : '127.0.0.1';
        const port = where.port;
        try {
          inst.syncPing(await slp.ping(port, ip));
          inst.pingError = null;
          if (inst.status === 'starting' && Date.now() - inst.startedAt > 5000) inst.setStatus('running');
        } catch (err) {
          if (inst.status !== 'running') return; // still starting: not listening yet is normal
          inst.ping = null;
          inst.pingError = `${ip}:${port} did not answer the status ping (${err.code || err.message})`;
        }
      }),
  );
}

function monitor() {
  const loop = async () => {
    try {
      await tick();
    } catch (err) {
      console.error('[webbmc] monitor error', err);
    }
    setTimeout(loop, SAMPLE_MS);
  };
  loop();
}

const hostStats = () => ({ ...host, uptime: os.uptime(), platform: process.platform, hostname: os.hostname() });

const javaVersion = (javaPath) => java.probe(String(javaPath || store.state.settings.javaPath || 'java'));

function stopAll(timeout) {
  Instance.shuttingDown = true;
  const running = [...instances.values()].filter((i) => i.proc);
  if (!running.length) return Promise.resolve();
  return new Promise((resolve) => {
    let left = running.length;
    const timer = setTimeout(() => {
      for (const i of running) i.kill();
      setTimeout(resolve, 1000);
    }, timeout);
    for (const inst of running) {
      inst.once('exited', () => {
        if (--left === 0) {
          clearTimeout(timer);
          resolve();
        }
      });
      inst.stop();
    }
  });
}

module.exports = { init, get, list, all: () => [...instances.values()], nextPort, create, update, remove, hostStats, javaVersion, javaCandidates: java.candidates, checkJavaPath, stopAll };
