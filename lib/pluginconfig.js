'use strict';
// The Plugin config tab: the settings of a few popular plugins, read from and saved to their own config files
// (through cfgtree, which keeps the files' comments and layout). Only these files can be changed here.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const cfgtree = require('./cfgtree');
const motd = require('./motd');
const files = require('./files');
const software = require('./software');
const { httpError } = require('./util');

const GEYSER_DIRS = ['plugins/Geyser-Spigot', 'plugins/Geyser-Velocity', 'plugins/Geyser-BungeeCord', 'config/Geyser-Fabric', 'config/Geyser-NeoForge', 'config/geyser'];

const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const listDir = (dir, rel) => {
  try {
    return fs.readdirSync(path.join(dir, rel));
  } catch {
    return [];
  }
};
const hasJar = (dir, re) => ['plugins', 'mods'].some((f) => listDir(dir, f).some((n) => /\.jar$/i.test(n) && re.test(n)));
const firstDir = (dir, list) => list.find((d) => exists(dir, d));
const inDir = (dir, base, names) => (base ? names.map((n) => ({ path: `${base}/${n}`, label: n })).filter((f) => exists(dir, f.path)) : []);

/**
 * What the tab knows. files(dir): the config files that exist, [{ path, label }]. main: the settings shown first,
 * as "path" or "file label:path" (shown only when the file has them, as names differ between plugin versions).
 * options: choices for settings that take one of a few words.
 */
const PLUGINS = [
  {
    id: 'geyser',
    name: 'Geyser',
    about: 'Lets Bedrock Edition players (phones, tablets, consoles, Windows) join this Java server.',
    installed: (dir) => hasJar(dir, /^geyser/i) || Boolean(firstDir(dir, GEYSER_DIRS)),
    files: (dir) => inDir(dir, firstDir(dir, GEYSER_DIRS), ['config.yml']),
    main: [
      'bedrock.port', 'bedrock.clone-remote-port', 'java.auth-type', 'remote.auth-type',
      'motd.primary-motd', 'motd.secondary-motd', 'bedrock.motd1', 'bedrock.motd2', 'motd.passthrough-motd', 'passthrough-motd',
      'motd.max-players', 'max-players', 'motd.passthrough-player-counts', 'passthrough-player-counts',
      'gameplay.server-name', 'bedrock.server-name', 'gameplay.show-coordinates', 'show-coordinates',
    ],
    options: { 'java.auth-type': ['online', 'offline', 'floodgate'], 'remote.auth-type': ['online', 'offline', 'floodgate'] },
    // Geyser extensions, each a section of Geyser's card.
    sections: [
      {
        id: 'mcxboxbroadcast',
        name: 'MCXboxBroadcast',
        about: 'Shows the server to Bedrock players as a joinable friend, through an Xbox account.',
        installed: (dir) => GEYSER_DIRS.some((d) => listDir(dir, `${d}/extensions`).some((n) => /mcxboxbroadcast/i.test(n))),
        files: (dir) =>
          GEYSER_DIRS.flatMap((d) =>
            listDir(dir, `${d}/extensions`)
              .filter((n) => /mcxboxbroadcast/i.test(n) && !/\.jar$/i.test(n))
              .flatMap((n) => inDir(dir, `${d}/extensions/${n}`, ['config.yml'])),
          ),
        main: ['session.session-info.host-name', 'session.session-info.world-name', 'session.update-interval', 'friend-sync.auto-follow', 'friend-sync.auto-unfollow', 'friend-sync.initial-invite'],
      },
    ],
  },
  {
    id: 'discordsrv',
    name: 'DiscordSRV',
    about: 'Links the Minecraft chat and console with Discord channels.',
    installed: (dir) => hasJar(dir, /discordsrv/i) || exists(dir, 'plugins/DiscordSRV'),
    files: (dir) => inDir(dir, 'plugins/DiscordSRV', ['config.yml', 'messages.yml']),
    main: [
      'config.yml:BotToken', 'config.yml:Channels', 'config.yml:DiscordConsoleChannelId', 'config.yml:DiscordGameStatus', 'config.yml:DiscordOnlineStatus',
      'config.yml:DiscordChatChannelMinecraftToDiscord', 'config.yml:DiscordChatChannelDiscordToMinecraft',
    ],
    options: { DiscordOnlineStatus: ['ONLINE', 'IDLE', 'DND', 'INVISIBLE'] },
  },
  {
    id: 'minimotd',
    name: 'MiniMOTD',
    about: 'The server list message, icon and player count, with several MOTDs to rotate through.',
    installed: (dir) => hasJar(dir, /minimotd/i) || Boolean(firstDir(dir, ['plugins/MiniMOTD', 'plugins/minimotd', 'config/minimotd'])),
    files: (dir) => inDir(dir, firstDir(dir, ['plugins/MiniMOTD', 'plugins/minimotd', 'config/minimotd']), ['main.conf']),
    motds: true,
    main: [
      'motd-enabled', 'icon-enabled', 'player-count-settings.max-players-enabled', 'player-count-settings.max-players',
      'player-count-settings.allow-exceeding-maximum', 'player-count-settings.hide-player-count', 'player-count-settings.disable-player-list-hover',
      'player-count-settings.fake-players.fake-players-enabled', 'player-count-settings.fake-players.fake-players',
      'player-count-settings.just-x-more-settings.just-x-more-enabled', 'player-count-settings.just-x-more-settings.x-value',
    ],
  },
  {
    id: 'tab',
    name: 'TAB',
    about: 'The tab list: header and footer, name formats, sorting, scoreboard and more.',
    installed: (dir) => hasJar(dir, /^tab([-_ .]|v?\d)/i) || exists(dir, 'plugins/TAB'),
    files: (dir) => inDir(dir, 'plugins/TAB', ['config.yml']),
    main: [
      'header-footer.enabled', 'header-footer.header', 'header-footer.footer', 'tablist-name-formatting.enabled',
      'scoreboard.enabled', 'belowname-objective.enabled', 'playerlist-objective.enabled', 'layout.enabled',
    ],
  },
  {
    id: 'bluemap',
    name: 'BlueMap',
    about: 'A 3D map of your worlds in the browser.',
    installed: (dir) => hasJar(dir, /bluemap/i) || Boolean(firstDir(dir, ['plugins/BlueMap', 'config/bluemap'])),
    files: (dir) => {
      const base = firstDir(dir, ['plugins/BlueMap', 'config/bluemap']);
      if (!base) return [];
      const maps = listDir(dir, `${base}/maps`)
        .filter((n) => /\.conf$/i.test(n))
        .sort()
        .map((n) => ({ path: `${base}/maps/${n}`, label: `Map: ${n.replace(/\.conf$/i, '')}` }));
      return [...inDir(dir, base, ['core.conf', 'webserver.conf', 'webapp.conf', 'plugin.conf']), ...maps];
    },
    main: ['core.conf:accept-download', 'core.conf:render-thread-count', 'webserver.conf:enabled', 'webserver.conf:port', 'plugin.conf:live-player-markers', 'webapp.conf:default-to-flat-view'],
  },
  // Proxies: their own config file, in the Properties tab under the server editor (which handles what is hidden here).
  {
    id: 'velocity',
    name: 'Velocity settings',
    about: 'Everything else in velocity.toml. The servers, start order and forced hosts are above; the port and MOTD have their own places.',
    proxy: true,
    installed: (dir, cfg) => software.kindOf(cfg) === 'velocity',
    files: (dir) => (exists(dir, 'velocity.toml') ? [{ path: 'velocity.toml', label: 'velocity.toml' }] : []),
    hide: ['servers', 'forced-hosts', 'bind', 'motd', 'config-version'],
    main: [
      'online-mode', 'player-info-forwarding-mode', 'forwarding-secret-file', 'show-max-players', 'kick-existing-players',
      'force-key-authentication', 'ping-passthrough.players', 'ping-passthrough.description', 'query.enabled', 'query.port',
    ],
    options: { 'player-info-forwarding-mode': ['NONE', 'LEGACY', 'BUNGEEGUARD', 'MODERN'] },
  },
  {
    id: 'bungeecord',
    name: 'BungeeCord settings',
    about: 'Everything else in config.yml. The servers and start order are above; the port and MOTD have their own places.',
    proxy: true,
    installed: (dir, cfg) => software.kindOf(cfg) === 'bungeecord',
    files: (dir) => (exists(dir, 'config.yml') ? [{ path: 'config.yml', label: 'config.yml' }] : []),
    hide: ['servers', 'listeners'],
    main: ['online_mode', 'ip_forward', 'player_limit', 'prevent_proxy_connections', 'log_commands', 'log_pings', 'connection_throttle'],
  },
];

/** A plugin's files and those of its installed sections (marked with the section's id). */
const allFiles = (p, dir, cfg) => [
  ...p.files(dir, cfg),
  ...(p.sections || []).filter((sec) => sec.installed(dir, cfg)).flatMap((sec) => sec.files(dir, cfg).map((f) => ({ ...f, section: sec.id }))),
];

const hash = (text) => crypto.createHash('sha1').update(text).digest('hex');

// ---------------------------------------------------------------- MiniMOTD's MOTD list
// main.conf keeps them as  motds=[ { icon=random  line1="<blue>..."  line2="..." } ... ]  in MiniMessage. The editor
// works in & codes, like the panel's own MOTD editor; placeholders such as <online_players> pass through untouched.

const toAmp = (mini) => motd.toCodes(motd.parseMini(String(mini || '')));
const toMini = (amp) => motd.toMini(motd.parseAmp(String(amp || '')), { keepTags: true });

function motdsItem(text) {
  return cfgtree.parse(text, 'main.conf').find((x) => x.kind === 'value' && x.path.join('.') === 'motds' && x.end > x.line);
}

/** [{ icon, line1, line2, extra }] with the lines in & codes, or null when the list is laid out some other way. */
function readMotds(text) {
  const it = motdsItem(text);
  if (!it) return null;
  const lines = text.split(/\r?\n/);
  const list = [];
  let cur = null;
  for (let k = it.line + 1; k < it.end; k++) {
    const t = lines[k].trim().replace(/,$/, '');
    if (!t || /^(#|\/\/)/.test(t)) continue;
    if (t === '{') {
      if (cur) return null;
      cur = [];
      continue;
    }
    if (t === '}') {
      if (!cur) return null;
      list.push(cur);
      cur = null;
      continue;
    }
    const m = /^("(?:[^"\\]|\\.)*"|[A-Za-z0-9_.-]+)\s*[:=]\s*(.*)$/.exec(t);
    if (!cur || !m) return null;
    const v = cfgtree.decode(cfgtree.splitValue(m[2], true).value.replace(/,$/, '').trim(), true);
    cur.push({ key: m[1].replace(/^"|"$/g, ''), value: String(v.value), quote: v.quote || '' });
  }
  if (cur) return null;
  return list.map((fields) => {
    const f = Object.fromEntries(fields.map((x) => [x.key, x.value]));
    return {
      icon: f.icon ?? '',
      line1: toAmp(f.line1),
      line2: toAmp(f.line2),
      mini: [f.line1 ?? '', f.line2 ?? ''], // as stored, so a line nobody changed is written back exactly so
      extra: fields.filter((x) => !['icon', 'line1', 'line2'].includes(x.key)),
    };
  });
}

/** The text with the MOTD list replaced by `input` ([{ icon, line1, line2 }], lines in & codes). */
function writeMotds(text, input) {
  const it = motdsItem(text);
  const current = it && readMotds(text);
  if (!current) throw httpError(400, "MiniMOTD's MOTD list is laid out in a way WebbMC cannot edit. Change it in the Files tab.");
  if (!Array.isArray(input) || !input.length) throw httpError(400, 'Keep at least one MOTD');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const inner = lines.slice(it.line + 1, it.end);
  const pad = /^\s*/.exec(inner.find((l) => l.trim() === '{' || l.trim() === '{,') || '')[0] || ' '.repeat(it.indent + 4);
  const fieldPad = /^\s*/.exec(inner.find((l) => /[:=]/.test(l)) || '')[0] || `${pad}    `;
  const sep = /=/.test(it.head) ? '=' : ': ';
  const out = [lines[it.line]];
  input.slice(0, 100).forEach((m, i) => {
    const icon = String(m?.icon ?? '').trim();
    if (/[\r\n]/.test(`${m?.line1}${m?.line2}${icon}`)) throw httpError(400, 'Each MOTD line must be one line');
    // A line left as it was keeps its MiniMessage as written (a <gradient> stays a gradient tag).
    const was = current[i];
    const line = (n) => (was && String(m?.[`line${n}`] ?? '') === was[`line${n}`] ? was.mini[n - 1] : toMini(m?.[`line${n}`]));
    out.push(`${pad}{`);
    if (icon) out.push(`${fieldPad}icon${sep}${cfgtree.encodeString(icon, '', true)}`);
    out.push(`${fieldPad}line1${sep}${JSON.stringify(line(1))}`);
    out.push(`${fieldPad}line2${sep}${JSON.stringify(line(2))}`);
    for (const x of was?.extra || []) out.push(`${fieldPad}${x.key}${sep}${cfgtree.encodeString(x.value, x.quote, true)}`);
    out.push(`${pad}}`);
  });
  out.push(lines[it.end]);
  lines.splice(it.line, it.end - it.line + 1, ...out);
  return lines.join(eol);
}

// ---------------------------------------------------------------- reading and saving

function readFile(dir, f, plugin) {
  const text = fs.readFileSync(files.resolveIn(dir, f.path), 'utf8');
  const out = { path: f.path, label: f.label, section: f.section || null, hash: hash(text), items: cfgtree.parse(text, f.path).map(cfgtree.view) };
  if (plugin.motds) out.motds = readMotds(text);
  return out;
}

/** Every plugin the tab knows, with the settings of the installed ones. */
function view(inst) {
  const dir = inst.cfg.dir;
  return PLUGINS.map((p) => {
    const base = { id: p.id, name: p.name, about: p.about, proxy: Boolean(p.proxy), installed: p.installed(dir, inst.cfg) };
    if (!base.installed) return base;
    const fl = [];
    for (const f of allFiles(p, dir, inst.cfg)) {
      try {
        fl.push(readFile(dir, f, p));
      } catch (err) {
        fl.push({ path: f.path, label: f.label, error: err.message });
      }
    }
    const sections = (p.sections || []).map((sec) => ({ id: sec.id, name: sec.name, about: sec.about, installed: sec.installed(dir, inst.cfg), main: sec.main || [] }));
    return { ...base, main: p.main || [], options: p.options || {}, hide: p.hide || [], files: fl, sections };
  });
}

/** Save changes to one file: { file, hash, edits: [{ line, path, value }], motds? }. Gives the file as it is now. */
async function save(inst, body) {
  const dir = inst.cfg.dir;
  const rel = String(body.file || '');
  const plugin = PLUGINS.find((p) => p.installed(dir, inst.cfg) && allFiles(p, dir, inst.cfg).some((f) => f.path === rel));
  if (!plugin) throw httpError(400, 'That is not a plugin config file WebbMC can change');
  const f = allFiles(plugin, dir, inst.cfg).find((x) => x.path === rel);
  const abs = files.resolveIn(dir, rel);
  const text = await fsp.readFile(abs, 'utf8');
  if (hash(text) !== body.hash) throw httpError(409, 'The file changed since you opened it (the plugin may have rewritten it). Reload to see it as it is now.');
  let next = text;
  try {
    next = cfgtree.apply(text, rel, Array.isArray(body.edits) ? body.edits : []);
    if (plugin.motds && Array.isArray(body.motds)) next = writeMotds(next, body.motds);
  } catch (err) {
    throw err.status ? err : httpError(400, err.message);
  }
  if (next !== text) await fsp.writeFile(abs, next);
  return { file: readFile(dir, f, plugin), changed: next !== text, plugin: plugin.name };
}

module.exports = { view, save, readMotds, writeMotds };
