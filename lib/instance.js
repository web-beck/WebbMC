'use strict';
// One managed Minecraft server: process lifecycle, console buffer and player tracking.
const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const store = require('./store');
const providers = require('./providers');
const properties = require('./properties');
const serverIcon = require('./icon');
const software = require('./software');
const java = require('./java');
const { httpError, splitArgs } = require('./util');

const MAX_LOG = 2000;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const DONE_RE = /Done \(\d+[.,]\d+s\)!/;
const PROXY_READY_RE = /\bListening on \//; // BungeeCord prints no "Done" line
// Join and leave lines. Minecraft 26.x logs them as "System chat: Steve joined the game". The "logged in with
// entity id" and "lost connection" lines are a second signal in case the wording changes again.
const NAME = '([.*A-Za-z0-9_]{1,20})';
const PLAYER_RE = new RegExp(`\\]:\\s+(?:System chat: )?${NAME}(?: \\(formerly known as [^)]*\\))? (joined|left) the game\\s*$`);
const LOGIN_RE = new RegExp(`\\]:\\s+${NAME}\\[/[^\\]]+\\] logged in with entity id`);
const LOST_RE = new RegExp(`\\]:\\s+${NAME} lost connection: `);
// Proxies: Velocity ("[connected player] Steve (/1.2.3.4:5678) has connected") and BungeeCord.
const VELOCITY_RE = new RegExp(`\\[connected player\\] ${NAME} \\([^)]*\\) has (connected|disconnected)`);
const BUNGEE_IN_RE = new RegExp(`\\[${NAME}(?:,\\s*/[^\\]]*)?\\] <-> InitialHandler has connected`);
const BUNGEE_OUT_RE = new RegExp(`\\[${NAME}\\] -> UpstreamBridge has disconnected`);
const CRASH_WINDOW = 10 * 60 * 1000;
const MAX_CRASHES = 3;

class Instance extends EventEmitter {
  static shuttingDown = false;

  constructor(cfg) {
    super();
    this.setMaxListeners(200);
    this.cfg = cfg;
    this.proc = null;
    this.status = 'stopped';
    this.busy = null;
    this.log = [];
    this.players = new Map();
    this.startedAt = null;
    this.stats = { cpu: 0, mem: 0 };
    this.history = [];
    this.ping = null;
    this.pingError = null;
    this.proxy = false; // set on start: a Velocity or BungeeCord proxy
    this.crashes = [];
    this.expectStop = false;
    this.restartPending = false;
    this.stopTimer = null;
    this.restartTimer = null;
    this.launching = false; // finding (or downloading) Java before the process starts
  }

  get id() {
    return this.cfg.id;
  }

  get dir() {
    return this.cfg.dir;
  }

  readProps() {
    try {
      return properties.parse(fs.readFileSync(path.join(this.dir, 'server.properties'), 'utf8'));
    } catch {
      return {};
    }
  }

  isOnline() {
    return Boolean(this.proc) && this.status === 'running';
  }

  push(line, kind = 'out') {
    const entry = { t: Date.now(), line, kind };
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);
    if (kind === 'out' || kind === 'err') this.parse(line.replace(ANSI_RE, ''));
    this.emit('line', entry);
  }

  panel(message) {
    this.push(`[WebbMC] ${message}`, 'panel');
  }

  parse(line) {
    if (this.status === 'starting' && (DONE_RE.test(line) || (this.proxy && PROXY_READY_RE.test(line)))) {
      this.setStatus('running');
      this.panel(`Server is ready (${((Date.now() - this.startedAt) / 1000).toFixed(1)}s)`);
    }
    let name = null;
    let joined = false;
    let m;
    if ((m = line.match(PLAYER_RE))) [name, joined] = [m[1], m[2] === 'joined'];
    else if ((m = line.match(LOGIN_RE))) [name, joined] = [m[1], true];
    else if ((m = line.match(LOST_RE))) [name, joined] = [m[1], false];
    else if (this.proxy && (m = line.match(VELOCITY_RE))) [name, joined] = [m[1], m[2] === 'connected'];
    else if (this.proxy && (m = line.match(BUNGEE_IN_RE))) [name, joined] = [m[1], true];
    else if (this.proxy && (m = line.match(BUNGEE_OUT_RE))) [name, joined] = [m[1], false];
    if (!name || joined === this.players.has(name)) return;
    if (joined) this.players.set(name, Date.now());
    else this.players.delete(name);
    // Keep the last ping's count current until the next ping arrives.
    if (this.ping) this.ping.online = Math.max(0, this.ping.online + (joined ? 1 : -1));
    this.emit('status');
  }

  /**
   * Apply a Server List Ping result. The ping's count is authoritative; console join/leave lines
   * fill in names between pings, and the ping's sample corrects any lines the regex missed.
   */
  syncPing(ping) {
    const before = [...this.players.keys()].join('\n');
    if (!ping.online) {
      this.players.clear();
    } else if (ping.sample.length >= ping.online) {
      const now = Date.now();
      this.players = new Map(ping.sample.map((n) => [n, this.players.get(n) ?? now]));
    } else {
      for (const n of ping.sample) if (!this.players.has(n)) this.players.set(n, Date.now());
    }
    const changed = !this.ping || this.ping.online !== ping.online || before !== [...this.players.keys()].join('\n');
    this.ping = ping;
    if (changed) this.emit('status');
  }

  playerCount() {
    return this.ping ? Math.max(this.ping.online, 0) : this.players.size;
  }

  setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.emit('status');
  }

  setBusy(busy) {
    this.busy = busy;
    this.emit('status');
  }

  assertIdle(action) {
    if (this.proc) throw httpError(409, `Stop the server before you ${action}`);
    if (this.busy) throw httpError(409, `Server is busy (${this.busy})`);
  }

  async start() {
    if (this.proc || this.launching) throw httpError(409, 'Server is already running');
    if (this.busy) throw httpError(409, `Server is busy (${this.busy})`);
    clearTimeout(this.restartTimer);
    if (!fs.existsSync(path.join(this.dir, this.cfg.jar))) {
      throw httpError(400, `Jar "${this.cfg.jar}" not found. Upload it in Files or change it in Settings.`);
    }
    const where = software.info(this.cfg);
    if (store.reservedPorts.has(where.port)) {
      throw httpError(
        409,
        `Port ${where.port} is taken by the WebbMC panel itself (its PORT variable). Move the panel to another port (for example PORT=8080), or change this server's port in ${where.configFile}.`,
      );
    }
    this.proxy = where.proxy;
    // Proxies have no EULA of their own.
    if (this.cfg.eula && !where.proxy) fs.writeFileSync(path.join(this.dir, 'eula.txt'), '# Accepted in the WebbMC panel\neula=true\n');

    this.launching = true;
    let javaBin;
    try {
      javaBin = await this.java();
    } finally {
      this.launching = false;
    }
    const args = [
      ...(this.cfg.minRam ? [`-Xms${this.cfg.minRam}M`] : []),
      `-Xmx${this.cfg.maxRam}M`,
      '-Dstdout.encoding=UTF-8',
      '-Dstderr.encoding=UTF-8',
      ...splitArgs(this.cfg.jvmArgs),
      '-jar',
      this.cfg.jar,
      ...splitArgs(this.cfg.serverArgs),
    ];
    this.panel(`Starting: ${javaBin} ${args.join(' ')}`);
    this.expectStop = false;
    this.players.clear();
    this.ping = null;
    this.pingError = null;
    this.lastSample = null;
    this.startedAt = Date.now();
    this.setStatus('starting');

    let proc;
    try {
      proc = spawn(javaBin, args, { cwd: this.dir, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.startedAt = null;
      this.setStatus('crashed');
      this.panel(`Could not launch Java: ${err.message}`);
      throw httpError(500, `Could not launch Java: ${err.message}`);
    }
    this.proc = proc;
    this.cfg.lastPid = proc.pid;
    store.save();

    readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (l) => this.push(l, 'out'));
    readline.createInterface({ input: proc.stderr, crlfDelay: Infinity }).on('line', (l) => this.push(l, 'err'));
    proc.stdin.on('error', () => {});

    let finished = false;
    const finish = (code, signal, launchFailed) => {
      if (finished) return;
      finished = true;
      this.onExit(proc, code, signal, launchFailed);
    };
    proc.on('error', (err) => {
      this.panel(`Could not launch Java (${err.code || err.message}). Check the Java path in Settings.`);
      if (!proc.pid) finish(null, null, true);
    });
    proc.on('close', (code, signal) => finish(code, signal, false));
    store.logActivity(this.id, 'Server started');
  }

  onExit(proc, rawCode, signal, launchFailed) {
    if (this.proc !== proc) return;
    // Windows reports negative exit codes as unsigned 32-bit numbers (4294967295 for -1).
    const code = rawCode > 0x7fffffff ? rawCode - 0x100000000 : rawCode;
    this.proc = null;
    clearTimeout(this.stopTimer);
    this.players.clear();
    this.stats = { cpu: 0, mem: 0 };
    this.startedAt = null;
    this.ping = null;
    this.pingError = null;
    delete this.cfg.lastPid;
    store.save();

    if (this.expectStop || code === 0) {
      this.panel(`Server stopped${code != null ? ` (exit code ${code})` : ''}`);
      this.setStatus('stopped');
      store.logActivity(this.id, 'Server stopped');
    } else {
      const why = signal ? `signal ${signal}` : `exit code ${code}`;
      this.panel(`Server crashed (${why})`);
      this.setStatus('crashed');
      store.logActivity(this.id, `Server crashed (${why})`, 'error');
      if (this.cfg.autoRestart && !launchFailed && !Instance.shuttingDown) {
        const now = Date.now();
        this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW);
        this.crashes.push(now);
        if (this.crashes.length <= MAX_CRASHES) {
          this.panel(`Auto-restarting in 10 seconds (crash ${this.crashes.length}/${MAX_CRASHES} in 10 minutes)`);
          this.restartTimer = setTimeout(() => {
            if (this.status === 'crashed' && !Instance.shuttingDown) this.start().catch((e) => this.panel(`Auto-restart failed: ${e.message}`));
          }, 10000);
        } else {
          this.panel(`Crashed ${MAX_CRASHES} times in 10 minutes. Auto-restart is paused until you start it manually.`);
        }
      }
    }
    this.emit('exited');

    if (this.restartPending && !Instance.shuttingDown) {
      this.restartPending = false;
      setTimeout(() => this.start().catch((e) => this.panel(`Restart failed: ${e.message}`)), 1500);
    }
  }

  stop() {
    clearTimeout(this.restartTimer);
    this.restartPending = false;
    if (!this.proc) {
      if (this.status === 'crashed') this.setStatus('stopped');
      return;
    }
    if (this.status === 'stopping') return;
    this.expectStop = true;
    this.setStatus('stopping');
    this.panel('Stopping server...');
    try {
      this.write(software.stopCommand(this.cfg));
    } catch {
      /* stdin already closed; the timeout below will kill it */
    }
    const secs = Math.max(10, Number(this.cfg.stopTimeout) || 60);
    this.stopTimer = setTimeout(() => {
      if (!this.proc) return;
      this.panel(`Server did not stop within ${secs}s. Killing it.`);
      this.kill();
    }, secs * 1000);
  }

  kill() {
    if (!this.proc) return;
    this.expectStop = true;
    this.panel('Killing process');
    this.proc.kill('SIGKILL');
  }

  async restart() {
    if (!this.proc) return this.start();
    this.stop();
    this.restartPending = true;
  }

  write(cmd) {
    if (!this.proc?.stdin?.writable) throw httpError(409, 'Server is not running');
    this.proc.stdin.write(`${cmd}\n`);
  }

  send(command) {
    const cmd = String(command ?? '').trim().replace(/^\//, '');
    if (!cmd) return;
    this.write(cmd);
    this.push(`> ${cmd}`, 'cmd');
  }

  /** Resolve true when a console line matches `re`, or false after `ms`. */
  waitFor(re, ms) {
    return new Promise((resolve) => {
      const onLine = (e) => re.test(e.line) && done(true);
      const done = (v) => {
        clearTimeout(timer);
        this.off('line', onLine);
        resolve(v);
      };
      const timer = setTimeout(() => done(false), ms);
      this.on('line', onLine);
    });
  }

  /** The Java this server launches with, downloading the one its Minecraft version needs when it is missing. */
  java() {
    return java.forServer(this.cfg, { log: (m) => this.panel(m), busy: (b) => this.setBusy(b) });
  }

  async install(type, version) {
    this.assertIdle('change its software');
    const label = providers.label(type);
    this.setBusy(`Installing ${label} ${version}`);
    try {
      this.panel(`Looking up ${label} ${version}...`);
      const url = await providers.resolveUrl(type, version);
      this.panel(`Downloading ${url}`);
      const bytes = await providers.download(url, path.join(this.dir, 'server.jar'), (got, total) =>
        this.panel(total ? `Downloading... ${Math.round((got / total) * 100)}%` : `Downloading... ${(got / 1048576).toFixed(1)} MB`),
      );
      // A new proxy (or a server switched to one) gets a config file that listens on its port.
      const before = software.info(this.cfg);
      const pending = this.cfg.pendingProxy || {};
      Object.assign(this.cfg, { type, version, jar: 'server.jar' });
      delete this.cfg.pendingProxy;
      if (software.PROXIES.includes(type)) {
        const made = await software.initProxyConfig(this.cfg, { port: pending.port || before.port, maxPlayers: pending.maxPlayers || before.maxPlayers });
        if (made) {
          this.panel(`Wrote ${software.info(this.cfg).configFile}: listening on port ${software.info(this.cfg).port}.`);
          if (pending.motd) require('./motd').write(this.cfg, pending.motd);
        }
      }
      store.save();
      this.panel(`Installed ${label} ${version} (${(bytes / 1048576).toFixed(1)} MB).`);
      store.logActivity(this.id, `Installed ${label} ${version}`);
      // Get the Java this version needs now, so the first start does not wait for a download.
      await this.java();
      this.panel('Ready to start.');
    } catch (err) {
      this.panel(`Install failed: ${err.message}`);
      store.logActivity(this.id, `Install of ${label} ${version} failed: ${err.message}`, 'error');
      throw err;
    } finally {
      this.setBusy(null);
    }
  }

  /**
   * Address players should use. Detected automatically: the Railway TCP proxy for this server's port, or a
   * playit.gg tunnel that points at it.
   */
  publicAddress(port) {
    if (this.cfg.publicAddress) return this.cfg.publicAddress;
    const env = process.env;
    if (env.RAILWAY_TCP_PROXY_DOMAIN && Number(env.RAILWAY_TCP_APPLICATION_PORT) === port) {
      return `${env.RAILWAY_TCP_PROXY_DOMAIN}:${env.RAILWAY_TCP_PROXY_PORT}`;
    }
    return require('./playit').addressFor(port);
  }

  summary() {
    const where = software.info(this.cfg);
    const { lastPid, pendingProxy, ...cfg } = this.cfg;
    return {
      ...cfg,
      kind: where.kind,
      proxy: where.proxy,
      configFile: where.configFile,
      publicAddress: this.publicAddress(where.port),
      customAddress: cfg.publicAddress || '',
      status: this.status,
      busy: this.busy,
      pid: this.proc?.pid ?? null,
      startedAt: this.startedAt,
      port: where.port,
      maxPlayers: this.ping?.max || where.maxPlayers,
      players: [...this.players.keys()],
      playerCount: this.playerCount(),
      icon: serverIcon.mtime(this.dir),
      stats: this.stats,
      ping: this.ping,
    };
  }
}

module.exports = Instance;
