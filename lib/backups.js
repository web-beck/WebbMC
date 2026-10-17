'use strict';
// Backups of a server folder as .tar.gz, .tar (system tar, bundled with Windows 10+, Linux and macOS) or .zip
// (written by the panel itself). The panel decides which files go in, so exclusions work the same in every format.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const software = require('./software');
const zip = require('./zip');
const { httpError, slug } = require('./util');

const WIN_TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
// On Windows prefer the bundled bsdtar: a GNU tar from Git/MSYS would read "C:" as a remote host.
const TAR = process.platform === 'win32' && fs.existsSync(WIN_TAR) ? WIN_TAR : 'tar';

const FORMATS = { 'tar.gz': 'tar.gz', tar: 'tar', zip: 'zip' };
const NAME_RE = /^[\w.-]+\.(tar\.gz|tar|zip)$/;
// Never worth keeping: the world lock (it would block a restore on some systems) and half-finished transfers.
const ALWAYS_EXCLUDED = ['session.lock', '*.uploading', '*.part'];

function runTar(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(TAR, args, { windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (err) => reject(new Error(`Could not run tar (${err.code || err.message})`)));
    proc.on('close', (code) => {
      // GNU tar exits 1 when a file changed while it was being read; the archive is still usable.
      if (code === 0 || (code === 1 && /changed as we read|shrank/.test(stderr))) resolve();
      else reject(new Error(`tar exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

const dirFor = (id) => path.join(store.BACKUPS_DIR, id);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const formatOf = (name) => /\.(tar\.gz|tar|zip)$/.exec(name)?.[1] || 'tar.gz';

function fileFor(id, name) {
  if (!NAME_RE.test(String(name))) throw httpError(400, 'Invalid backup name');
  return path.join(dirFor(id), name);
}

async function list(id) {
  let names;
  try {
    names = await fsp.readdir(dirFor(id));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const st = await fsp.stat(path.join(dirFor(id), name));
    out.push({ name, size: st.size, mtime: st.mtimeMs, format: formatOf(name) });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

async function prune(id, keep) {
  if (!keep) return;
  for (const old of (await list(id)).slice(keep)) await fsp.rm(path.join(dirFor(id), old.name), { force: true });
}

// ---------------------------------------------------------------- what goes in

/**
 * Exclusion rules, like .gitignore:
 *   /logs          the "logs" folder at the top of the server folder (a leading slash, or any slash, anchors it)
 *   world/region   that path, from the top
 *   cache          anything named "cache", at any depth
 *   *.log          wildcards: * (not across folders), ** (across folders), ?
 *   dynmap/        a trailing slash matches folders only
 * Older settings written as "./logs" mean "/logs".
 */
function compileExcludes(patterns, { always = true } = {}) {
  const rules = [];
  for (const raw of [...(always ? ALWAYS_EXCLUDED : []), ...patterns]) {
    let p = String(raw).trim().replace(/\\/g, '/');
    if (!p || p.startsWith('#')) continue;
    if (p.startsWith('./')) p = `/${p.slice(2)}`;
    const dirOnly = p.endsWith('/');
    p = p.replace(/\/+$/, '');
    const anchored = p.includes('/');
    p = p.replace(/^\/+/, '');
    if (!p) continue;
    const re = p
      .split(/(\*\*\/?|\*|\?)/)
      .map((part) => (part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
      .join('');
    rules.push({ re: new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : ''), anchored, dirOnly });
  }
  return (rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(r.anchored ? rel : rel.slice(rel.lastIndexOf('/') + 1)));
}

/** Every file and folder to back up, as { rel, abs, isDir, size, mtime }. Excluded folders are not entered. */
async function collect(root, patterns) {
  const excluded = compileExcludes(patterns);
  const out = [];
  const walk = async (dir, rel) => {
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return 0;
      throw err;
    }
    let kept = 0;
    for (const d of dirents) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (excluded(r, true)) continue;
        const at = out.length;
        out.push({ rel: r, abs, isDir: true, size: 0, mtime: 0 });
        const st = await fsp.stat(abs).catch(() => null);
        out[at].mtime = st?.mtimeMs || Date.now();
        await walk(abs, r);
        kept++;
      } else if (d.isFile()) {
        if (excluded(r, false)) continue;
        const st = await fsp.stat(abs).catch(() => null);
        if (!st) continue; // deleted while we looked
        out.push({ rel: r, abs, isDir: false, size: st.size, mtime: st.mtimeMs });
        kept++;
      }
      // Symlinks, sockets and the like are skipped.
    }
    return kept;
  };
  await walk(root, '');
  return out;
}

/** Folders a user can tick to leave out, with their sizes: the top level and one level below it. */
async function folders(inst) {
  const root = inst.dir;
  const size = async (dir) => {
    let total = 0;
    const walk = async (d) => {
      for (const e of await fsp.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
      }
    };
    await walk(dir);
    return total;
  };
  const out = [];
  for (const top of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!top.isDirectory()) continue;
    const children = [];
    for (const sub of await fsp.readdir(path.join(root, top.name), { withFileTypes: true }).catch(() => [])) {
      if (sub.isDirectory()) children.push({ path: `${top.name}/${sub.name}`, name: sub.name, size: await size(path.join(root, top.name, sub.name)) });
    }
    out.push({ path: top.name, name: top.name, size: await size(path.join(root, top.name)), children: children.sort((a, b) => b.size - a.size) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- create and restore

/** Synchronous pre-checks so the HTTP handler can reject before the work runs in the background. */
function assertIdle(inst) {
  if (inst.busy) throw httpError(409, `Server is busy (${inst.busy})`);
}

async function create(inst, reason = 'manual') {
  assertIdle(inst);
  const cfg = inst.cfg;
  const format = FORMATS[cfg.backup?.format] || 'tar.gz';
  inst.setBusy('Backing up');
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  const name = `${slug(cfg.name)}_${stamp}.${format}`;
  const dest = path.join(dirFor(cfg.id), name);
  const listFile = `${dest}.files`;
  let savesOff = false;
  const savesOn = () => {
    if (!savesOff) return;
    savesOff = false;
    try {
      if (inst.proc) inst.send('save-on');
    } catch {
      /* server went away mid-backup */
    }
  };
  try {
    try {
      await fsp.mkdir(dirFor(cfg.id), { recursive: true });
      // Pause saving so the world on disk is consistent. Proxies have no world.
      if (inst.isOnline() && !software.isProxy(cfg)) {
        inst.send('save-off');
        savesOff = true;
        const saved = inst.waitFor(/Saved the (game|world)|All dimensions are saved/i, 60000);
        inst.send('save-all flush');
        await saved;
      }
      const entries = await collect(cfg.dir, cfg.backup?.exclude || []);
      const files = entries.filter((e) => !e.isDir);
      const bytes = files.reduce((n, e) => n + e.size, 0);
      inst.panel(`Creating backup ${name} (${files.length} files, ${mb(bytes)} before compression)...`);
      if (format === 'zip') {
        await zip.writeZip(dest, entries);
      } else {
        // tar gets the exact list. Folders are listed only when empty: tar makes parent folders by itself.
        const hasChild = new Set(entries.map((e) => e.rel.slice(0, e.rel.lastIndexOf('/'))));
        const names = entries.filter((e) => !e.isDir || !hasChild.has(e.rel)).map((e) => e.rel);
        await fsp.writeFile(listFile, names.join('\0'));
        await runTar([format === 'tar.gz' ? '-czf' : '-cf', dest, '-C', cfg.dir, '--null', '--no-recursion', '-T', listFile]);
      }
    } finally {
      savesOn();
      await fsp.rm(listFile, { force: true });
    }
    const { size } = await fsp.stat(dest);
    inst.panel(`Backup complete: ${name} (${mb(size)})`);
    store.logActivity(cfg.id, `Backup created (${reason}): ${name}`);
    await prune(cfg.id, cfg.backup?.keep ?? 10);
    return { name, size };
  } catch (err) {
    await fsp.rm(dest, { force: true });
    inst.panel(`Backup failed: ${err.message}`);
    store.logActivity(cfg.id, `Backup failed: ${err.message}`, 'error');
    throw err;
  } finally {
    inst.setBusy(null);
  }
}

/**
 * Things left out of backups (by the server's exclusion rules) are moved back from the folder as it was before
 * the restore, so restoring never throws away a map render or a cache you chose not to back up.
 */
async function carryOver(from, to, patterns) {
  const excluded = compileExcludes(patterns, { always: false });
  let moved = 0;
  const walk = async (rel) => {
    for (const d of await fsp.readdir(path.join(from, rel), { withFileTypes: true }).catch(() => [])) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      const isDir = d.isDirectory();
      if (excluded(r, isDir)) {
        const dest = path.join(to, r);
        if (fs.existsSync(dest)) continue;
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.rename(path.join(from, r), dest);
        moved++;
      } else if (isDir) await walk(r);
    }
  };
  await walk('');
  return moved;
}

function assertCanRestore(inst, name) {
  if (inst.proc) throw httpError(409, 'Stop the server before restoring a backup');
  assertIdle(inst);
  if (name !== undefined && !fs.existsSync(fileFor(inst.id, name))) throw httpError(404, 'Backup not found');
}

async function restore(inst, name) {
  assertCanRestore(inst, name);
  const file = fileFor(inst.id, name);
  const dir = inst.cfg.dir;
  const old = `${dir}.pre-restore-${Date.now()}`;
  inst.setBusy('Restoring backup');
  inst.panel(`Restoring ${name}...`);
  try {
    await fsp.rename(dir, old);
    try {
      await fsp.mkdir(dir, { recursive: true });
      const format = formatOf(name);
      if (format === 'zip') await zip.extractZip(file, dir);
      else await runTar([format === 'tar.gz' ? '-xzf' : '-xf', file, '-C', dir]);
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      await fsp.rename(old, dir);
      throw err;
    }
    const kept = await carryOver(old, dir, inst.cfg.backup?.exclude || []);
    if (kept) inst.panel(`Kept ${kept} excluded item${kept === 1 ? '' : 's'} (left out of backups) from before the restore`);
    await fsp.rm(old, { recursive: true, force: true });
    inst.panel('Restore complete');
    store.logActivity(inst.id, `Restored backup ${name}`);
  } catch (err) {
    inst.panel(`Restore failed: ${err.message}`);
    store.logActivity(inst.id, `Restore failed: ${err.message}`, 'error');
    throw err;
  } finally {
    inst.setBusy(null);
  }
}

async function remove(id, name) {
  await fsp.rm(fileFor(id, name));
}

const CONTENT_TYPE = { 'tar.gz': 'application/gzip', tar: 'application/x-tar', zip: 'application/zip' };
const contentType = (name) => CONTENT_TYPE[formatOf(name)];

module.exports = {
  FORMATS: Object.keys(FORMATS),
  dirFor,
  fileFor,
  list,
  create,
  restore,
  remove,
  folders,
  collect,
  compileExcludes,
  contentType,
  assertCanBackup: assertIdle,
  assertCanRestore,
  runTar,
};
