'use strict';
// Scheduled tasks: run a command, power action or backup on an interval or at a daily time.
const crypto = require('crypto');
const store = require('./store');
const backups = require('./backups');
const { httpError, int } = require('./util');

const ACTIONS = ['command', 'restart', 'start', 'stop', 'backup'];
const DAILY_GRACE = 5 * 60 * 1000;
let manager = null;

function dailyTarget(s, day) {
  const [hh, mm] = s.time.split(':').map(Number);
  const d = new Date(day);
  d.setHours(hh, mm, 0, 0);
  return d;
}

const dayAllowed = (s, d) => !s.days?.length || s.days.includes(d.getDay());

function nextRun(s, now = Date.now()) {
  if (!s.enabled) return null;
  if (s.type === 'interval') return Math.max(now, (s.lastRun || s.createdAt) + s.every * 60000);
  for (let i = 0; i < 8; i++) {
    const d = dailyTarget(s, now + i * 86400000);
    if (d.getTime() >= now - 1000 && dayAllowed(s, d) && !(s.lastRun >= d.getTime())) return d.getTime();
  }
  return null;
}

function due(s, now) {
  if (!s.enabled) return false;
  if (s.type === 'interval') return now >= (s.lastRun || s.createdAt) + s.every * 60000;
  const target = dailyTarget(s, now);
  return dayAllowed(s, target) && now >= target.getTime() && now - target.getTime() < DAILY_GRACE && !(s.lastRun >= target.getTime());
}

async function run(s, manual = false) {
  s.lastRun = Date.now();
  store.save();
  let result = 'ok';
  try {
    const inst = manager.get(s.serverId);
    switch (s.action) {
      case 'command':
        if (!inst.isOnline()) {
          result = 'skipped (server offline)';
          break;
        }
        for (const line of s.command.split(/\r?\n/)) if (line.trim()) inst.send(line);
        break;
      case 'start':
        if (inst.proc) result = 'skipped (already running)';
        else await inst.start();
        break;
      case 'stop':
        inst.stop();
        break;
      case 'restart':
        await inst.restart();
        break;
      case 'backup':
        await backups.create(inst, manual ? 'schedule, run manually' : `schedule "${s.name}"`);
        break;
    }
    if (result === 'ok') inst.panel(`Schedule "${s.name}" ran`);
  } catch (err) {
    result = `failed: ${err.message}`;
  }
  s.lastResult = result;
  store.logActivity(s.serverId, `Schedule "${s.name}" ${result === 'ok' ? 'ran' : result}`, result.startsWith('failed') ? 'error' : 'info');
  return result;
}

function sanitize(b, existing = {}) {
  const s = { ...existing };
  if (b.serverId !== undefined) {
    manager.get(b.serverId);
    s.serverId = b.serverId;
  }
  if (b.name !== undefined) s.name = String(b.name).trim().slice(0, 64) || 'Untitled task';
  if (b.action !== undefined) {
    if (!ACTIONS.includes(b.action)) throw httpError(400, 'Unknown action');
    s.action = b.action;
  }
  if (b.command !== undefined) s.command = String(b.command).slice(0, 4000);
  if (b.type !== undefined) {
    if (!['interval', 'daily'].includes(b.type)) throw httpError(400, 'Unknown trigger type');
    s.type = b.type;
  }
  if (b.every !== undefined) s.every = int(b.every, 60, 1, 60 * 24 * 7);
  if (b.time !== undefined) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(b.time)) throw httpError(400, 'Time must look like 04:30');
    s.time = b.time;
  }
  if (b.days !== undefined) s.days = (Array.isArray(b.days) ? b.days : []).map(Number).filter((d) => d >= 0 && d <= 6);
  if (b.enabled !== undefined) s.enabled = Boolean(b.enabled);
  if (s.action === 'command' && !String(s.command || '').trim()) throw httpError(400, 'Enter the command to run');
  return s;
}

const decorate = (s) => ({ ...s, nextRun: nextRun(s) });

function find(id) {
  const s = store.state.schedules.find((x) => x.id === id);
  if (!s) throw httpError(404, 'Schedule not found');
  return s;
}

module.exports = {
  init(mgr) {
    manager = mgr;
    setInterval(() => {
      const now = Date.now();
      for (const s of store.state.schedules) if (due(s, now)) run(s);
    }, 15000);
  },
  find,
  list: (serverId) => store.state.schedules.filter((s) => !serverId || s.serverId === serverId).map(decorate),
  create(b) {
    const s = sanitize(
      { name: 'Untitled task', action: 'command', command: '', type: 'interval', every: 60, time: '04:00', days: [], enabled: true, ...b },
      { id: crypto.randomBytes(4).toString('hex'), createdAt: Date.now(), lastRun: null },
    );
    if (!s.serverId) throw httpError(400, 'Pick a server');
    store.state.schedules.push(s);
    store.logActivity(s.serverId, `Schedule "${s.name}" created`);
    store.save();
    return decorate(s);
  },
  update(id, b) {
    const s = find(id);
    Object.assign(s, sanitize(b, s));
    store.save();
    return decorate(s);
  },
  remove(id) {
    const s = find(id);
    store.state.schedules = store.state.schedules.filter((x) => x.id !== id);
    store.logActivity(s.serverId, `Schedule "${s.name}" deleted`);
    store.save();
  },
  runNow: async (id) => ({ result: await run(find(id), true) }),
};
