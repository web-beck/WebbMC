'use strict';
// Java for the servers: which Java a server's Minecraft version needs, which installed Java matches it, and
// Eclipse Temurin downloads (api.adoptium.net) into data/java/<major> when none does.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const store = require('./store');
const providers = require('./providers');
const software = require('./software');
const zip = require('./zip');
const { runTar } = require('./backups');

const JAVA_DIR = path.join(store.DATA_DIR, 'java');
const EXE = process.platform === 'win32' ? 'java.exe' : 'java';
const ADOPTIUM = 'https://api.adoptium.net/v3';
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

// ---------------------------------------------------------------- what is installed

const probes = new Map();
/** Run `bin -version`: { ok, path, version (first line), major } or { ok: false, path, error }. Cached for a minute. */
function probe(bin) {
  const hit = probes.get(bin);
  if (hit && Date.now() - hit.t < 60000) return hit.p;
  const p = new Promise((resolve) => {
    execFile(bin, ['-version'], { windowsHide: true, timeout: 10000 }, (err, stdout, stderr) => {
      const out = `${stderr || ''}${stdout || ''}`.trim();
      // "25.0.1" or "21" from Java 9 on, "1.8.0_401" before.
      const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
      const major = m ? Number(m[1] === '1' ? m[2] : m[1]) : 0;
      if (major) return resolve({ ok: true, path: bin, version: out.split(/\r?\n/)[0], major });
      // macOS ships a /usr/bin/java stub that only says no Java is installed.
      const error = err?.code === 'ENOENT' ? 'Java not found at that path' : out.split(/\r?\n/)[0] || err?.message || 'Not a Java executable';
      resolve({ ok: false, path: bin, error });
    });
  });
  probes.set(bin, { t: Date.now(), p });
  return p;
}

/** The java executable inside a JDK or JRE folder (macOS builds keep it under Contents/Home). */
function javaIn(root) {
  for (const p of [path.join(root, 'bin', EXE), path.join(root, 'Contents', 'Home', 'bin', EXE)]) if (fs.existsSync(p)) return p;
  return null;
}

/** Javas the panel downloaded, newest first. */
function installed() {
  let names = [];
  try {
    names = fs.readdirSync(JAVA_DIR);
  } catch {
    /* nothing downloaded yet */
  }
  return names
    .filter((n) => /^\d+$/.test(n))
    .map((n) => ({ major: Number(n), path: javaIn(path.join(JAVA_DIR, n)) }))
    .filter((j) => j.path)
    .sort((a, b) => b.major - a.major);
}

/** Java executables offered in the UI: "java" on PATH, WEBMC_JAVA_PATHS (set in the Docker image) and downloaded ones. */
function candidates() {
  const extra = (process.env.WEBMC_JAVA_PATHS || '').split(',').map((p) => p.trim()).filter((p) => p && fs.existsSync(p));
  return [...new Set(['java', ...extra, ...installed().map((j) => j.path)])];
}

/** An installed Java of exactly this major version, the panel default first. */
async function find(major) {
  for (const bin of new Set([store.state.settings.javaPath || 'java', ...candidates()])) if ((await probe(bin)).major === major) return bin;
  return null;
}

// ---------------------------------------------------------------- what a server needs

/** Temurin builds the LTS releases: Minecraft 1.17 asks for Java 16, which 17 runs. */
const lts = (n) => [8, 11, 17, 21, 25].find((v) => v >= n) || n;

/** By version number, for when Mojang's list cannot be reached or does not have the version. */
function guess(mc) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(mc));
  if (!m) return null;
  const [a, b, c] = [Number(m[1]), Number(m[2]), Number(m[3] || 0)];
  if (a >= 26) return 25;
  if (a !== 1) return null;
  if (b >= 21 || (b === 20 && c >= 5)) return 21;
  if (b >= 17) return 17;
  return 8;
}

const mojangCache = new Map();
/** The Java major version Mojang lists for a Minecraft release (javaVersion.majorVersion), or null. */
async function mojangJava(mc) {
  if (mojangCache.has(mc)) return mojangCache.get(mc);
  const entry = (await providers.getJson(MOJANG_MANIFEST)).versions.find((v) => v.id === mc);
  const major = entry ? (await providers.getJson(entry.url)).javaVersion?.majorVersion || null : null;
  if (major) mojangCache.set(mc, major);
  return major;
}

async function forVersion(mc) {
  const major = (await mojangJava(mc).catch(() => null)) || guess(mc);
  return major ? lts(major) : null;
}

/** The Java a jar's main class was compiled for (class file version 65 = Java 21, 69 = Java 25), or null. */
async function jarJava(file) {
  const manifest = await zip.readEntry(file, 'META-INF/MANIFEST.MF').catch(() => null);
  const main = manifest && /^Main-Class:\s*(\S+)/im.exec(manifest.toString('utf8'))?.[1];
  const cls = main && (await zip.readEntry(file, `${main.replace(/\./g, '/')}.class`).catch(() => null));
  if (!cls || cls.length < 8 || cls.readUInt32BE(0) !== 0xcafebabe) return null;
  return cls.readUInt16BE(6) - 44;
}

/**
 * The Java major version a server needs, or null when that cannot be told (a custom jar without version.json). At
 * least cfg.javaMin: the Java a crash said the jar needs ("class file version 69" means Java 25).
 */
async function required(cfg) {
  const found = await detect(cfg);
  return cfg.javaMin ? lts(Math.max(found || 0, cfg.javaMin)) : found;
}

async function detect(cfg) {
  const kind = software.kindOf(cfg);
  // Proxies are not tied to a Minecraft version: their jar says (Velocity 4 needs Java 25). At least 21 either way,
  // as BungeeCord's small starter class is built for older Java than the proxy it starts.
  if (kind === 'velocity' || kind === 'bungeecord') return lts(Math.max(21, (await jarJava(path.join(cfg.dir, cfg.jar)).catch(() => null)) || 0));
  if (providers.TYPES.includes(cfg.type) && cfg.version) return forVersion(cfg.version);
  // Vanilla and Paper jars carry Mojang's version.json, which names the Java they were built for.
  const buf = await zip.readEntry(path.join(cfg.dir, cfg.jar), 'version.json').catch(() => null);
  if (!buf) return null;
  try {
    const v = JSON.parse(buf.toString('utf8'));
    if (Number(v.java_version)) return lts(Number(v.java_version));
    return v.id ? forVersion(String(v.id)) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- downloads

let musl;
const isMusl = () => (musl ??= process.platform === 'linux' && !process.report?.getReport?.().header?.glibcVersionRuntime);

function platform() {
  const os = { darwin: 'mac', win32: 'windows', linux: isMusl() ? 'alpine-linux' : 'linux', aix: 'aix', sunos: 'solaris' }[process.platform];
  const arch = { x64: 'x64', arm64: 'aarch64', arm: 'arm', ppc64: 'ppc64le', s390x: 's390x', ia32: 'x32' }[process.arch];
  if (!os || !arch) throw new Error(`there are no Temurin builds for ${process.platform} ${process.arch}`);
  return { os, arch };
}

/** The newest Temurin package for a major version: a JRE, or a full JDK where no JRE is built. */
async function findPackage(feature, { os, arch }) {
  for (const image of ['jre', 'jdk']) {
    const list = await providers.getJson(`${ADOPTIUM}/assets/latest/${feature}/hotspot?architecture=${arch}&image_type=${image}&os=${os}&vendor=eclipse`);
    const asset = (Array.isArray(list) ? list : []).find((a) => a.binary?.package?.link);
    if (asset) return { release: asset.release_name, ...asset.binary.package };
  }
  return null;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function unpack(feature, pkg, log) {
  await fsp.mkdir(JAVA_DIR, { recursive: true });
  const work = path.join(JAVA_DIR, `.install-${feature}-${crypto.randomBytes(3).toString('hex')}`);
  await fsp.mkdir(path.join(work, 'out'), { recursive: true });
  try {
    const archive = path.join(work, pkg.name);
    log(`Downloading Java ${feature} (Eclipse Temurin ${pkg.release}, ${(pkg.size / 1048576).toFixed(0)} MB)...`);
    await providers.download(pkg.link, archive, (got, total) =>
      log(total ? `Downloading Java ${feature}... ${Math.round((got / total) * 100)}%` : `Downloading Java ${feature}... ${(got / 1048576).toFixed(1)} MB`),
    );
    if (pkg.checksum && (await sha256(archive)) !== pkg.checksum.toLowerCase()) throw new Error('the download is damaged (checksum mismatch)');
    log(`Unpacking Java ${feature}...`);
    const out = path.join(work, 'out');
    if (/\.zip$/i.test(pkg.name)) await zip.extractZip(archive, out);
    else await runTar(['-xzf', archive, '-C', out]);
    const top = (await fsp.readdir(out)).find((n) => !n.startsWith('.'));
    if (!top || !javaIn(path.join(out, top))) throw new Error('the download has no java executable in it');
    const dest = path.join(JAVA_DIR, String(feature));
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(path.join(out, top), dest);
    const bin = javaIn(dest);
    probes.delete(bin);
    const v = await probe(bin);
    if (!v.ok) throw new Error(`the downloaded Java does not run (${v.error})`);
    log(`Installed Java ${feature} (${v.version}) in ${dest}`);
    return bin;
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

async function download(major, log) {
  const where = platform();
  // Temurin has no Java 8 for every platform (Apple Silicon has none). Old Minecraft runs on the next LTS too.
  for (const feature of major === 8 ? [8, 11, 17] : [major]) {
    const have = javaIn(path.join(JAVA_DIR, String(feature)));
    if (have) return have;
    const pkg = await findPackage(feature, where);
    if (!pkg) continue;
    if (feature !== major) log(`Temurin has no Java ${major} for ${where.os} ${where.arch}. Using Java ${feature}, which runs the same servers.`);
    return unpack(feature, pkg, log);
  }
  throw new Error(`Temurin has no Java ${major} for ${where.os} ${where.arch}`);
}

const downloads = new Map();
/** Download a Java once, however many servers ask for it at the same time. */
function install(major, log) {
  if (!downloads.has(major)) downloads.set(major, download(major, log).finally(() => downloads.delete(major)));
  return downloads.get(major);
}

/** Remove half-finished downloads left by a panel that was stopped mid-install. */
function cleanup() {
  try {
    for (const n of fs.readdirSync(JAVA_DIR)) if (n.startsWith('.install-')) fs.rmSync(path.join(JAVA_DIR, n), { recursive: true, force: true });
  } catch {
    /* no java folder */
  }
}

// ---------------------------------------------------------------- per server

/**
 * The Java to launch a server with. Its own Java path always wins. Otherwise the Java its Minecraft version needs:
 * the panel default when it is that version, another known install, or a Temurin download. Never throws: when no
 * matching Java can be found or downloaded it says why and returns the panel default.
 */
async function forServer(cfg, { log = () => {}, busy = () => {} } = {}) {
  if (cfg.javaPath) return cfg.javaPath;
  const fallback = store.state.settings.javaPath || 'java';
  const need = await required(cfg).catch(() => null);
  if (!need) return fallback;
  const found = await find(need);
  if (found) return found;
  if (store.state.settings.autoJava === false) {
    log(`This server needs Java ${need}, which is not installed. Install it and pick it in Settings, or turn on Java downloads in Panel settings.`);
    return fallback;
  }
  busy(`Downloading Java ${need}`);
  try {
    return await install(need, log);
  } catch (err) {
    log(`Could not download Java ${need}: ${err.message}. Trying ${fallback} instead.`);
    return fallback;
  } finally {
    busy(null);
  }
}

/** What the Settings tab shows: the Java a server needs and the one it would launch with now, without downloading. */
async function plan(cfg) {
  if (cfg.javaPath) return { auto: false, ...(await probe(cfg.javaPath)) };
  const need = await required(cfg).catch(() => null);
  const found = need ? await find(need) : store.state.settings.javaPath || 'java';
  return { auto: true, need, willDownload: Boolean(need && !found && store.state.settings.autoJava !== false), ...(found ? await probe(found) : { ok: false }) };
}

module.exports = { JAVA_DIR, probe, candidates, installed, required, forServer, plan, cleanup };
