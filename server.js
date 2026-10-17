'use strict';
// WebbMC: a self-hosted Minecraft server panel. Run with `node server.js`.
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');

// In a git checkout the panel runs under a small supervisor that restarts it after an update (lib/supervisor.js).
// This comes before .env is read, so the restarted panel reads it again.
if (require('./lib/supervisor').run(__dirname)) return;

// Settings can live in a .env file next to this one (see .env.example). Real environment variables win,
// so on Railway the service's Variables tab is what counts.
const systemEnv = new Set(Object.keys(process.env)); // for Panel settings > .env: the variables .env cannot change
try {
  process.loadEnvFile(path.join(__dirname, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') console.warn(`[webbmc] Could not read .env: ${err.message}`);
}

const store = require('./lib/store');
store.load();
const auth = require('./lib/auth');
const manager = require('./lib/manager');
const files = require('./lib/files');
const backups = require('./lib/backups');
const scheduler = require('./lib/scheduler');
const providers = require('./lib/providers');
const properties = require('./lib/properties');
const addons = require('./lib/addons');
const serverIcon = require('./lib/icon');
const mcstatus = require('./lib/mcstatus');
const motd = require('./lib/motd');
const playit = require('./lib/playit');
const java = require('./lib/java');
const ports = require('./lib/ports');
const updates = require('./lib/updates');
const envfile = require('./lib/envfile');
envfile.init(systemEnv);
const notifications = require('./lib/notifications');
const { httpError, readJson, readBody, sendJson, int } = require('./lib/util');

const VERSION = require('./package.json').version;
const BOOT_ID = require('crypto').randomBytes(6).toString('hex');
const ON_RAILWAY = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);
const DEFAULT_HOST = ON_RAILWAY ? '0.0.0.0' : '127.0.0.1';
// WEBMC_HOST is the address to listen on (0.0.0.0, 127.0.0.1, ::), not the public URL. A URL here is a
// common mix-up that would crash the panel, so ignore it with an explanation instead.
const HOST = (() => {
  const raw = (process.env.WEBMC_HOST || '').trim();
  if (!raw) return DEFAULT_HOST;
  if (raw.includes('://') || raw.includes('/')) {
    console.warn(
      `[webbmc] WEBMC_HOST is set to "${raw}", which is a URL. WEBMC_HOST is the network address to listen on ` +
        `(for example 0.0.0.0), not the public address. Ignoring it and listening on ${DEFAULT_HOST}. ` +
        'Remove the variable (or set it to 0.0.0.0).',
    );
    return DEFAULT_HOST;
  }
  return raw;
})();
const PORT = Number(process.env.WEBMC_PORT || process.env.PORT) || 8420;
// Hostnames the panel answers on, besides localhost and IP addresses. The Railway domain and the host of
// WEBMC_PUBLIC_URL are included automatically.
const publicUrlHost = (() => {
  try {
    return process.env.WEBMC_PUBLIC_URL ? new URL(process.env.WEBMC_PUBLIC_URL).hostname : '';
  } catch {
    console.warn(`[webbmc] WEBMC_PUBLIC_URL "${process.env.WEBMC_PUBLIC_URL}" is not a full URL like https://panel.example.com`);
    return '';
  }
})();
const ENV_HOSTS = [process.env.WEBMC_ALLOWED_HOSTS || '', process.env.RAILWAY_PUBLIC_DOMAIN || '', publicUrlHost]
  .join(',')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const STATIC_DIR = path.join(__dirname, 'static');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------- routing

// Every route gets ctx.user. Routes with :id get ctx.inst, but only for servers that user may manage.
// { admin: true } routes are for the panel admin only.
const routes = [];
function route(method, pattern, handler, opts = {}) {
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`);
  routes.push({ method, re, handler, ...opts });
}

const readProps = (inst) => {
  const file = path.join(inst.dir, 'server.properties');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
};

/** access: 'owner', 'shared' (someone shared it with this account) or 'admin' (an admin looking at someone else's). */
const accessOf = (user, s) => (s.owner === user.id || (!s.owner && user.admin) ? 'owner' : s.shared?.includes(user.id) ? 'shared' : 'admin');
const visibleServers = (user) =>
  manager
    .list()
    .filter((s) => auth.canManage(user, s))
    .map((s) => ({ ...s, access: accessOf(user, s) }));
const visibleIds = (user) => new Set(visibleServers(user).map((s) => s.id));

// Panel overview, polled by the UI every few seconds.
route('GET', '/api/overview', ({ user }) => {
  const servers = visibleServers(user);
  return {
    panel: { name: store.state.settings.panelName, version: VERSION },
    host: manager.hostStats(),
    servers,
    me: {
      ...user,
      googleAvailable: auth.GOOGLE,
      pending: user.admin ? auth.pendingCount() : 0,
      notifications: notifications.list(user, new Set(servers.map((s) => s.id))).unread,
    },
  };
});

// Servers
route('GET', '/api/servers', ({ user }) => visibleServers(user));
route('GET', '/api/servers/next-port', () => ({ port: manager.nextPort() }));
route('POST', '/api/servers', ({ body, user }) => manager.create(body, user));
route('GET', '/api/servers/:id', ({ inst }) => inst.summary());
route('PATCH', '/api/servers/:id', ({ inst, body, user }) => manager.update(inst, body, user));
route('DELETE', '/api/servers/:id', ({ inst, query, user }) => {
  if (!auth.isOwner(user, inst.cfg)) throw httpError(403, 'Only the owner can delete this server');
  return manager.remove(inst, { deleteFiles: query.get('files') === '1', deleteBackups: query.get('backups') === '1' });
});

route('POST', '/api/servers/:id/power', async ({ inst, body }) => {
  switch (body.action) {
    case 'start':
      await inst.start();
      break;
    case 'stop':
      inst.stop();
      break;
    case 'restart':
      await inst.restart();
      break;
    case 'kill':
      inst.kill();
      break;
    default:
      throw httpError(400, 'Unknown power action');
  }
  return inst.summary();
});

route('POST', '/api/servers/:id/command', ({ inst, body }) => {
  inst.send(body.command);
});

route(
  'GET',
  '/api/servers/:id/console',
  ({ inst, req, res }) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('backlog', inst.log.slice(-1000));
    const onLine = (entry) => send('line', entry);
    const onStatus = () => send('status', inst.summary());
    inst.on('line', onLine);
    inst.on('status', onStatus);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(keepAlive);
      inst.off('line', onLine);
      inst.off('status', onStatus);
    });
  },
  { stream: true },
);

route('GET', '/api/servers/:id/java', ({ inst }) => java.plan(inst.cfg));
route('GET', '/api/servers/:id/metrics', ({ inst }) => ({ history: inst.history, stats: inst.stats }));
route('GET', '/api/servers/:id/size', async ({ inst }) => ({ bytes: await files.dirSize(inst.dir) }));

route('POST', '/api/servers/:id/install', ({ inst, body }) => {
  if (!providers.TYPES.includes(body.type)) throw httpError(400, 'Pick the server software');
  if (!body.version) throw httpError(400, 'Pick a version');
  inst.assertIdle('change its software');
  inst.install(body.type, String(body.version)).catch(() => {});
});

route('GET', '/api/servers/:id/players', ({ inst }) => {
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(inst.dir, f), 'utf8'));
    } catch {
      return [];
    }
  };
  return {
    online: [...inst.players.keys()],
    count: inst.playerCount(),
    ping: inst.ping,
    pingError: inst.pingError,
    whitelistEnabled: inst.readProps()['white-list'] === 'true',
    ops: read('ops.json'),
    whitelist: read('whitelist.json'),
    banned: read('banned-players.json'),
    bannedIps: read('banned-ips.json'),
  };
});

route('GET', '/api/servers/:id/properties', ({ inst }) => {
  const text = readProps(inst);
  return { exists: Boolean(text), values: properties.parse(text) };
});
// MOTD in the editor's & syntax, converted to the server type's own file and format
route('GET', '/api/servers/:id/motd', ({ inst }) => motd.read(inst.cfg));
route('PUT', '/api/servers/:id/motd', ({ inst, body }) => {
  const result = motd.write(inst.cfg, body.text);
  store.logActivity(inst.id, `MOTD updated in ${result.file}`);
  return result;
});
route('PUT', '/api/servers/:id/properties', ({ inst, body }) => {
  if (!body.values || typeof body.values !== 'object') throw httpError(400, 'Missing values');
  const values = Object.fromEntries(Object.entries(body.values).map(([k, v]) => [String(k), String(v ?? '')]));
  fs.writeFileSync(path.join(inst.dir, 'server.properties'), properties.stringify(values, readProps(inst)));
  store.logActivity(inst.id, 'server.properties updated');
  return { values: properties.parse(readProps(inst)) };
});

// Files
const qpath = (query, key = 'path') => query.get(key) || '';
route('GET', '/api/servers/:id/files', ({ inst, query }) => files.list(inst.dir, qpath(query)));
route('GET', '/api/servers/:id/files/content', async ({ inst, query }) => ({ content: await files.readText(inst.dir, qpath(query)) }));
route(
  'PUT',
  '/api/servers/:id/files/content',
  async ({ inst, query, req }) => {
    await files.writeText(inst.dir, qpath(query), (await readBody(req, 20 * 1024 * 1024)).toString('utf8'));
  },
  { rawBody: true },
);
route('POST', '/api/servers/:id/files/mkdir', ({ inst, body }) => files.mkdir(inst.dir, body.path).then(() => ({ ok: true })));
route('POST', '/api/servers/:id/files/rename', ({ inst, body }) => files.rename(inst.dir, body.from, body.to).then(() => ({ ok: true })));
route('DELETE', '/api/servers/:id/files', ({ inst, query }) => files.remove(inst.dir, qpath(query)).then(() => ({ ok: true })));
route('PUT', '/api/servers/:id/files/upload', ({ inst, query, req }) => files.upload(inst.dir, qpath(query), req).then(() => ({ ok: true })), {
  rawBody: true,
});
route(
  'GET',
  '/api/servers/:id/files/download',
  ({ inst, query, res }) => {
    const file = files.resolveIn(inst.dir, qpath(query));
    return files.sendFile(res, file, path.basename(file));
  },
  { stream: true },
);

route('POST', '/api/servers/:id/files/fetch', ({ inst, body }) => addons.fetchUrl(inst, body.url, body.path || ''));

// Plugins / mods / datapacks
const logInstalled = (inst, result) => {
  if (result.results?.length) store.logActivity(inst.id, `Installed ${result.results.map((r) => r.title).join(', ')}`);
  return result;
};
route('GET', '/api/servers/:id/addons', ({ inst }) => addons.list(inst));
route('GET', '/api/servers/:id/addons/search', ({ inst, query }) => addons.search(inst, query.get('source'), query.get('q') || '', query.get('version')));
route('GET', '/api/servers/:id/addons/github', ({ inst, query }) => addons.githubRelease(inst, query.get('repo')));
route('GET', '/api/servers/:id/addons/essentialsx', ({ inst, query }) => addons.essentialsInfo(inst, query.get('channel')));
route('POST', '/api/servers/:id/addons/essentialsx', async ({ inst, body }) => logInstalled(inst, await addons.essentialsInstall(inst, body.modules, body.channel)));
route('POST', '/api/servers/:id/addons/install', async ({ inst, body }) => logInstalled(inst, await addons.install(inst, body.url, body.asset, body.version, body.replace)));
route('GET', '/api/servers/:id/addons/updates', ({ inst, query }) => addons.checkUpdates(inst, query.get('version'), query.get('force') === '1'));
route('POST', '/api/servers/:id/addons/toggle', ({ inst, body }) => addons.toggle(inst, body.path));

// Server icon (server-icon.png, 64x64). The browser resizes the picture; the server only validates it.
route('GET', '/api/servers/:id/icon', ({ inst, res }) => serverIcon.send(inst, res), { stream: true });
route('PUT', '/api/servers/:id/icon', async ({ inst, req }) => serverIcon.save(inst, await readBody(req, 1024 * 1024)), { rawBody: true });
route('DELETE', '/api/servers/:id/icon', ({ inst }) => serverIcon.remove(inst));

// Backups
route('GET', '/api/servers/:id/backups', ({ inst }) => backups.list(inst.id));
route('GET', '/api/servers/:id/backups/folders', ({ inst }) => backups.folders(inst));
route('POST', '/api/servers/:id/backups', ({ inst }) => {
  backups.assertCanBackup(inst);
  backups.create(inst).catch(() => {});
});
route('POST', '/api/servers/:id/backups/restore', ({ inst, body }) => {
  backups.assertCanRestore(inst, body.name);
  backups.restore(inst, body.name).catch(() => {});
});
route('DELETE', '/api/servers/:id/backups', ({ inst, query }) => backups.remove(inst.id, qpath(query, 'name')).then(() => ({ ok: true })));
route(
  'GET',
  '/api/servers/:id/backups/download',
  ({ inst, query, res }) => {
    const name = qpath(query, 'name');
    return files.sendFile(res, backups.fileFor(inst.id, name), name, backups.contentType(name));
  },
  { stream: true },
);

// Schedules (only for servers the user manages)
const ownSchedule = (user, sid) => {
  const s = scheduler.find(sid);
  if (!visibleIds(user).has(s.serverId)) throw httpError(404, 'Schedule not found');
  return s;
};
const ownServerId = (user, id) => {
  if (id !== undefined && !visibleIds(user).has(id)) throw httpError(404, 'Server not found');
};
route('GET', '/api/schedules', ({ query, user }) => {
  const ids = visibleIds(user);
  return scheduler.list(query.get('server')).filter((s) => ids.has(s.serverId));
});
route('POST', '/api/schedules', ({ body, user }) => {
  ownServerId(user, body.serverId);
  return scheduler.create(body);
});
route('PATCH', '/api/schedules/:sid', ({ params, body, user }) => {
  ownSchedule(user, params.sid);
  ownServerId(user, body.serverId);
  return scheduler.update(params.sid, body);
});
route('DELETE', '/api/schedules/:sid', ({ params, user }) => (ownSchedule(user, params.sid), scheduler.remove(params.sid)));
route('POST', '/api/schedules/:sid/run', ({ params, user }) => (ownSchedule(user, params.sid), scheduler.runNow(params.sid)));

// Server status checker (any Java or Bedrock server, not only the ones this panel runs). Favorites are per account.
route('GET', '/api/status', ({ query }) =>
  mcstatus.check(query.get('address'), query.get('edition') === 'bedrock' ? 'bedrock' : 'java', { quick: query.get('quick') === '1' }),
);
// Favorites saved before sign-in existed have no owner; the admins keep them.
const myFavorites = (user) => store.state.favorites.filter((f) => (f.owner || null) === user.id || (user.admin && !f.owner));
route('GET', '/api/status/favorites', ({ user }) => myFavorites(user));
route('POST', '/api/status/favorites', ({ body, user }) => {
  const fav = { ...mcstatus.favorite(body.address, body.edition), owner: user.id };
  const key = (f) => `${f.edition}|${f.address}`;
  const mine = myFavorites(user);
  if (!mine.some((f) => key(f) === key(fav))) {
    if (mine.length >= 100) throw httpError(400, 'You can keep up to 100 favorites');
    store.state.favorites.push(fav);
    store.save();
  }
  return myFavorites(user);
});
route('DELETE', '/api/status/favorites', ({ query, user }) => {
  const fav = mcstatus.favorite(query.get('address'), query.get('edition'));
  const mine = new Set(myFavorites(user));
  store.state.favorites = store.state.favorites.filter((f) => !(mine.has(f) && f.address === fav.address && f.edition === fav.edition));
  store.save();
  return myFavorites(user);
});

// Panel
route('GET', '/api/versions', ({ query }) => providers.listVersions(query.get('type')));
route('GET', '/api/java', ({ query, user }) => manager.javaVersion(manager.checkJavaPath(query.get('path'), user)));
route('GET', '/api/java/list', () => manager.javaCandidates());
route('GET', '/api/notifications', ({ user }) => notifications.list(user, visibleIds(user)));
route('POST', '/api/notifications/seen', ({ user }) => auth.markNotifSeen(user));

// Admin: every port the servers use, and panel updates
route('GET', '/api/ports', () => ports.list(manager.all(), PORT), { admin: true });
route('GET', '/api/update', () => updates.status(), { admin: true });
route('POST', '/api/update/check', () => updates.check(), { admin: true });
route('POST', '/api/update', ({ user }) => updates.apply(user), { admin: true });
route('POST', '/api/update/branch', ({ user, body }) => updates.switchBranch(user, body.branch), { admin: true });

// Admin: the .env file (read at startup, so changes apply after a restart)
const envSaved = (user, changed) => {
  if (changed.length) store.logActivity(null, `${user.id || 'An admin'} changed .env (${changed.join(', ')}). It applies after the panel restarts.`);
  return { ...envfile.status(), changed };
};
route('GET', '/api/env', () => envfile.status(), { admin: true });
route('PUT', '/api/env', ({ user, body }) => envSaved(user, envfile.update(body)), { admin: true });
route('PUT', '/api/env/text', ({ user, body }) => envSaved(user, envfile.replaceText(body.text)), { admin: true });
route('POST', '/api/env/restart', ({ user }) => updates.restartPanel(user, 'to apply .env'), { admin: true });

route('GET', '/api/activity', ({ user }) => {
  if (user.admin) return store.state.activity;
  const ids = visibleIds(user);
  return store.state.activity.filter((a) => a.serverId && ids.has(a.serverId));
});
// Everyone needs the RAM defaults for the New server form; the rest is for the admin.
route('GET', '/api/settings', ({ user }) => {
  const s = store.state.settings;
  if (!user.admin) return { settings: { panelName: s.panelName, defaultMinRam: s.defaultMinRam, defaultMaxRam: s.defaultMaxRam }, info: null };
  return {
    settings: s,
    info: {
      version: VERSION,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      dataDir: store.DATA_DIR,
      bind: `${HOST}:${PORT}`,
      envAllowedHosts: ENV_HOSTS,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      railway: ON_RAILWAY,
      volume: process.env.RAILWAY_VOLUME_MOUNT_PATH || '',
      google: auth.GOOGLE,
      adminEmails: [...auth.ADMINS],
    },
  };
});
route('PUT', '/api/settings', ({ body }) => {
  const s = store.state.settings;
  if (body.signups !== undefined) s.signups = body.signups === 'open' ? 'open' : 'approval';
  if (body.passwordSignups !== undefined) s.passwordSignups = Boolean(body.passwordSignups);
  if (body.panelName !== undefined) s.panelName = String(body.panelName).trim().slice(0, 40) || 'WebbMC';
  if (body.javaPath !== undefined) s.javaPath = String(body.javaPath).trim() || 'java';
  if (body.autoJava !== undefined) s.autoJava = Boolean(body.autoJava);
  if (body.defaultMaxRam !== undefined) s.defaultMaxRam = int(body.defaultMaxRam, s.defaultMaxRam, 256, 1 << 20);
  if (body.defaultMinRam !== undefined) s.defaultMinRam = Math.min(int(body.defaultMinRam, s.defaultMinRam, 0, 1 << 20), s.defaultMaxRam);
  if (body.allowedHosts !== undefined) {
    s.allowedHosts = (Array.isArray(body.allowedHosts) ? body.allowedHosts : [])
      .map((h) => String(h).trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 50);
  }
  store.save();
  return { settings: s };
}, { admin: true });

// Your own account
route('GET', '/api/account', ({ user }) => auth.accountInfo(user));
route('PATCH', '/api/account', ({ req, res, user, body }) => auth.updateAccount(req, res, user, body));
route('POST', '/api/account/password', ({ req, res, user, body }) => auth.setOwnPassword(req, res, user, body));
route('POST', '/api/account/google/unlink', ({ user }) => auth.unlinkGoogle(user));
route('POST', '/api/account/sign-out-everywhere', ({ req, res, user }) => auth.signOutEverywhere(req, res, user));

// playit.gg tunnels (the panel's own computer, so admins only)
route('GET', '/api/playit', () => playit.status(), { admin: true });
route('POST', '/api/playit', ({ body }) => playit.act(String(body.action || '')), { admin: true });

// Everyone's accounts: the admin approves, blocks, removes, makes admins and gives out one-time passwords
route('GET', '/api/users', () => auth.listUsers(), { admin: true });
route(
  'POST',
  '/api/users',
  ({ body, user }) => (body.admin !== undefined ? auth.setAdmin(body.id, Boolean(body.admin), user) : auth.setUser(body.id ?? body.email, body.status || 'approved')),
  { admin: true },
);
route('DELETE', '/api/users/:uid', ({ params, user }) => auth.removeUser(params.uid, user), { admin: true });
route('POST', '/api/users/:uid/password', ({ params, user }) => auth.resetPassword(params.uid, user), { admin: true });

// ---------------------------------------------------------------- security
// Guard against the two ways a *web page* could reach the panel through your browser:
// DNS rebinding (checked via the Host header) and cross-site requests (a custom header that
// browsers will not attach cross-origin without a CORS preflight, which we never allow).

function hostAllowed(req) {
  const hostname = String(req.headers.host || '')
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '')
    .toLowerCase();
  if (!hostname) return false;
  if (hostname === 'localhost' || net.isIP(hostname)) return true;
  const allowed = [...ENV_HOSTS, ...(store.state.settings.allowedHosts || [])];
  return allowed.includes('*') || allowed.includes(hostname);
}

function checkMutation(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  if (req.headers['x-webmc'] !== '1') throw httpError(403, 'Missing X-WebMC header');
  const origin = req.headers.origin;
  if (!origin) return;
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    /* malformed origin */
  }
  if (originHost !== req.headers.host) throw httpError(403, 'Cross-origin request blocked');
}

const clientIp = (req) => (ON_RAILWAY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress;

// ---------------------------------------------------------------- server

function serveStatic(pathname, res) {
  let file;
  if (pathname === '/' || pathname === '/index.html') file = path.join(__dirname, 'index.html');
  else if (pathname === '/favicon.ico') file = path.join(STATIC_DIR, 'favicon.svg');
  else if (pathname.startsWith('/static/')) file = files.resolveIn(STATIC_DIR, decodeURIComponent(pathname.slice(8)));
  if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw httpError(404, 'Not found');
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://panel.local');
    // Railway's healthcheck arrives from healthcheck.railway.app, so answer it before the host check.
    // boot changes on every start, so the browser can tell when the panel has restarted after an update.
    if (url.pathname === '/api/health') return sendJson(res, 200, { ok: true, boot: BOOT_ID });
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('This hostname is not allowed. Add it to WEBMC_ALLOWED_HOSTS or the panel settings.');
      return;
    }
    if (url.pathname.startsWith('/auth/') && (await auth.handle(req, res, url, clientIp))) return;
    const user = auth.currentUser(req);
    if (!user && !url.pathname.startsWith('/static/')) {
      if (url.pathname.startsWith('/api/')) throw httpError(401, 'Sign in first');
      return auth.sendLogin(req, res);
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);
    checkMutation(req);

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.re);
      if (!m) continue;
      if (r.admin && !user.admin) throw httpError(403, 'Only the panel admin can do that');
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      let inst = null;
      if (params.id) {
        inst = manager.get(params.id);
        // Someone else's server looks exactly like one that does not exist.
        if (!auth.canManage(user, inst.cfg)) throw httpError(404, 'Server not found');
      }
      const ctx = { req, res, params, query: url.searchParams, inst, user };
      if (!r.rawBody && ['POST', 'PUT', 'PATCH'].includes(req.method)) ctx.body = await readJson(req);
      const result = await r.handler(ctx);
      if (!r.stream) sendJson(res, 200, result === undefined ? { ok: true } : result);
      return;
    }
    throw httpError(404, 'Not found');
  } catch (err) {
    const status = err.status || (err.code === 'ENOENT' ? 404 : err.code === 'EEXIST' ? 409 : 500);
    if (status >= 500) console.error('[webbmc]', err);
    const message =
      err.code === 'ENOENT' ? 'File or folder not found' : err.code === 'EBUSY' || err.code === 'EPERM' ? 'File is in use or locked' : err.message;
    if (!res.headersSent) sendJson(res, status, { error: message });
    else res.end();
  }
});

store.reservedPorts.add(PORT);
auth.applyResets();
manager.init();
scheduler.init(manager);
playit.init();
updates.init({ shutdown });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`[webbmc] Port ${PORT} is already in use. Set WEBMC_PORT to use another one.`);
  else if (err.code === 'ENOTFOUND' || err.code === 'EADDRNOTAVAIL') {
    console.error(`[webbmc] Cannot listen on "${HOST}". WEBMC_HOST must be an address on this machine, such as 0.0.0.0 or 127.0.0.1.`);
  } else console.error('[webbmc]', err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // localhost rather than 127.0.0.1: Google sign-in only accepts http:// redirect addresses for localhost.
  const shown = ['0.0.0.0', '::', '127.0.0.1', '::1'].includes(HOST) ? 'localhost' : HOST;
  console.log(`\n  WebbMC ${VERSION} is running at http://${shown}:${PORT}`);
  console.log(`  Data folder: ${store.DATA_DIR}`);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) console.log(`  Public URL: https://${process.env.RAILWAY_PUBLIC_DOMAIN}`);
  if (PORT === 25565) {
    console.log('  WARNING: the panel is using port 25565, the default Minecraft port, so Minecraft servers cannot use it.');
    console.log('           Set PORT to something else (for example 8080) and point the public domain at that port.');
  }
  if (ON_RAILWAY && !process.env.RAILWAY_VOLUME_MOUNT_PATH && !process.env.WEBMC_DATA) {
    console.log('  WARNING: no Railway volume is attached. Worlds and backups are deleted on every redeploy. Attach a volume.');
  }
  if (auth.GOOGLE) {
    console.log(`  Sign-in: username and password, or Google. Admin emails: ${[...auth.ADMINS].join(', ') || 'none'}`);
    const base = process.env.WEBMC_PUBLIC_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`);
    console.log(`  Google redirect URI to allow: ${base.replace(/\/+$/, '')}/auth/google/callback`);
  } else {
    console.log('  Sign-in: username and password (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are blank, so no Google).');
  }
  if (!auth.hasAdmin()) console.log('  No admin yet: the first account created on the sign-in page becomes the admin.');
  console.log('  Forgot the admin password? Run "node reset-admin.js" in this folder for a one-time password.');
  console.log('  Press Ctrl+C to stop the panel (running servers are stopped cleanly).\n');
});

let shuttingDown = false;
/** Stop every server cleanly, then exit. An update exits with the supervisor's restart code. */
async function shutdown(reason, code = 0) {
  if (shuttingDown) {
    console.log('[webbmc] Forcing exit');
    process.exit(1);
  }
  shuttingDown = true;
  console.log(reason === 'update' ? '\n[webbmc] Updated. Stopping servers to restart the panel...' : `\n[webbmc] ${reason} received. Stopping servers...`);
  server.close();
  await manager.stopAll(45000);
  await playit.stop();
  store.saveNow();
  process.exit(code);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => console.error('[webbmc] Uncaught error:', err));
process.on('unhandledRejection', (err) => console.error('[webbmc] Unhandled rejection:', err));
