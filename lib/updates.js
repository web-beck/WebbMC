'use strict';
// Panel updates. A git checkout looks for new commits to this folder on its upstream branch and updates with
// `git pull --ff-only`, then restarts through the supervisor (lib/supervisor.js). Admins can also switch the checkout
// to another branch that has the panel, such as main (stable) or dev (development). On Railway the running commit is
// compared with GitHub (needs GITHUB_TOKEN for a private repository); Railway deploys new commits itself.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const supervisor = require('./supervisor');
const crypto = require('crypto');
const { httpError, readBody } = require('./util');

// How often to ask GitHub for new commits: about once a minute while an admin has the panel open, so a push shows
// up in the bell soon after, and every half hour otherwise. A GitHub webhook (WEBMC_WEBHOOK_SECRET) makes it instant.
const CHECK_EVERY = 30 * 60 * 1000;
const WATCHED_EVERY = 60 * 1000;
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
  branch: null, // the branch this copy runs (null when git is on a detached commit)
  defaultBranch: null, // the repository's default branch, treated as the stable one
  branches: [], // branches on GitHub that have the panel: { name, sha, subject, t }
};

/** The remote this checkout follows, normally "origin". */
const remoteOf = async (branch) => (branch && (await git(['config', `branch.${branch}.remote`]).catch(() => ''))) || 'origin';

/** Branches on the remote that contain the panel. A branch without it would delete the panel when checked out. */
async function listBranches(remote) {
  const prefix = await git(['rev-parse', '--show-prefix']); // the panel's folder inside the repository ('' at its root)
  const out = await git(['for-each-ref', '--format=%(refname:strip=3)%09%(objectname:short)%09%(committerdate:unix)%09%(subject)', `refs/remotes/${remote}/`]);
  const list = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [name, sha, t, ...subject] = line.split('\t');
    if (name === 'HEAD') continue;
    const hasPanel = await git(['cat-file', '-e', `${remote}/${name}:${prefix}server.js`]).then(
      () => true,
      () => false,
    );
    if (hasPanel) list.push({ name, sha, t: Number(t) * 1000 || null, subject: subject.join('\t') });
  }
  const head = (await git(['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => '')).slice(remote.length + 1);
  const names = list.map((b) => b.name);
  state.defaultBranch = names.includes(head) ? head : names.includes('main') ? 'main' : names.includes('master') ? 'master' : null;
  // Stable first, then the rest by name.
  return list.sort((a, b) => (b.name === state.defaultBranch) - (a.name === state.defaultBranch) || a.name.localeCompare(b.name));
}

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
  state.branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
  const remote = await remoteOf(state.branch);
  await git(['fetch', '--quiet', '--prune', remote], 60000);
  state.branches = await listBranches(remote);
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
  state.branch = branch;
  state.current = sha ? { sha: sha.slice(0, 7), subject: process.env.RAILWAY_GIT_COMMIT_MESSAGE || '', t: null } : null;
  if (!sha || !repo) throw new Error('This deployment was not built from GitHub, so there is nothing to compare with');
  const headers = { 'User-Agent': 'WebbMC', Accept: 'application/vnd.github+json' };
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

let checkAgain = false; // a push arrived while a check was running

async function check() {
  if (state.mode === 'none' || state.updating) return status();
  if (state.checking) {
    checkAgain = true;
    return status();
  }
  state.checking = true;
  try {
    await (state.mode === 'git' ? checkGit() : checkRailway());
    state.error = null;
    state.available = state.behind > 0;
    // Every new newest commit is news, also when an older update was already waiting (the bell lights again).
    const newest = state.available ? state.commits[0]?.sha || '' : null;
    if (newest !== state.foundSha) state.foundAt = newest === null ? null : Date.now();
    state.foundSha = newest;
  } catch (err) {
    state.error = err.message;
  } finally {
    state.checking = false;
    state.checkedAt = Date.now();
    if (checkAgain) {
      checkAgain = false;
      setTimeout(check, 1000);
    }
  }
  return status();
}

/** An admin has the panel open (their page asks for the overview every few seconds): check about once a minute. */
function watched() {
  if (state.mode === 'none' || state.checking || state.updating) return;
  // Railway's check uses GitHub's API, which allows 60 requests an hour without a token: every 5 minutes there.
  const every = state.mode === 'railway' && !process.env.GITHUB_TOKEN ? 5 * WATCHED_EVERY : WATCHED_EVERY;
  if (Date.now() - (state.checkedAt || 0) > every) check();
}

/**
 * GitHub calls this on every push (a webhook in the repository's settings), so the bell shows an update right away.
 * The request is signed with WEBMC_WEBHOOK_SECRET; without that setting there is no webhook.
 */
async function webhook(req) {
  const secret = process.env.WEBMC_WEBHOOK_SECRET;
  if (!secret) throw httpError(404, 'Not found');
  const body = await readBody(req, 5 * 1024 * 1024);
  const sig = Buffer.from(String(req.headers['x-hub-signature-256'] || ''));
  const want = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`);
  if (sig.length !== want.length || !crypto.timingSafeEqual(sig, want)) throw httpError(401, 'The signature does not match WEBMC_WEBHOOK_SECRET');
  state.webhookAt = Date.now();
  const event = String(req.headers['x-github-event'] || '');
  if (event === 'ping') return { ok: true, message: 'WebbMC is listening' };
  if (event !== 'push') return { ok: true, ignored: event };
  let payload = {};
  try {
    const text = body.toString('utf8');
    payload = JSON.parse(String(req.headers['content-type'] || '').includes('form') ? new URLSearchParams(text).get('payload') : text);
  } catch {
    /* unreadable: check anyway */
  }
  // Only pushes to the branch this copy runs matter (switching branches is in the same card).
  if (state.branch && payload.ref && payload.ref !== `refs/heads/${state.branch}`) return { ok: true, ignored: payload.ref };
  setTimeout(check, 1500); // give GitHub a moment, so the fetch sees the new commit
  return { ok: true, checking: true };
}

/** Why the Update button can or cannot be used here. */
function applyInfo() {
  if (state.mode === 'railway')
    return {
      canApply: false,
      applyNote: 'Railway deploys new commits on the branch by itself. If it has not, redeploy the service in Railway. To run another branch, change it in the Railway service settings (Source).',
    };
  if (state.mode === 'none') return { canApply: false, applyNote: 'This copy of the panel is not a git checkout, so it cannot update itself. Download the new version and replace these files.' };
  if (!supervisor.restartsOnExit()) return { canApply: true, restarts: false, applyNote: 'The panel stops after updating. Start it again with "node server.js".' };
  return { canApply: true, restarts: true, applyNote: '' };
}

const status = () => {
  const { checking, ...rest } = state;
  return { ...rest, checking, ...applyInfo(), webhook: state.mode === 'git' ? { configured: Boolean(process.env.WEBMC_WEBHOOK_SECRET), lastAt: state.webhookAt || null } : null };
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
  return restart();
}

/** Remember the running servers, stop everything and restart the panel (after new code is on disk, or on request). */
function restart(reason = 'update') {
  store.state.resume = store.state.servers.filter((c) => c.lastPid).map((c) => c.id);
  store.saveNow();
  // Answer the request first; the browser reloads once the panel is back.
  setTimeout(() => shutdown(reason, supervisor.supervised() ? supervisor.RESTART_CODE : 0), 300);
  return { ok: true, restarts: supervisor.restartsOnExit() };
}

/**
 * Run another branch, such as main (stable) or dev (development). The checkout comes first, so a failure leaves
 * everything running. A local copy of the branch is fast-forwarded to GitHub, or kept when it has commits of its own.
 */
async function switchBranch(user, name) {
  name = String(name || '').trim();
  if (state.mode === 'railway') throw httpError(400, 'On Railway, choose the branch in the service settings (Source). Railway then deploys it.');
  if (!applyInfo().canApply) throw httpError(400, applyInfo().applyNote);
  if (state.updating) throw httpError(409, 'An update is already running');
  state.updating = true;
  const from = state.branch;
  try {
    const remote = await remoteOf(from);
    await git(['fetch', '--quiet', '--prune', remote], 60000);
    state.branches = await listBranches(remote);
    if (!state.branches.some((b) => b.name === name)) throw httpError(404, `There is no branch called "${name}" with the panel in it on GitHub`);
    if (name === from) throw httpError(400, `The panel already runs ${name}`);
    if (await git(['status', '--porcelain', '--untracked-files=no'])) {
      throw httpError(409, 'This folder has local edits to tracked files, which switching could overwrite. Commit them, or set them aside with "git stash", then try again.');
    }
    const target = `${remote}/${name}`;
    const local = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).catch(() => null);
    const isAncestor = (a, b) => git(['merge-base', '--is-ancestor', a, b]).then(() => true, () => false);
    if (!local || (await isAncestor(name, target))) await git(['checkout', '--quiet', '-B', name, target]);
    else if (await isAncestor(target, name)) await git(['checkout', '--quiet', name]); // ahead of GitHub: keep its commits
    else throw httpError(409, `The copy of ${name} in this folder and the one on GitHub have different commits. Sort that out with git first.`);
    await git(['branch', '--quiet', `--set-upstream-to=${target}`, name]);
  } catch (err) {
    state.updating = false;
    if (err.status) throw err;
    store.logActivity(null, `Switching the panel to ${name} failed: ${err.message}`, 'error');
    throw httpError(409, `Could not switch to ${name}: ${err.message}`);
  }
  state.branch = name;
  state.available = false;
  store.logActivity(null, `${user.id || 'An admin'} switched the panel from ${from || 'a detached commit'} to ${name}. Restarting...`);
  return restart();
}

/** Restart on request (Panel settings > .env), when something starts the panel again afterwards. */
function restartPanel(user, why) {
  if (!supervisor.restartsOnExit()) {
    throw httpError(400, 'Nothing would start the panel again here. Stop it yourself (Ctrl+C) and run "node server.js" again.');
  }
  if (state.updating) throw httpError(409, 'An update is already running');
  state.updating = true;
  store.logActivity(null, `${user.id || 'An admin'} restarted the panel ${why}.`);
  return restart('restart');
}

function init(opts) {
  shutdown = opts.shutdown;
  if (state.mode === 'none') return;
  // The branch and the branches git already knows about, so the page has them before the first check.
  if (state.mode === 'git') {
    (async () => {
      [state.current] = parseLog(await git(['log', '-1', '--format=%h%x09%ct%x09%s']));
      state.branch = await git(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
      state.branches = await listBranches(await remoteOf(state.branch));
    })().catch(() => {});
  }
  const loop = () => check().finally(() => setTimeout(loop, CHECK_EVERY).unref());
  // A push lands within a minute while someone watches anyway; the half-hourly loop covers everyone else.
  setTimeout(loop, 20000).unref();
}

module.exports = { init, check, watched, webhook, apply, switchBranch, restartPanel, status };
