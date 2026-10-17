'use strict';
// Panel updates. A git checkout looks for new commits to this folder on its upstream branch and updates with
// `git pull --ff-only`, then restarts through the supervisor (lib/supervisor.js). On Railway the running commit is
// compared with GitHub (needs GITHUB_TOKEN for a private repository); Railway deploys new commits itself.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const supervisor = require('./supervisor');
const { httpError } = require('./util');

const CHECK_EVERY = 6 * 60 * 60 * 1000;
const ON_RAILWAY = Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID);
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };

function git(args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: store.ROOT, env: GIT_ENV, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n').slice(-2).join(' ')));
      else resolve(stdout.trim());
    });
  });
}

const mode = supervisor.gitDir(store.ROOT) ? 'git' : ON_RAILWAY ? 'railway' : 'none';

const state = {
  mode,
  current: null, // { sha, subject, t }
  available: false,
  behind: 0,
  commits: [], // newest first: { sha, subject, t }
  checkedAt: null,
  foundAt: null, // when this update was first seen (for notifications)
  checking: false,
  updating: false,
  error: null,
  dirty: false, // local edits to the panel's files
};

const parseLog = (out) =>
  out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, t, ...subject] = l.split('\t');
      return { sha, t: Number(t) * 1000, subject: subject.join('\t') };
    });

async function checkGit() {
  [state.current] = parseLog(await git(['log', '-1', '--format=%h%x09%ct%x09%s']));
  await git(['fetch', '--quiet'], 60000);
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => null);
  if (!upstream) throw new Error('This branch does not track a branch on GitHub, so there is nothing to compare with');
  // Only commits that change the panel's own folder count.
  state.commits = parseLog(await git(['log', '--format=%h%x09%ct%x09%s', 'HEAD..@{u}', '--', '.']));
  state.behind = state.commits.length;
  state.dirty = Boolean(await git(['status', '--porcelain', '--untracked-files=no', '--', '.']));
}

async function checkRailway() {
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA;
  const repo = process.env.RAILWAY_GIT_REPO_OWNER && `${process.env.RAILWAY_GIT_REPO_OWNER}/${process.env.RAILWAY_GIT_REPO_NAME}`;
  const branch = process.env.RAILWAY_GIT_BRANCH || 'main';
  state.current = sha ? { sha: sha.slice(0, 7), subject: process.env.RAILWAY_GIT_COMMIT_MESSAGE || '', t: null } : null;
  if (!sha || !repo) throw new Error('This deployment was not built from GitHub, so there is nothing to compare with');
  const headers = { 'User-Agent': 'WebMC', Accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com/repos/${repo}/compare/${sha}...${encodeURIComponent(branch)}`, { headers });
  if (res.status === 404) throw new Error(`GitHub did not find ${repo}. For a private repository, set GITHUB_TOKEN.`);
  if (!res.ok) throw new Error(`GitHub responded with HTTP ${res.status}`);
  const d = await res.json();
  state.commits = (d.commits || [])
    .reverse()
    .map((c) => ({ sha: c.sha.slice(0, 7), t: Date.parse(c.commit.committer?.date || c.commit.author?.date) || null, subject: c.commit.message.split('\n')[0] }));
  state.behind = d.ahead_by || state.commits.length;
}

async function check() {
  if (state.mode === 'none' || state.checking || state.updating) return status();
  state.checking = true;
  try {
    await (state.mode === 'git' ? checkGit() : checkRailway());
    state.error = null;
    const was = state.available;
    state.available = state.behind > 0;
    if (state.available && (!was || !state.foundAt)) state.foundAt = Date.now();
    if (!state.available) state.foundAt = null;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.checking = false;
    state.checkedAt = Date.now();
  }
  return status();
}

/** Why the Update button can or cannot be used here. */
function applyInfo() {
  if (state.mode === 'railway') return { canApply: false, applyNote: 'Railway deploys new commits on the branch by itself. If it has not, redeploy the service in Railway.' };
  if (state.mode === 'none') return { canApply: false, applyNote: 'This copy of the panel is not a git checkout, so it cannot update itself. Download the new version and replace these files.' };
  if (!supervisor.supervised()) return { canApply: true, restarts: false, applyNote: 'The panel stops after updating. Start it again with "node server.js".' };
  return { canApply: true, restarts: true, applyNote: '' };
}

const status = () => {
  const { checking, ...rest } = state;
  return { ...rest, checking, ...applyInfo() };
};

let shutdown = null;
/**
 * Pull the new version, then stop every server and restart the panel. Servers that were running start again.
 * The pull comes first, so a failed update leaves everything running.
 */
async function apply(user) {
  if (!applyInfo().canApply) throw httpError(400, applyInfo().applyNote);
  if (state.updating) throw httpError(409, 'An update is already running');
  state.updating = true;
  try {
    const out = await git(['pull', '--ff-only'], 120000);
    store.logActivity(null, `${user.id || 'An admin'} updated the panel (${out.split('\n').pop() || 'git pull'}). Restarting...`);
  } catch (err) {
    state.updating = false;
    store.logActivity(null, `Panel update failed: ${err.message}`, 'error');
    throw httpError(409, `git pull failed: ${err.message}`);
  }
  state.available = false;
  store.state.resume = store.state.servers.filter((c) => c.lastPid).map((c) => c.id);
  store.saveNow();
  // Answer the request first; the browser reloads once the panel is back.
  setTimeout(() => shutdown('update', supervisor.supervised() ? supervisor.RESTART_CODE : 0), 300);
  return { ok: true, restarts: supervisor.supervised() };
}

function init(opts) {
  shutdown = opts.shutdown;
  if (state.mode === 'none') return;
  const loop = () => check().finally(() => setTimeout(loop, CHECK_EVERY).unref());
  setTimeout(loop, 20000).unref();
}

module.exports = { init, check, apply, status };
