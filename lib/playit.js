'use strict';
// playit.gg: a free tunnel that gives servers a public address without port forwarding. The panel downloads the
// official playit agent, runs it in the background with its own settings, and talks to it over the agent's local
// socket, the same way playit's own CLI does.
//
// A playit installed the normal way (playit's installer, or its Linux package) is detected too: while the panel's own
// agent is off, the panel connects to that one instead, shows its tunnels and puts their addresses on the servers. It
// never stops, updates or unlinks that agent; playit's own app manages it.
//
// Only when the panel runs on your own computer. On Railway the TCP proxy does this job.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const store = require('./store');
const providers = require('./providers');
const { httpError } = require('./util');

const RELEASES = 'https://api.github.com/repos/playit-cloud/playit-agent/releases/latest';
const API = 'https://api.playit.gg';
const IPC_VERSION = 2;
const ASSETS = {
  'win32-x64': 'playit-windows-x86_64-signed.exe',
  'win32-ia32': 'playit-windows-x86-signed.exe',
  'linux-x64': 'playit-linux-amd64',
  'linux-arm64': 'playit-linux-aarch64',
  'linux-arm': 'playit-linux-armv7',
  'linux-ia32': 'playit-linux-i686',
};
const ASSET = ASSETS[`${process.platform}-${process.arch}`];
const ON_RAILWAY = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);

const DIR = path.join(store.DATA_DIR, 'playit');
const BIN = path.join(DIR, process.platform === 'win32' ? 'playit.exe' : 'playit');
const SECRET = path.join(DIR, 'playit.toml');
const LOG = path.join(DIR, 'playit.log');
const VERSION_FILE = path.join(DIR, 'version.txt');
const TAG = crypto.createHash('sha1').update(store.DATA_DIR).digest('hex').slice(0, 10);
const SOCKET =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\webmc-playit-${TAG}`
    : path.join(DIR, 'playitd.sock').length < 100
      ? path.join(DIR, 'playitd.sock')
      : path.join(os.tmpdir(), `webmc-playit-${TAG}.sock`);

// Where a playit installed the normal way listens (playit-ipc/src/paths.rs), and files that show it is installed.
const HOME = os.homedir();
const EXTERNAL = ON_RAILWAY
  ? null
  : {
      linux: { socket: '/run/playit/playitd.sock', installed: ['/opt/playit/playitd', '/etc/playit'], start: 'sudo systemctl start playit' },
      win32: {
        socket: '\\\\.\\pipe\\playitd-system',
        installed: [path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'playit_gg')],
        start: 'Start playit from the Start menu',
      },
      darwin: {
        socket: path.join(HOME, 'Library', 'Application Support', 'playit_gg', 'playitd.sock'),
        installed: [path.join(HOME, 'Library', 'Application Support', 'playit_gg')],
        start: 'Open the playit app',
      },
    }[process.platform] || null;
// A playit started with its own --socket-path: tell the panel where (WEBMC_PLAYIT_SOCKET in .env).
if (EXTERNAL && process.env.WEBMC_PLAYIT_SOCKET) EXTERNAL.socket = process.env.WEBMC_PLAYIT_SOCKET;

const settings = () => (store.state.settings.playit ||= { enabled: false });

let proc = null;
let sock = null;
let using = null; // whose agent sock talks to: 'own' (the panel's) or 'external' (installed on this computer)
let external = { state: 'none', message: null, checkedAt: 0 }; // state: none, installed (not running), running, denied, error
let probing = null;
let stopping = false;
let restartTimer = null;
let restartDelay = 2000;
let busy = null; // 'Downloading playit' and the like
let lastError = null;
let snapshot = null; // { status, lifecycle, stats } from the agent
let claim = null; // { code, url, state, error }
let nextId = 1;
const pending = new Map();
const logTail = [];

function supported() {
  if (ON_RAILWAY) return { ok: false, reason: 'On Railway, use its TCP proxy instead (Settings → Networking). playit.gg is for panels running on your own computer.' };
  if (!ASSET) return { ok: false, reason: `WebbMC can only run its own playit agent on Windows and Linux, not on ${process.platform} ${process.arch}.` };
  return { ok: true };
}

const remember = (line) => {
  const text = String(line).trim();
  if (!text) return;
  logTail.push(text.slice(0, 500));
  if (logTail.length > 40) logTail.shift();
};

// ---------------------------------------------------------------- talking to the agent (newline-delimited JSON)

function connect(target = SOCKET, kind = 'own') {
  if (sock || (kind === 'own' && !proc)) return;
  const s = net.connect(target);
  sock = s;
  using = kind;
  let buf = '';
  s.setEncoding('utf8');
  s.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        onMessage(JSON.parse(line));
      } catch {
        /* not JSON: ignore */
      }
    }
  });
  const lost = () => {
    if (sock !== s) return;
    sock = null;
    for (const p of pending.values()) p.reject(new Error('Lost the connection to the playit agent'));
    pending.clear();
    if (kind === 'own') {
      if (proc && !stopping) setTimeout(connect, 1000);
    } else {
      // The playit on this computer stopped (or restarted): forget its tunnels and look for it again.
      using = null;
      snapshot = null;
      setTimeout(probe, 3000);
    }
  };
  s.on('error', lost);
  s.on('close', lost);
}

function onMessage(msg) {
  const data = msg.data || {};
  if (msg.message_kind === 'hello') {
    if (data.protocol?.ipc_version !== IPC_VERSION) {
      lastError = `This playit agent speaks a newer protocol (${data.protocol?.ipc_version}). Update WebbMC.`;
      return;
    }
    request({ type: 'subscribe' })
      .then((r) => (snapshot = r.snapshot))
      .catch(() => {});
  } else if (msg.message_kind === 'response') {
    const p = pending.get(data.request_id);
    if (!p) return;
    pending.delete(data.request_id);
    const r = data.response || {};
    if (r.type === 'error') p.reject(new Error(r.data?.message || 'The playit agent refused the request'));
    else p.resolve(r.data);
  } else if (msg.message_kind === 'event') {
    const ev = data.event || {};
    if (!snapshot) snapshot = {};
    if (ev.type === 'status') snapshot.status = ev.data;
    else if (ev.type === 'lifecycle') snapshot.lifecycle = ev.data;
    else if (ev.type === 'stats') snapshot.stats = ev.data;
    else if (ev.type === 'log' && ev.data?.message) remember(`[${ev.data.level}] ${ev.data.message}`);
  }
}

function request(req) {
  return new Promise((resolve, reject) => {
    if (!sock) return reject(new Error('The playit agent is not running'));
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('The playit agent did not answer'));
    }, 10000);
    pending.set(id, {
      resolve: (v) => (clearTimeout(timer), resolve(v)),
      reject: (e) => (clearTimeout(timer), reject(e)),
    });
    sock.write(`${JSON.stringify({ ipc_version: IPC_VERSION, request_id: id, request: req })}\n`);
  });
}

// ---------------------------------------------------------------- the agent process

function startAgent() {
  if (proc || !fs.existsSync(BIN)) return;
  dropExternal(); // the panel's own agent takes over
  stopping = false;
  lastError = null;
  if (process.platform !== 'win32') fs.rmSync(SOCKET, { force: true }); // left over from a crash
  const p = spawn(BIN, ['--secret-path', SECRET, '--socket-path', SOCKET, '--log-path', LOG], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  proc = p;
  p.stdout.on('data', (d) => String(d).split('\n').forEach(remember));
  p.stderr.on('data', (d) => String(d).split('\n').forEach(remember));
  p.on('error', (err) => {
    lastError = `Could not start the playit agent: ${err.message}`;
  });
  p.on('exit', (code) => {
    if (proc !== p) return;
    proc = null;
    sock?.destroy();
    sock = null;
    snapshot = null;
    if (stopping || !settings().enabled) return;
    lastError = `The playit agent stopped (exit code ${code}). Restarting it in ${Math.round(restartDelay / 1000)}s.`;
    restartTimer = setTimeout(startAgent, restartDelay);
    restartDelay = Math.min(restartDelay * 2, 60000);
  });
  setTimeout(connect, 700);
  setTimeout(() => proc === p && (restartDelay = 2000), 60000); // ran for a minute: reset the back-off
}

function stopAgent() {
  stopping = true;
  clearTimeout(restartTimer);
  sock?.destroy();
  sock = null;
  using = null;
  snapshot = null;
  const p = proc;
  proc = null;
  if (!p) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    p.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    p.kill();
  });
}

// ---------------------------------------------------------------- a playit installed on this computer

/** Say hello to the agent at `target`: running, denied (no permission), none (nothing there) or error. */
function hello(target) {
  return new Promise((resolve) => {
    const s = net.connect(target);
    let buf = '';
    let timer = null;
    const done = (r) => {
      clearTimeout(timer);
      s.destroy();
      resolve(r);
    };
    timer = setTimeout(() => done({ state: 'error', message: 'Something listens where playit does, but it did not answer.' }), 3000);
    s.setEncoding('utf8');
    s.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      let msg = null;
      try {
        msg = JSON.parse(buf.slice(0, i));
      } catch {
        /* not JSON */
      }
      if (msg?.message_kind !== 'hello') return done({ state: 'error', message: 'Something listens where playit does, but it is not a playit agent.' });
      const v = msg.data?.protocol?.ipc_version;
      if (v !== IPC_VERSION) {
        return done({ state: 'error', message: `The playit on this computer speaks protocol ${v}, and WebbMC speaks ${IPC_VERSION}. Update ${v > IPC_VERSION ? 'WebbMC' : 'playit'}.` });
      }
      done({ state: 'running', version: msg.data?.protocol?.agent_version || msg.data?.version || null });
    });
    s.on('error', (err) => done(err.code === 'EACCES' || err.code === 'EPERM' ? { state: 'denied' } : { state: 'none' }));
  });
}

/** Look for a playit running on this computer outside the panel, and use it while the panel's own agent is off. */
function probe() {
  if (!EXTERNAL || probing || (using === 'external' && sock)) return probing || Promise.resolve();
  probing = (async () => {
    const r = await hello(EXTERNAL.socket);
    if (r.state === 'none' && EXTERNAL.installed.some((p) => fs.existsSync(p))) r.state = 'installed';
    const seen = external.checkedAt > 0 && external.state === 'running';
    const first = !external.checkedAt;
    external = { message: null, ...r, checkedAt: Date.now() };
    if (r.state === 'running' && !seen && !first) store.logActivity(null, 'Found playit running on this computer');
    if (r.state === 'running' && !proc && !sock) connect(EXTERNAL.socket, 'external');
  })().finally(() => (probing = null));
  return probing;
}

function dropExternal() {
  if (using !== 'external') return;
  const s = sock;
  sock = null; // before destroy, so its close handler does not look for it again
  using = null;
  snapshot = null;
  s?.destroy();
}

/** Download the agent for this computer from playit's GitHub releases, checking its SHA-256. */
async function install() {
  const res = await fetch(RELEASES, { headers: { 'User-Agent': 'WebbMC', Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw httpError(502, `GitHub answered HTTP ${res.status} when looking up the playit agent`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => a.name === ASSET);
  if (!asset) throw httpError(502, `The latest playit release (${rel.tag_name}) has no ${ASSET}`);
  await fsp.mkdir(DIR, { recursive: true });
  const tmp = `${BIN}.download`;
  await providers.download(asset.browser_download_url, tmp);
  const want = /^sha256:([0-9a-f]{64})$/.exec(asset.digest || '')?.[1];
  const got = crypto.createHash('sha256').update(await fsp.readFile(tmp)).digest('hex');
  if (want && got !== want) {
    await fsp.rm(tmp, { force: true });
    throw httpError(502, 'The downloaded playit agent does not match its published checksum. Try again later.');
  }
  await stopAgent();
  await fsp.rename(tmp, BIN);
  if (process.platform !== 'win32') await fsp.chmod(BIN, 0o755);
  await fsp.writeFile(VERSION_FILE, rel.tag_name || '');
  return rel.tag_name;
}

// ---------------------------------------------------------------- linking a playit account (claim)

async function call(p, body) {
  const res = await fetch(`${API}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return res.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runClaim(c) {
  const mine = () => claim === c;
  const deadline = Date.now() + 20 * 60 * 1000;
  const version = `WebbMC ${require('../package.json').version}`;
  try {
    for (;;) {
      if (!mine()) return;
      if (Date.now() > deadline) throw new Error('The link expired before it was approved. Start again.');
      const r = await call('/claim/setup', { code: c.code, agent_type: 'assignable', version }).catch(() => null);
      if (r?.status === 'success') {
        if (r.data === 'UserAccepted') break;
        if (r.data === 'UserRejected') throw new Error('The link was declined on playit.gg.');
        c.state = r.data === 'WaitingForUser' ? 'approve' : 'visit';
      } else if (r?.status === 'fail') throw new Error(`playit.gg said: ${r.data}`);
      await sleep(2000);
    }
    c.state = 'finishing';
    let secret = null;
    while (!secret) {
      if (!mine()) return;
      if (Date.now() > deadline) throw new Error('playit.gg did not hand over the agent key in time. Start again.');
      const r = await call('/claim/exchange', { code: c.code }).catch(() => null);
      if (r?.status === 'success') secret = r.data?.secret_key;
      else await sleep(2000);
    }
    // Hand the key to the waiting agent; it saves it to playit.toml and starts the tunnels.
    try {
      await request({ type: 'set_secret', secret });
    } catch (err) {
      if (using === 'external') throw new Error(`The playit on this computer did not take the key: ${err.message}`);
      await stopAgent();
      await fsp.writeFile(SECRET, `secret_key = "${secret}"\n`, { mode: 0o600 });
      startAgent();
    }
    if (mine()) claim = null;
    store.logActivity(null, 'playit.gg agent linked to a playit account');
  } catch (err) {
    if (mine()) Object.assign(c, { state: 'error', error: err.message });
  }
}

// ---------------------------------------------------------------- what the panel uses

function status() {
  const sup = supported();
  const lc = snapshot?.lifecycle || null;
  const agent = lc?.state === 'running' ? lc.data : null;
  let version = '';
  try {
    version = fs.readFileSync(VERSION_FILE, 'utf8').trim();
  } catch {
    /* not installed */
  }
  // Not connected: look again now and then (a playit started after the panel is found within seconds).
  if (EXTERNAL && !sock && Date.now() - external.checkedAt > 10000) probe();
  return {
    supported: sup.ok,
    reason: sup.reason || null,
    source: sock ? using : null, // 'own' or 'external': whose agent the tunnels below come from
    external: EXTERNAL && {
      state: external.state,
      message: external.message,
      inUse: using === 'external' && Boolean(sock),
      start: EXTERNAL.start,
      user: os.userInfo().username,
      platform: process.platform,
    },
    enabled: Boolean(settings().enabled),
    installed: fs.existsSync(BIN),
    version,
    running: Boolean(proc),
    connected: Boolean(sock && snapshot),
    busy,
    error: lastError,
    // waiting_for_secret (needs linking), running, has_invalid_secret, disabled_over_limit, starting, error...
    state: lc?.state || (proc ? 'starting' : 'off'),
    problem: lc && lc.state !== 'running' && lc.data?.message ? lc.data.message : null,
    claim: claim && { url: claim.url, state: claim.state, error: claim.error || null },
    tunnels: (agent?.tunnels || []).map((t) => ({ address: t.display_address, destination: t.destination, disabled: t.is_disabled, reason: t.disabled_reason })),
    pendingTunnels: (agent?.pending_tunnels || []).map((t) => t.status_msg),
    notices: (agent?.notices || []).map((n) => ({ message: n.message, link: n.resolve_link })),
    accountStatus: agent?.account_status || null,
    loginLink: agent?.login_link || null,
    stats: snapshot?.stats || null,
    log: logTail.slice(-15),
  };
}

const assertSupported = () => {
  const sup = supported();
  if (!sup.ok) throw httpError(400, sup.reason);
};

async function act(action) {
  if (action === 'check') {
    if (!EXTERNAL) throw httpError(400, 'There is nothing to look for here');
    external.checkedAt = 0;
    await probe();
    return status();
  }
  if (using === 'external' && sock && ['unlink', 'update', 'disable'].includes(action)) {
    throw httpError(400, 'This playit agent was installed on this computer outside WebbMC. Manage it with playit itself or on playit.gg.');
  }
  if (action !== 'link' && action !== 'cancel-link') assertSupported();
  if (busy) throw httpError(409, `${busy}...`);
  const s = settings();
  const withBusy = async (label, fn) => {
    busy = label;
    try {
      return await fn();
    } finally {
      busy = null;
    }
  };
  switch (action) {
    case 'enable':
      if (!fs.existsSync(BIN)) await withBusy('Downloading the playit agent', install);
      s.enabled = true;
      store.save();
      startAgent();
      store.logActivity(null, 'playit.gg tunnel agent turned on');
      break;
    case 'disable':
      s.enabled = false;
      store.save();
      claim = null;
      await stopAgent();
      store.logActivity(null, 'playit.gg tunnel agent turned off');
      await probe(); // a playit installed on this computer takes over, if there is one
      break;
    case 'use-existing':
      // Use the playit installed on this computer instead of the panel's own agent.
      s.enabled = false;
      store.save();
      claim = null;
      await stopAgent();
      external.checkedAt = 0;
      await probe();
      if (using !== 'external') throw httpError(409, 'The playit on this computer is not answering any more. WebbMC\'s own agent is off; turn it back on if you need it.');
      store.logActivity(null, 'playit.gg: switched to the playit installed on this computer');
      break;
    case 'update': {
      const tag = await withBusy('Updating the playit agent', install);
      if (s.enabled) startAgent();
      store.logActivity(null, `playit.gg agent updated to ${tag}`);
      break;
    }
    case 'link': {
      if (!sock) throw httpError(409, 'Turn playit.gg on first');
      const code = crypto.randomBytes(5).toString('hex');
      claim = { code, url: `https://playit.gg/claim/${code}`, state: 'visit' };
      runClaim(claim);
      break;
    }
    case 'cancel-link':
      claim = null;
      break;
    case 'unlink':
      // The agent forgets its key and waits to be linked again. Tunnels stay in the playit.gg account.
      claim = null;
      try {
        await request({ type: 'reset_secret' });
      } catch {
        await stopAgent();
        await fsp.rm(SECRET, { force: true });
        if (s.enabled) startAgent();
      }
      store.logActivity(null, 'playit.gg agent unlinked from its account');
      break;
    default:
      throw httpError(400, 'Unknown playit action');
  }
  await sleep(300);
  return status();
}

/** The playit address of a tunnel that points at this port on this machine, if there is one. */
function addressFor(port) {
  const lc = snapshot?.lifecycle;
  if (lc?.state !== 'running') return '';
  const t = (lc.data?.tunnels || []).find((x) => !x.is_disabled && Number(/:(\d+)\s*$/.exec(x.destination || '')?.[1]) === Number(port));
  return t?.display_address || '';
}

function init() {
  if (settings().enabled && supported().ok && fs.existsSync(BIN)) startAgent();
  else probe();
  // Keep looking for a playit on this computer while nothing is connected (it may start after the panel).
  if (EXTERNAL) setInterval(() => !sock && probe(), 30000).unref();
}

module.exports = { status, act, addressFor, init, stop: stopAgent };
