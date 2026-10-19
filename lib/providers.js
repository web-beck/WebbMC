'use strict';
// Server software catalogues and jar downloads (Paper, Purpur, Fabric, Vanilla, and the Velocity and BungeeCord proxies).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA = 'WebbMC/1.0 (+https://www.webbeck.org)';
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} responded with HTTP ${res.status}`);
  return res.json();
}

// PaperMC's build API (Paper, Velocity): every build of a version, with the SHA-256 of its jar.
async function fillLatest(project, v) {
  const b = await getJson(`https://fill.papermc.io/v3/projects/${project}/versions/${encodeURIComponent(v)}/builds/latest`);
  const sha = b.downloads?.['server:default']?.checksums?.sha256;
  return { build: b.id, time: Date.parse(b.time) || null, hash: sha ? { algo: 'sha256', value: sha } : null };
}
async function fillBuilds(project, v) {
  const list = await getJson(`https://fill.papermc.io/v3/projects/${project}/versions/${encodeURIComponent(v)}/builds`);
  return (Array.isArray(list) ? list : []).map((b) => ({ build: b.id, time: Date.parse(b.time) || null, hash: b.downloads?.['server:default']?.checksums?.sha256 || null }));
}

// latest(v): the newest build of a version, { build, time, hash: { algo, value } | null }. builds(v): all of them, to
// tell which one server.jar is. Fabric has neither: its server jar is put together on download.
const PROVIDERS = {
  paper: {
    label: 'Paper',
    async versions() {
      try {
        const d = await getJson('https://fill.papermc.io/v3/projects/paper');
        const list = Array.isArray(d.versions) ? d.versions : Object.values(d.versions || {}).flat();
        if (list.length) return list;
      } catch {
        /* fall back to the legacy API */
      }
      return (await getJson('https://api.papermc.io/v2/projects/paper')).versions;
    },
    async url(v) {
      try {
        const build = await getJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(v)}/builds/latest`);
        const dl = build.downloads?.['server:default'];
        if (dl?.url) return dl.url;
      } catch {
        /* fall back to the legacy API */
      }
      const d = await getJson(`https://api.papermc.io/v2/projects/paper/versions/${encodeURIComponent(v)}/builds`);
      const build = d.builds?.[d.builds.length - 1];
      if (!build) throw new Error(`No Paper builds exist for ${v}`);
      return `https://api.papermc.io/v2/projects/paper/versions/${v}/builds/${build.build}/downloads/${build.downloads.application.name}`;
    },
    latest: (v) => fillLatest('paper', v),
    builds: (v) => fillBuilds('paper', v),
  },
  purpur: {
    label: 'Purpur',
    versions: async () => (await getJson('https://api.purpurmc.org/v2/purpur')).versions,
    url: async (v) => `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(v)}/latest/download`,
    async latest(v) {
      const d = await getJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(v)}/latest`);
      return { build: Number(d.build) || d.build, time: d.timestamp || null, hash: d.md5 ? { algo: 'md5', value: d.md5 } : null };
    },
  },
  fabric: {
    label: 'Fabric',
    versions: async () => (await getJson('https://meta.fabricmc.net/v2/versions/game')).filter((g) => g.stable).map((g) => g.version),
    async url(v) {
      const [loaders, installers] = await Promise.all([
        getJson('https://meta.fabricmc.net/v2/versions/loader'),
        getJson('https://meta.fabricmc.net/v2/versions/installer'),
      ]);
      const loader = (loaders.find((l) => l.stable) || loaders[0]).version;
      const installer = (installers.find((i) => i.stable) || installers[0]).version;
      return `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(v)}/${loader}/${installer}/server/jar`;
    },
  },
  vanilla: {
    label: 'Vanilla',
    versions: async () => (await getJson(MOJANG_MANIFEST)).versions.filter((v) => v.type === 'release').map((v) => v.id),
    async url(v) {
      const entry = (await getJson(MOJANG_MANIFEST)).versions.find((x) => x.id === v);
      if (!entry) throw new Error(`Unknown Minecraft version ${v}`);
      const url = (await getJson(entry.url)).downloads?.server?.url;
      if (!url) throw new Error(`Minecraft ${v} has no official server download`);
      return url;
    },
    // One server jar per Minecraft version: "up to date" unless the jar was swapped for something else.
    async latest(v) {
      const entry = (await getJson(MOJANG_MANIFEST)).versions.find((x) => x.id === v);
      const sha1 = entry && (await getJson(entry.url)).downloads?.server?.sha1;
      return { build: null, time: entry ? Date.parse(entry.releaseTime) || null : null, hash: sha1 ? { algo: 'sha1', value: sha1 } : null };
    },
  },
  // Proxies: they sit in front of one or more servers and pass players between them.
  velocity: {
    label: 'Velocity',
    // Releases only (3.5.1, 4.2.0...). The -SNAPSHOT builds are for testing.
    async versions() {
      const d = await getJson('https://fill.papermc.io/v3/projects/velocity');
      return Object.values(d.versions || {}).flat();
    },
    async url(v) {
      const build = await getJson(`https://fill.papermc.io/v3/projects/velocity/versions/${encodeURIComponent(v)}/builds/latest`);
      const dl = build.downloads?.['server:default'];
      if (!dl?.url) throw new Error(`No Velocity build exists for ${v}`);
      return dl.url;
    },
    latest: (v) => fillLatest('velocity', v),
    builds: (v) => fillBuilds('velocity', v),
  },
  bungeecord: {
    label: 'BungeeCord',
    // BungeeCord has no numbered releases: every build on md_5's Jenkins supports all current Minecraft versions.
    unversioned: true,
    versions: async () => ['latest'],
    url: async () => 'https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar',
    async latest() {
      const d = await getJson('https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/api/json?tree=number,timestamp');
      return { build: d.number, time: d.timestamp || null, hash: null }; // no checksum: the installed build is remembered instead
    },
  },
};

const isStable = (v) => /^\d+(\.\d+)*$/.test(v);
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function provider(type) {
  const p = PROVIDERS[type];
  if (!p) throw Object.assign(new Error(`Unknown server software "${type}"`), { status: 400 });
  return p;
}

const cache = new Map();
async function listVersions(type) {
  const p = provider(type);
  const hit = cache.get(type);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.versions;
  const versions = p.unversioned ? await p.versions() : [...new Set((await p.versions()).filter(isStable))].sort((a, b) => compareVersions(b, a));
  cache.set(type, { t: Date.now(), versions });
  return versions;
}

// Checksums of server jars, by path, size and modified time (a jar is tens of MB).
const jarHashes = new Map();
async function hashJar(algo, file) {
  const st = await fs.promises.stat(file);
  const key = `${algo}|${file}|${st.size}|${st.mtimeMs}`;
  if (!jarHashes.has(key)) {
    const h = crypto.createHash(algo);
    for await (const chunk of fs.createReadStream(file)) h.update(chunk);
    jarHashes.set(key, h.digest('hex'));
  }
  return jarHashes.get(key);
}

/**
 * Is the server's jar the newest build of its version, and is there a newer Minecraft version? Gives
 * { known, version, current: { build, time } | null, latest: { build, time } | null, upToDate: true/false/null,
 *   newerVersion }. upToDate is null when it cannot be told (Fabric, a custom jar, a lookup that failed).
 */
async function status(cfg) {
  const p = PROVIDERS[cfg.type];
  const out = { type: cfg.type, known: Boolean(p), version: cfg.version || '', current: null, latest: null, upToDate: null, newerVersion: null };
  if (!p) return out;
  const versions = await listVersions(cfg.type).catch(() => []);
  if (!p.unversioned && isStable(out.version) && versions[0] && compareVersions(versions[0], out.version) > 0) out.newerVersion = versions[0];
  if (!p.latest) return out;
  const v = p.unversioned ? 'latest' : out.version === 'latest' ? versions[0] : out.version;
  const latest = v ? await p.latest(v).catch(() => null) : null;
  if (!latest) return out;
  out.latest = { build: latest.build, time: latest.time };
  const jar = path.join(cfg.dir, cfg.jar || 'server.jar');
  if (latest.hash && fs.existsSync(jar)) {
    const mine = await hashJar(latest.hash.algo, jar);
    out.upToDate = mine === latest.hash.value.toLowerCase();
    const found = out.upToDate ? latest : p.builds && (await p.builds(v).catch(() => [])).find((b) => b.hash === mine);
    if (found) out.current = { build: found.build, time: found.time };
  } else if (cfg.build != null) {
    out.current = { build: cfg.build, time: null };
    out.upToDate = String(cfg.build) === String(latest.build);
  }
  return out;
}

/** The newest build number of a version, to remember on install (BungeeCord has no checksum to tell it by). */
const latestBuild = async (type, version) => (await PROVIDERS[type]?.latest?.(version).catch(() => null))?.build ?? null;

/** Stream `url` to `dest` via a .part file. Calls onProgress(bytes, total) roughly every 10%. */
async function download(url, dest, onProgress) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`Download failed with HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const step = total ? total / 10 : 5 * 1024 * 1024;
  let got = 0;
  let next = step;
  const tmp = `${dest}.part`;
  try {
    await pipeline(
      Readable.fromWeb(res.body),
      async function* progress(source) {
        for await (const chunk of source) {
          got += chunk.length;
          if (got >= next) {
            next += step;
            onProgress?.(got, total);
          }
          yield chunk;
        }
      },
      fs.createWriteStream(tmp),
    );
    await fs.promises.rename(tmp, dest);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
  return got;
}

module.exports = {
  TYPES: Object.keys(PROVIDERS),
  label: (type) => PROVIDERS[type]?.label || type,
  listVersions,
  resolveUrl: (type, version) => provider(type).url(version),
  status,
  latestBuild,
  download,
  getJson,
};
