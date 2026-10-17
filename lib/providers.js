'use strict';
// Server software catalogues and jar downloads (Paper, Purpur, Fabric, Vanilla, and the Velocity and BungeeCord proxies).
const fs = require('fs');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA = 'WebbMC/1.0 (+https://www.webbeck.org)';
const MOJANG_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} responded with HTTP ${res.status}`);
  return res.json();
}

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
  },
  purpur: {
    label: 'Purpur',
    versions: async () => (await getJson('https://api.purpurmc.org/v2/purpur')).versions,
    url: async (v) => `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(v)}/latest/download`,
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
  },
  bungeecord: {
    label: 'BungeeCord',
    // BungeeCord has no numbered releases: every build on md_5's Jenkins supports all current Minecraft versions.
    unversioned: true,
    versions: async () => ['latest'],
    url: async () => 'https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar',
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
  download,
  getJson,
};
