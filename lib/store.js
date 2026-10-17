'use strict';
// Persistent panel state (settings, servers, schedules, activity) in data/panel.json.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// On Railway the attached volume's mount path is used automatically.
const DATA_DIR = path.resolve(process.env.WEBMC_DATA || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(ROOT, 'data'));
const SERVERS_DIR = path.join(DATA_DIR, 'servers');
const BACKUPS_DIR = path.join(DATA_DIR, 'backups');
const STATE_FILE = path.join(DATA_DIR, 'panel.json');

const DEFAULT_SETTINGS = {
  panelName: 'WebbMC',
  javaPath: 'java',
  autoJava: true, // download the Java a server needs when no installed one matches
  defaultMinRam: 1024,
  defaultMaxRam: 4096,
  allowedHosts: [],
  signups: 'approval', // accounts: 'approval' (the admin approves new accounts) or 'open' (anyone who signs up)
  passwordSignups: true, // accounts: people may create a username and password account (not only Google)
};

// resume: ids of servers that were running when the panel restarted for an update (started again on boot).
// favorites: addresses saved in the server status checker ({ address, edition, owner, addedAt }).
// users: accounts (see lib/auth.js). id is the username, or the Google email for accounts without one.
const state = { settings: { ...DEFAULT_SETTINGS }, servers: [], schedules: [], activity: [], favorites: [], users: [], resume: [] };

function load() {
  for (const dir of [DATA_DIR, SERVERS_DIR, BACKUPS_DIR]) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(STATE_FILE)) return state;
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(state.settings, saved.settings || {});
    if (state.settings.panelName === 'WebMC') state.settings.panelName = DEFAULT_SETTINGS.panelName; // the old default name
    state.servers = saved.servers || [];
    state.schedules = saved.schedules || [];
    state.activity = saved.activity || [];
    state.favorites = saved.favorites || [];
    state.users = saved.users || [];
    state.resume = saved.resume || [];
  } catch (err) {
    const copy = `${STATE_FILE}.corrupt-${Date.now()}`;
    fs.copyFileSync(STATE_FILE, copy);
    console.error(`[webbmc] panel.json could not be read (${err.message}). Copied it to ${copy} and started fresh.`);
  }
  return state;
}

let timer = null;
function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    saveNow();
  }, 150);
}

function saveNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const json = JSON.stringify(state, null, 2);
  const tmp = `${STATE_FILE}.tmp`;
  try {
    fs.writeFileSync(tmp, json);
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // Windows can refuse the rename while another process holds the file; fall back to a direct write.
    fs.writeFileSync(STATE_FILE, json);
  }
}

/** `to`: the account this entry is news for (it shows in their notifications), such as someone a server was shared with. */
function logActivity(serverId, message, level = 'info', to = null) {
  state.activity.unshift({ t: Date.now(), serverId, message, level, ...(to ? { to } : {}) });
  if (state.activity.length > 300) state.activity.length = 300;
  save();
}

// Ports Minecraft servers must not use (the panel's own HTTP port).
const reservedPorts = new Set();

module.exports = { reservedPorts, ROOT, DATA_DIR, SERVERS_DIR, BACKUPS_DIR, state, load, save, saveNow, logActivity };
