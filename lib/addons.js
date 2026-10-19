'use strict';
// Plugins, mods and datapacks: search and install from Modrinth and Hangar (with required dependencies),
// the latest release of a GitHub repository, EssentialsX (stable or dev builds), GeyserMC (Geyser, Floodgate and
// the MCXboxBroadcast extension), or any direct link.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const providers = require('./providers');
const files = require('./files');
const software = require('./software');
const zip = require('./zip');
const { httpError } = require('./util');

const MODRINTH = 'https://api.modrinth.com/v2';
const HANGAR = 'https://hangar.papermc.io/api/v1';
const GITHUB = 'https://api.github.com';
const UA = 'WebbMC/1.0 (+https://www.webbeck.org)';
// key -> { file, title, version, source, page }. Modrinth keys are project ids; the others are prefixed
// (hangar:<id>, github:<owner>/<repo>, essentialsx:<module>, geysermc:<project>).
const MANIFEST = '.webmc-addons.json';
const MAX_DEPTH = 3;

const PLUGIN_LOADERS = { paper: ['paper', 'spigot', 'bukkit'], purpur: ['purpur', 'paper', 'spigot', 'bukkit'] };
const ANY_PLUGIN = ['paper', 'purpur', 'spigot', 'bukkit'];
const ANY_MOD = ['fabric', 'quilt', 'forge', 'neoforge'];

async function getJson(url, what, headers = {}) {
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(20000) });
  } catch {
    throw httpError(502, `Could not reach ${what}`);
  }
  if (res.status === 404) throw httpError(404, `${what} could not find that project or version`);
  if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
    const mins = Math.max(1, Math.ceil((Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now()) / 60000));
    throw httpError(
      429,
      `${what}'s hourly limit for anonymous requests is used up. Try again in ${mins} minute${mins === 1 ? '' : 's'}${
        url.startsWith(GITHUB) ? ', or set a GITHUB_TOKEN environment variable for a higher limit' : ''
      }.`,
    );
  }
  if (!res.ok) throw httpError(502, `${what} responded with HTTP ${res.status}`);
  return res.json();
}

const modrinth = (p) => getJson(`${MODRINTH}${p}`, 'Modrinth');
const hangar = (p) => getJson(`${HANGAR}${p}`, 'Hangar');
const github = (p) =>
  getJson(`${GITHUB}${p}`, 'GitHub', {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
  });
const enc = encodeURIComponent;

/**
 * What this server can load: plugins (Paper family), mods (Fabric etc.) or only datapacks (Vanilla).
 * `version` overrides the Minecraft version to match: '' (or omitted) uses the server's own, 'all' matches any,
 * anything else is a specific version such as 1.21.4.
 */
function profile(inst, version = '') {
  const prof = serverProfile(inst);
  if (prof.proxy) return prof; // proxy plugins are not tied to a Minecraft version
  const v = String(version || '').trim();
  if (v === 'all') return { ...prof, gameVersion: '', anyVersion: true };
  if (v) {
    if (!/^\d+(\.\d+)+$/.test(v)) throw httpError(400, 'Pick a Minecraft version like 1.21.4');
    return { ...prof, gameVersion: v };
  }
  return prof;
}

// Proxy plugins: Modrinth loader names, and the Hangar platform (BungeeCord plugins are listed as Waterfall there).
const PROXY_PROFILES = {
  velocity: { loaders: ['velocity'], platform: 'VELOCITY', label: 'Velocity' },
  bungeecord: { loaders: ['bungeecord', 'waterfall'], platform: 'WATERFALL', label: 'BungeeCord' },
};

function serverProfile(inst) {
  const cfg = inst.cfg;
  const proxy = PROXY_PROFILES[software.kindOf(cfg)];
  if (proxy) {
    return { kind: 'plugins', proxy: true, loaders: proxy.loaders, platform: proxy.platform, platformLabel: proxy.label, gameVersion: '', anyVersion: true, sources: ['modrinth', 'hangar', 'geysermc', 'github', 'link'], dir: 'plugins', datapackDir: null };
  }
  const has = (d) => fs.existsSync(path.join(cfg.dir, d));
  let kind;
  let loaders;
  if (PLUGIN_LOADERS[cfg.type]) [kind, loaders] = ['plugins', PLUGIN_LOADERS[cfg.type]];
  else if (cfg.type === 'fabric') [kind, loaders] = ['mods', ['fabric']];
  else if (cfg.type === 'vanilla') [kind, loaders] = ['datapacks', []];
  else if (has('mods') && !has('plugins')) [kind, loaders] = ['mods', ANY_MOD];
  else [kind, loaders] = ['plugins', ANY_PLUGIN];
  const reported = /(\d+\.\d+(?:\.\d+)?)/.exec(inst.ping?.version || '')?.[1];
  const gameVersion = /^\d+(\.\d+)+$/.test(cfg.version) ? cfg.version : reported || '';
  const levelName = inst.readProps()['level-name'] || 'world';
  const sources = kind === 'plugins' ? ['modrinth', 'hangar', 'essentialsx', 'geysermc', 'github', 'link'] : kind === 'mods' ? ['modrinth', 'geysermc', 'github', 'link'] : ['modrinth', 'github', 'link'];
  return { kind, loaders, platform: 'PAPER', platformLabel: 'Paper', gameVersion, sources, dir: kind === 'datapacks' ? `${levelName}/datapacks` : kind, datapackDir: `${levelName}/datapacks` };
}

const readManifest = async (dir) => {
  try {
    return JSON.parse(await fsp.readFile(path.join(dir, MANIFEST), 'utf8'));
  } catch {
    return {};
  }
};
const writeManifest = (dir, m) => fsp.writeFile(path.join(dir, MANIFEST), JSON.stringify(m, null, 2));

const safeName = (name) => {
  const base = path.basename(String(name || '')).replace(/[^\w.+\-()[\] ]/g, '_');
  if (!base || base.startsWith('.')) throw httpError(400, 'Could not work out a safe file name');
  return base;
};

async function digest(algo, file) {
  const hash = crypto.createHash(algo);
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

const newCtx = () => ({ seen: new Set(), results: [], warnings: [], depth: 0 });

/**
 * Download one file into `relDir`, verify its checksum and record it in the manifest under `key`.
 * Reinstalling a project replaces its previous file, so two versions never load at once.
 */
async function placeFile(inst, ctx, { key, relDir, filename, url, hash, title, version, source, page }) {
  const dir = files.resolveIn(inst.dir, relDir);
  const name = safeName(filename);
  const rel = `${relDir}/${name}`;
  const dest = path.join(dir, name);
  await fsp.mkdir(dir, { recursive: true });
  const manifest = await readManifest(inst.dir);
  const previous = manifest[key];
  const result = { title, version, file: rel, dependency: ctx.depth > 0, source };
  // Same name is not enough (Geyser-Spigot.jar is called that in every build): with a checksum, it must match too.
  // A matching file added by hand counts as well; it is recorded so WebbMC knows where it came from.
  const same = fs.existsSync(dest) && (hash?.value ? (await digest(hash.algo, dest)) === hash.value.toLowerCase() : previous?.file === rel);
  if (same && (!previous || previous.file === rel)) {
    if (!previous) {
      manifest[key] = { file: rel, title, version, source, page };
      await writeManifest(inst.dir, manifest);
    }
    ctx.results.push({ ...result, status: 'already installed' });
    return previous;
  }
  inst.panel(`Downloading ${title} ${version}...`);
  await providers.download(url, dest);
  if (hash?.value && (await digest(hash.algo, dest)) !== hash.value.toLowerCase()) {
    await fsp.rm(dest, { force: true });
    throw httpError(502, `Checksum mismatch for ${name}; the download was discarded`);
  }
  await fsp.rm(`${dest}.disabled`, { force: true });
  if (previous && previous.file !== rel) {
    await fsp.rm(files.resolveIn(inst.dir, previous.file), { force: true }).catch(() => {});
    await fsp.rm(files.resolveIn(inst.dir, `${previous.file}.disabled`), { force: true }).catch(() => {});
  }
  manifest[key] = { file: rel, title, version, source, page };
  await writeManifest(inst.dir, manifest);
  ctx.results.push({ ...result, status: previous ? `replaced ${previous.version}` : 'installed' });
  return previous;
}

function urlOf(link) {
  try {
    const u = new URL(String(link || '').trim());
    return ['http:', 'https:'].includes(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

const segments = (u) => u.pathname.split('/').filter(Boolean).map(decodeURIComponent);

// ---------------------------------------------------------------- Modrinth

function parseModrinth(link) {
  const u = urlOf(link);
  if (!u || !/(^|\.)modrinth\.com$/i.test(u.hostname)) return null;
  const [type, slug, kw, version] = segments(u);
  if (!slug || !['plugin', 'mod', 'datapack', 'project'].includes(type)) {
    if (['modpack', 'resourcepack', 'shader'].includes(type)) throw httpError(400, `That is a Modrinth ${type}, which a server cannot load. Use a plugin, mod or datapack link.`);
    throw httpError(400, 'That does not look like a Modrinth project link (expected https://modrinth.com/plugin/<name>)');
  }
  return { slug, version: kw === 'version' ? version : null };
}

// Builds of one release for different loaders (BlueMap's 5.29-paper and 5.29-spigot) go up within minutes of each other.
const SAME_RELEASE_MS = 3 * 24 * 60 * 60 * 1000;
// How well a build suits this server: its best loader's place in `loaders` (0 = the server's own).
const loaderRank = (v, loaders) => Math.min(...v.loaders.map((l) => (loaders.includes(l) ? loaders.indexOf(l) : Infinity)));

/**
 * From Modrinth's version list (newest first), the build to install: releases first, then beta/alpha. Among the
 * builds of the newest release, the one for the loader earliest in `loaders`, so Paper gets the Paper build and
 * not whichever of Paper/Spigot happened to be uploaded last.
 */
function bestOf(list, loaders) {
  const pool = list.filter((v) => v.version_type === 'release');
  const from = pool.length ? pool : list;
  if (!from.length) return null;
  const newest = Date.parse(from[0].date_published);
  return from
    .filter((v) => newest - Date.parse(v.date_published) <= SAME_RELEASE_MS)
    .reduce((a, b) => (loaderRank(b, loaders) < loaderRank(a, loaders) ? b : a));
}

/** Pick the newest compatible version: release first, then beta/alpha. Falls back to datapack builds. */
async function pickVersion(project, prof, wanted) {
  const usable = (v) => v.loaders.some((l) => prof.loaders.includes(l)) || (!prof.proxy && v.loaders.includes('datapack'));
  if (wanted) {
    const v = await modrinth(`/project/${project.id}/version/${enc(wanted)}`);
    if (!usable(v)) throw httpError(400, `${project.title} ${v.version_number} is for ${v.loaders.join('/')}, which this server cannot load`);
    return v;
  }
  const query = async (loaders) => {
    const q = new URLSearchParams({ loaders: JSON.stringify(loaders) });
    if (prof.gameVersion) q.set('game_versions', JSON.stringify([prof.gameVersion]));
    return bestOf(await modrinth(`/project/${project.id}/version?${q}`), loaders);
  };
  const v = (prof.loaders.length && (await query(prof.loaders))) || (!prof.proxy && project.loaders.includes('datapack') && (await query(['datapack'])));
  if (!v) {
    const pretty = { paper: 'Paper', purpur: 'Purpur', fabric: 'Fabric', spigot: 'Spigot', bukkit: 'Bukkit', velocity: 'Velocity', bungeecord: 'BungeeCord' };
    const on = prof.kind === 'datapacks' ? 'Vanilla (datapacks only)' : pretty[prof.loaders[0]] || prof.loaders[0];
    throw httpError(404, `${project.title} has no version for ${on}${prof.gameVersion ? ` on Minecraft ${prof.gameVersion}` : ''}`);
  }
  return v;
}

async function installModrinth(inst, prof, idOrSlug, wanted, ctx) {
  const project = await modrinth(`/project/${enc(idOrSlug)}`);
  if (ctx.seen.has(project.id)) return;
  ctx.seen.add(project.id);
  if (['modpack', 'resourcepack', 'shader'].includes(project.project_type)) throw httpError(400, `${project.title} is a ${project.project_type}, not something a server loads`);

  const version = await pickVersion(project, prof, wanted);
  const isDatapack = !version.loaders.some((l) => prof.loaders.includes(l));
  const file = version.files.find((f) => f.primary) || version.files[0];
  if (!file) throw httpError(404, `${project.title} ${version.version_number} has no downloadable file`);
  await placeFile(inst, ctx, {
    key: project.id,
    relDir: isDatapack ? prof.datapackDir : prof.dir,
    filename: file.filename,
    url: file.url,
    hash: { algo: 'sha512', value: file.hashes?.sha512 },
    title: project.title,
    version: version.version_number,
    source: 'modrinth',
    page: `https://modrinth.com/project/${project.slug}`,
  });

  if (ctx.depth >= MAX_DEPTH) return;
  for (const dep of version.dependencies || []) {
    if (dep.dependency_type !== 'required' || !dep.project_id) continue;
    ctx.depth++;
    try {
      await installModrinth(inst, prof, dep.project_id, null, ctx);
    } catch (err) {
      ctx.warnings.push(`Required dependency of ${project.title} could not be installed: ${err.message}`);
    } finally {
      ctx.depth--;
    }
  }
}

// ---------------------------------------------------------------- Hangar (PaperMC's plugin site)

function parseHangar(link) {
  const u = urlOf(link);
  if (!u || !/^hangar\.papermc\.io$/i.test(u.hostname)) return null;
  const [owner, slug, kw, version] = segments(u);
  if (!owner || !slug) throw httpError(400, 'That does not look like a Hangar project link (expected https://hangar.papermc.io/<author>/<plugin>)');
  return { slug, version: kw === 'versions' ? version : null };
}

async function installHangar(inst, prof, idOrSlug, wanted, ctx) {
  if (prof.kind !== 'plugins') throw httpError(400, 'Hangar hosts Paper plugins, which this server cannot load');
  const project = await hangar(`/projects/${enc(idOrSlug)}`);
  const key = `hangar:${project.id}`;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  const slug = project.namespace.slug;

  let version;
  if (wanted) version = await hangar(`/projects/${enc(slug)}/versions/${enc(wanted)}`);
  else {
    const find = async (params) => (await hangar(`/projects/${enc(slug)}/versions?${new URLSearchParams({ limit: '1', platform: prof.platform, ...params })}`)).result?.[0];
    const gv = prof.gameVersion ? { platformVersion: prof.gameVersion } : {};
    version = (await find({ ...gv, channel: 'Release' })) || (await find(gv));
    if (!version) throw httpError(404, `${project.name} has no version for ${prof.platformLabel}${prof.gameVersion ? ` ${prof.gameVersion}` : ''}`);
  }
  const dl = version.downloads?.[prof.platform];
  if (!dl) throw httpError(404, `${project.name} ${version.name} has no ${prof.platformLabel} download`);
  let url = dl.downloadUrl;
  if (!url) {
    if (dl.externalUrl && /\.jar(\?|$)/i.test(dl.externalUrl)) url = dl.externalUrl;
    else throw httpError(400, `${project.name} is downloaded from another site (${dl.externalUrl}). Get the jar there and upload it in Files.`);
  }
  await placeFile(inst, ctx, {
    key,
    relDir: prof.dir,
    filename: dl.fileInfo?.name || decodeURIComponent(new URL(url).pathname.split('/').pop()),
    url,
    hash: { algo: 'sha256', value: dl.fileInfo?.sha256Hash },
    title: project.name,
    version: version.name,
    source: 'hangar',
    page: `https://hangar.papermc.io/${project.namespace.owner}/${slug}`,
  });

  if (ctx.depth >= MAX_DEPTH) return;
  for (const dep of version.pluginDependencies?.[prof.platform] || []) {
    if (!dep.required) continue;
    ctx.depth++;
    try {
      if (dep.projectId) await installHangar(inst, prof, String(dep.projectId), null, ctx);
      else ctx.warnings.push(`${project.name} also needs ${dep.name}${dep.externalUrl ? ` (${dep.externalUrl})` : ''}, which is not on Hangar. Install it yourself.`);
    } catch (err) {
      ctx.warnings.push(`Required dependency ${dep.name} of ${project.name} could not be installed: ${err.message}`);
    } finally {
      ctx.depth--;
    }
  }
}

// ---------------------------------------------------------------- GitHub releases

function parseGithub(link) {
  let raw = String(link || '').trim();
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) raw = `https://github.com/${raw}`; // owner/repo shorthand
  const u = urlOf(raw);
  if (!u || !/^(www\.)?github\.com$/i.test(u.hostname)) return null;
  const [owner, repo, kw, kw2, tag] = segments(u);
  if (kw === 'releases' && kw2 === 'download') return null; // a direct file link: download it as-is
  if (!owner || !repo) throw httpError(400, 'That does not look like a GitHub repository link (expected https://github.com/<owner>/<repo>)');
  return { owner, repo: repo.replace(/\.git$/, ''), tag: kw === 'releases' && kw2 === 'tag' && tag ? tag : null };
}

async function githubLatest(gh) {
  const base = `/repos/${enc(gh.owner)}/${enc(gh.repo)}`;
  if (gh.tag) return github(`${base}/releases/tags/${enc(gh.tag)}`);
  try {
    return await github(`${base}/releases/latest`);
  } catch (err) {
    if (err.status !== 404) throw err;
    // "latest" ignores pre-releases; some projects only publish those.
    const list = await github(`${base}/releases?per_page=5`);
    if (!list.length) throw httpError(404, `${gh.owner}/${gh.repo} has no releases on GitHub`);
    return list[0];
  }
}

function releaseFiles(rel, prof) {
  const ext = prof.kind === 'datapacks' ? /\.zip$/i : /\.jar$/i;
  return (rel.assets || []).filter((a) => ext.test(a.name) && !/-(sources|javadoc)\.jar$/i.test(a.name));
}

/** When a release has several jars, guess the one for this server's loader; null means "ask the user". */
function pickAsset(assets, prof) {
  if (assets.length <= 1) return assets[0] || null;
  const want = prof.kind === 'mods' || prof.proxy ? new RegExp(prof.loaders.join('|'), 'i') : /paper|bukkit|spigot|purpur/i;
  const avoid =
    prof.platform === 'VELOCITY'
      ? /bukkit|spigot|paper|bungee|waterfall|fabric|forge/i
      : prof.proxy
        ? /bukkit|spigot|paper|velocity|fabric|forge/i
        : prof.kind === 'mods'
          ? /bukkit|spigot|paper|velocity|bungee/i
          : /velocity|bungee|waterfall|fabric|forge|sponge/i;
  const good = assets.filter((a) => want.test(a.name) && !avoid.test(a.name));
  if (good.length === 1) return good[0];
  const neutral = assets.filter((a) => !avoid.test(a.name));
  return neutral.length === 1 ? neutral[0] : null;
}

const assetInfo = (a) => ({ name: a.name, size: a.size, downloads: a.download_count ?? 0 });

async function githubRelease(inst, link) {
  const prof = profile(inst);
  const gh = parseGithub(link);
  if (!gh) throw httpError(400, 'Enter a GitHub repository, like https://github.com/owner/repo');
  const rel = await githubLatest(gh);
  const assets = releaseFiles(rel, prof);
  const manifest = await readManifest(inst.dir);
  const installed = manifest[`github:${gh.owner}/${gh.repo}`.toLowerCase()];
  return {
    repo: `${gh.owner}/${gh.repo}`,
    url: `https://github.com/${gh.owner}/${gh.repo}${gh.tag ? `/releases/tag/${enc(gh.tag)}` : ''}`,
    tag: rel.tag_name,
    name: rel.name || rel.tag_name,
    published: rel.published_at,
    prerelease: rel.prerelease,
    htmlUrl: rel.html_url,
    assets: assets.map(assetInfo),
    suggested: pickAsset(assets, prof)?.name || null,
    installed: installed ? { version: installed.version, file: installed.file } : null,
  };
}

/** Returns a list to choose from when the release has several candidate files and none was named. */
async function installGithub(inst, prof, gh, assetName, ctx) {
  const rel = await githubLatest(gh);
  const assets = releaseFiles(rel, prof);
  const kind = prof.kind === 'datapacks' ? '.zip' : '.jar';
  if (!assets.length) throw httpError(404, `Release ${rel.tag_name} of ${gh.owner}/${gh.repo} has no ${kind} file`);
  const asset = assetName ? assets.find((a) => a.name === assetName) : pickAsset(assets, prof);
  if (!asset) {
    if (assetName) throw httpError(404, `Release ${rel.tag_name} has no file called ${assetName}`);
    return { repo: `${gh.owner}/${gh.repo}`, tag: rel.tag_name, assets: assets.map(assetInfo) };
  }
  await placeFile(inst, ctx, {
    key: `github:${gh.owner}/${gh.repo}`.toLowerCase(),
    relDir: prof.dir,
    filename: asset.name,
    url: asset.browser_download_url,
    hash: { algo: 'sha256', value: /^sha256:/.test(asset.digest || '') ? asset.digest.slice(7) : null },
    title: gh.repo,
    version: rel.tag_name,
    source: 'github',
    page: `https://github.com/${gh.owner}/${gh.repo}`,
  });
  if (rel.prerelease) ctx.warnings.push(`${gh.repo} ${rel.tag_name} is a pre-release (the project has no stable release yet).`);
  return null;
}

// ---------------------------------------------------------------- EssentialsX

const ESSX_MODULES = [
  { id: '', name: 'EssentialsX', desc: 'The core: homes, warps, kits, teleports, economy and over 130 commands. Every other module needs it.', requires: null },
  { id: 'Chat', name: 'EssentialsX Chat', desc: 'Chat formatting, group prefixes and local chat.', requires: '' },
  { id: 'Spawn', name: 'EssentialsX Spawn', desc: 'Controls where players spawn and where new players appear.', requires: '' },
  { id: 'AntiBuild', name: 'EssentialsX AntiBuild', desc: 'Stops chosen groups from placing, breaking or using blocks.', requires: '' },
  { id: 'Protect', name: 'EssentialsX Protect', desc: 'World protection: fire spread, explosions and mob griefing.', requires: '' },
  { id: 'GeoIP', name: 'EssentialsX GeoIP', desc: 'Shows which country players join from.', requires: '' },
  { id: 'Discord', name: 'EssentialsX Discord', desc: 'Bridges chat and console messages with a Discord channel.', requires: '' },
  { id: 'DiscordLink', name: 'EssentialsX DiscordLink', desc: 'Links Minecraft accounts to Discord accounts. Needs the Discord module.', requires: 'Discord' },
  { id: 'XMPP', name: 'EssentialsX XMPP', desc: 'Bridges chat with an XMPP (Jabber) server.', requires: '' },
];
const ESSX_FILE = /^EssentialsX([A-Za-z]*)-(.+?)\.jar(\.disabled)?$/;
const essxCache = new Map(); // channel -> { t, build }

/** The newest EssentialsX build, from the same places essentialsx.net/downloads uses. */
async function essentialsBuild(channel) {
  const hit = essxCache.get(channel);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.build;
  const filesById = {};
  let build;
  if (channel === 'dev') {
    const ci = await getJson('https://ci-api.essentialsx.net/job/EssentialsX/lastSuccessfulBuild/api/json', 'The EssentialsX build server');
    for (const a of ci.artifacts || []) {
      const m = ESSX_FILE.exec(a.fileName);
      if (m && !m[3]) filesById[m[1]] = { name: a.fileName, version: m[2], url: `https://ci.ender.zone/job/EssentialsX/${ci.number}/artifact/${a.relativePath}`, size: null, hash: null };
    }
    build = { channel, version: filesById['']?.version || `build ${ci.number}`, build: ci.number, page: 'https://essentialsx.net/downloads?branch=dev', published: ci.timestamp || null, files: filesById };
  } else {
    const rel = await github('/repos/EssentialsX/Essentials/releases/latest');
    for (const a of rel.assets || []) {
      const m = ESSX_FILE.exec(a.name);
      if (m && !m[3]) {
        filesById[m[1]] = {
          name: a.name,
          version: m[2],
          url: a.browser_download_url,
          size: a.size,
          hash: { algo: 'sha256', value: /^sha256:/.test(a.digest || '') ? a.digest.slice(7) : null },
        };
      }
    }
    build = { channel: 'stable', version: rel.tag_name, build: null, page: rel.html_url, published: Date.parse(rel.published_at) || null, files: filesById };
  }
  essxCache.set(channel, { t: Date.now(), build });
  return build;
}

/** EssentialsX jars in the plugins folder, by module id ('' is the core). */
async function essentialsInstalled(inst, prof) {
  let entries = [];
  try {
    entries = await files.list(inst.dir, prof.dir);
  } catch {
    return {};
  }
  const out = {};
  for (const e of entries) {
    const m = !e.dir && ESSX_FILE.exec(e.name);
    if (m) (out[m[1]] ||= []).push({ path: `${prof.dir}/${e.name}`, version: m[2], enabled: !m[3] });
  }
  return out;
}

function assertPlugins(prof) {
  if (prof.kind !== 'plugins' || prof.proxy) throw httpError(400, 'EssentialsX is a Paper/Spigot plugin, and this server cannot load it');
}

async function essentialsInfo(inst, channel) {
  const prof = profile(inst);
  assertPlugins(prof);
  const build = await essentialsBuild(channel === 'dev' ? 'dev' : 'stable');
  const installed = await essentialsInstalled(inst, prof);
  return {
    channel: build.channel,
    version: build.version,
    build: build.build,
    page: build.page,
    published: build.published,
    modules: ESSX_MODULES.filter((m) => build.files[m.id]).map((m) => {
      const have = installed[m.id]?.[0] || null;
      return {
        id: m.id,
        name: m.name,
        desc: m.desc,
        requires: m.requires,
        file: build.files[m.id].name,
        size: build.files[m.id].size,
        installed: have,
        upToDate: Boolean(have && have.version === build.files[m.id].version),
      };
    }),
  };
}

async function essentialsInstall(inst, modules, channel) {
  const prof = profile(inst);
  assertPlugins(prof);
  const picked = new Set((Array.isArray(modules) ? modules : []).map(String));
  if (!picked.size) throw httpError(400, 'Pick at least one EssentialsX module');
  const wanted = new Set();
  for (const id of picked) {
    let m = ESSX_MODULES.find((x) => x.id === id);
    if (!m) throw httpError(400, `Unknown EssentialsX module "${id}"`);
    for (; m; m = m.requires === null ? null : ESSX_MODULES.find((x) => x.id === m.requires)) wanted.add(m.id);
  }
  const build = await essentialsBuild(channel === 'dev' ? 'dev' : 'stable');
  const before = await essentialsInstalled(inst, prof);
  const ctx = newCtx();
  for (const m of ESSX_MODULES) {
    if (!wanted.has(m.id)) continue;
    const f = build.files[m.id];
    if (!f) {
      ctx.warnings.push(`This ${build.channel} build has no ${m.name} jar`);
      continue;
    }
    ctx.depth = picked.has(m.id) ? 0 : 1;
    const rel = `${prof.dir}/${safeName(f.name)}`;
    const count = ctx.results.length;
    await placeFile(inst, ctx, { key: `essentialsx:${m.id || 'core'}`, relDir: prof.dir, filename: f.name, url: f.url, hash: f.hash, title: m.name, version: f.version, source: 'essentialsx', page: 'https://essentialsx.net' });
    // Remove other copies of this module, including ones installed by hand before WebbMC managed it.
    const old = (before[m.id] || []).filter((o) => o.path !== rel && o.path !== `${rel}.disabled`);
    for (const o of old) await fsp.rm(files.resolveIn(inst.dir, o.path), { force: true }).catch(() => {});
    const r = ctx.results[count];
    if (r && r.status === 'installed' && old.length) r.status = `replaced ${old[0].version}`;
  }
  ctx.depth = 0;
  report(inst, ctx);
  return { results: ctx.results, warnings: ctx.warnings };
}

// ---------------------------------------------------------------- GeyserMC: Geyser, Floodgate, MCXboxBroadcast

const GEYSER_API = 'https://download.geysermc.org/v2';
const XBOX_REPO = 'MCXboxBroadcast/Broadcaster';
const XBOX_ASSET = 'MCXboxBroadcastExtension.jar';
// platforms: the GeyserMC download for each kind of server. file: the names these jars have, also when added by hand.
const GEYSER_PROJECTS = [
  {
    id: 'geyser',
    name: 'Geyser',
    modrinth: 'geyser',
    desc: 'Lets Bedrock Edition players (phones, tablets, consoles, Windows) join this Java server.',
    page: 'https://geysermc.org/download',
    platforms: { spigot: 'spigot', velocity: 'velocity', bungeecord: 'bungeecord', fabric: 'fabric', neoforge: 'neoforge' },
    file: /^Geyser(-(Spigot|Velocity|BungeeCord|Fabric|NeoForge)[^/]*)?\.jar$/i,
  },
  {
    id: 'floodgate',
    name: 'Floodgate',
    modrinth: 'floodgate',
    desc: 'Lets Bedrock players join without also owning Java Edition. Needs Geyser.',
    page: 'https://geysermc.org/download',
    requires: 'geyser',
    platforms: { spigot: 'spigot', velocity: 'velocity', bungeecord: 'bungee' },
    file: /^floodgate(-(spigot|bungee|velocity)[^/]*)?\.jar$/i,
  },
  {
    id: 'mcxboxbroadcast',
    name: 'MCXboxBroadcast',
    desc: "Shows the server in Bedrock players' Friends tab through an Xbox account, so consoles can join. A Geyser extension: it goes in Geyser's extensions folder.",
    page: `https://github.com/${XBOX_REPO}`,
    requires: 'geyser',
    extension: true,
    file: /^MCXboxBroadcast(Extension)?([-_ ][^/]*)?\.jar$/i,
  },
];
// Where Geyser keeps its files (and so its extensions folder) on each platform, when it has not made one yet.
const GEYSER_DATA = { spigot: 'plugins/Geyser-Spigot', velocity: 'plugins/geyser', bungeecord: 'plugins/Geyser-BungeeCord', fabric: 'config/Geyser-Fabric', neoforge: 'config/Geyser-NeoForge' };

const geyserCache = new Map(); // key -> { t, value }
async function remember(key, fn) {
  const hit = geyserCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.value;
  const value = await fn();
  geyserCache.set(key, { t: Date.now(), value });
  return value;
}

/** Which GeyserMC download fits this server: spigot, velocity, bungeecord, fabric or neoforge (null: none). */
function geyserPlatform(inst, prof) {
  if (prof.proxy) return software.kindOf(inst.cfg) === 'velocity' ? 'velocity' : 'bungeecord';
  if (prof.kind === 'plugins') return 'spigot';
  if (prof.kind === 'mods') return prof.loaders.includes('fabric') ? 'fabric' : prof.loaders.includes('neoforge') ? 'neoforge' : null;
  return null;
}

/** Geyser's own folders on this server (plugins/Geyser-Spigot, config/Geyser-Fabric...), where extensions live. */
async function geyserDataDirs(inst, prof) {
  const out = [];
  for (const base of [prof.dir, 'config']) {
    if (prof.kind === 'datapacks') break;
    let entries = [];
    try {
      entries = await files.list(inst.dir, base);
    } catch {
      continue;
    }
    for (const e of entries) if (e.dir && /^geyser(-[a-z]+)?$/i.test(e.name)) out.push(`${base}/${e.name}`);
  }
  return out;
}

/** The newest build of a project for this platform: { label, name, url, sha256, published }, or null when there is none. */
async function geyserLatest(id, platform) {
  if (id === 'mcxboxbroadcast') {
    const rel = await remember('xbox', () => github(`/repos/${XBOX_REPO}/releases/latest`));
    const a = (rel.assets || []).find((x) => x.name === XBOX_ASSET);
    if (!a) return null;
    return { label: `build ${rel.tag_name}`, name: a.name, url: a.browser_download_url, sha256: /^sha256:/.test(a.digest || '') ? a.digest.slice(7) : null, published: Date.parse(rel.published_at) || null, page: rel.html_url };
  }
  const key = GEYSER_PROJECTS.find((p) => p.id === id)?.platforms[platform];
  if (!key) return null;
  const b = await remember(`latest:${id}`, () => getJson(`${GEYSER_API}/projects/${id}/versions/latest/builds/latest`, 'GeyserMC'));
  const d = b.downloads?.[key];
  if (!d) return null;
  return {
    label: `${b.version} build ${b.build}`,
    name: d.name,
    url: `${GEYSER_API}/projects/${id}/versions/${b.version}/builds/${b.build}/downloads/${key}`,
    sha256: d.sha256,
    published: Date.parse(b.time) || null,
    version: b.version,
    page: 'https://geysermc.org/download',
  };
}

/** Which build a file is, from its SHA-256: "2.12.0 build 1260", "build 158", or '' when it is not a recent one. */
async function geyserBuildOf(id, sha256, latest) {
  if (!sha256) return '';
  if (latest?.sha256 === sha256) return latest.label;
  try {
    if (id === 'mcxboxbroadcast') {
      const rels = await remember('xbox-releases', () => github(`/repos/${XBOX_REPO}/releases?per_page=50`));
      const rel = rels.find((r) => (r.assets || []).some((a) => a.digest === `sha256:${sha256}`));
      return rel ? `build ${rel.tag_name}` : '';
    }
    if (!latest?.version) return '';
    const builds = await remember(`builds:${id}:${latest.version}`, () => getJson(`${GEYSER_API}/projects/${id}/versions/${latest.version}/builds`, 'GeyserMC'));
    const b = (builds.builds || []).find((x) => Object.values(x.downloads || {}).some((f) => f.sha256 === sha256));
    return b ? `${latest.version} build ${b.build}` : '';
  } catch {
    return '';
  }
}

const geyserIcon = (p) =>
  p.modrinth ? remember(`icon:${p.id}`, () => modrinth(`/project/${p.modrinth}`).then((x) => x.icon_url || null)).catch(() => null) : Promise.resolve(null);

/** The GeyserMC project a file belongs to (by its name and place), or null. */
function geyserProjectOf(item) {
  const name = item.name.replace(/\.disabled$/i, '');
  return GEYSER_PROJECTS.find((p) => Boolean(p.extension) === Boolean(item.extension) && p.file.test(name)) || null;
}

/** Installed copies of each GeyserMC project: id -> [{ path, file, enabled }]. */
async function geyserInstalled(inst) {
  const { addons } = await list(inst);
  const out = {};
  for (const a of addons) {
    const p = geyserProjectOf(a);
    if (p) (out[p.id] ||= []).push({ path: a.path, file: a.enabled ? a.path : a.path.slice(0, -'.disabled'.length), enabled: a.enabled });
  }
  return out;
}

async function geyserInfo(inst) {
  const prof = profile(inst);
  const platform = geyserPlatform(inst, prof);
  if (!platform) throw httpError(400, 'GeyserMC does not make Geyser for this kind of server');
  const installed = await geyserInstalled(inst);
  const projects = await Promise.all(
    GEYSER_PROJECTS.map(async (p) => {
      const latest = await geyserLatest(p.id, platform).catch((err) => ({ error: err.message }));
      const have = installed[p.id]?.[0] || null;
      const sha = have ? await digest('sha256', files.resolveIn(inst.dir, have.path)).catch(() => null) : null;
      return {
        id: p.id,
        name: p.name,
        desc: p.desc,
        page: p.page,
        requires: p.requires || null,
        extension: Boolean(p.extension),
        icon: await geyserIcon(p),
        available: Boolean(latest && !latest.error),
        error: latest?.error || null,
        latest: latest && !latest.error ? { label: latest.label, name: latest.name, published: latest.published } : null,
        installed: have && { path: have.path, enabled: have.enabled, build: await geyserBuildOf(p.id, sha, latest) },
        upToDate: Boolean(have && latest?.sha256 && sha === latest.sha256),
      };
    }),
  );
  return { platform, projects };
}

/** Install or update GeyserMC projects (Geyser comes along when Floodgate or MCXboxBroadcast needs it). */
async function geyserInstall(inst, ids) {
  const prof = profile(inst);
  const platform = geyserPlatform(inst, prof);
  if (!platform) throw httpError(400, 'GeyserMC does not make Geyser for this kind of server');
  const picked = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!picked.size) throw httpError(400, 'Pick Geyser, Floodgate or MCXboxBroadcast');
  for (const id of picked) if (!GEYSER_PROJECTS.some((p) => p.id === id)) throw httpError(400, `Unknown GeyserMC project "${id}"`);
  const before = await geyserInstalled(inst);
  const wanted = new Set(picked);
  for (const id of picked) {
    const req = GEYSER_PROJECTS.find((p) => p.id === id).requires;
    if (req && !before[req]) wanted.add(req);
  }
  const ctx = newCtx();
  for (const p of GEYSER_PROJECTS) {
    if (!wanted.has(p.id)) continue;
    const latest = await geyserLatest(p.id, platform);
    if (!latest) {
      ctx.warnings.push(`${p.name} has no ${platform} build on GeyserMC${p.id === 'floodgate' ? '. For Fabric and NeoForge, install Floodgate from Modrinth.' : ''}`);
      continue;
    }
    const have = before[p.id]?.[0] || null;
    let relDir = prof.dir;
    if (p.extension) {
      // Next to the copy already there, else in Geyser's folder (made now if Geyser has not started yet).
      const dirs = await geyserDataDirs(inst, prof);
      relDir = have ? path.posix.dirname(have.path) : `${dirs[0] || GEYSER_DATA[platform]}/extensions`;
    }
    ctx.depth = picked.has(p.id) ? 0 : 1;
    const count = ctx.results.length;
    await placeFile(inst, ctx, { key: `geysermc:${p.id}`, relDir, filename: latest.name, url: latest.url, hash: { algo: 'sha256', value: latest.sha256 }, title: p.name, version: latest.label, source: 'geysermc', page: p.page });
    // Other copies (floodgate.jar next to floodgate-spigot.jar...) would load twice: remove them. Disabled stays disabled.
    const rel = `${relDir}/${safeName(latest.name)}`;
    const old = (before[p.id] || []).filter((o) => o.file !== rel);
    for (const o of old) await fsp.rm(files.resolveIn(inst.dir, o.path), { force: true }).catch(() => {});
    if (have && !have.enabled && fs.existsSync(files.resolveIn(inst.dir, rel))) {
      await fsp.rm(files.resolveIn(inst.dir, `${rel}.disabled`), { force: true });
      await fsp.rename(files.resolveIn(inst.dir, rel), files.resolveIn(inst.dir, `${rel}.disabled`));
    }
    const r = ctx.results[count];
    if (r && r.status === 'installed' && have) r.status = 'updated';
  }
  ctx.depth = 0;
  report(inst, ctx);
  return { results: ctx.results, warnings: ctx.warnings };
}

// ---------------------------------------------------------------- search

async function search(inst, source, q, version) {
  const prof = profile(inst, version);
  const manifest = await readManifest(inst.dir);
  const query = String(q || '').trim().slice(0, 100);
  if (source === 'hangar') {
    if (prof.kind !== 'plugins') throw httpError(400, 'Hangar only has Paper plugins, which this server cannot load');
    const params = new URLSearchParams({ limit: '24', platform: prof.platform });
    if (query) params.set('query', query);
    else params.set('sort', '-downloads');
    if (prof.gameVersion) params.set('version', prof.gameVersion);
    const d = await hangar(`/projects?${params}`);
    return (d.result || []).map((p) => ({
      source: 'hangar',
      title: p.name,
      author: p.namespace.owner,
      description: p.description || '',
      icon: p.avatarUrl || null,
      downloads: p.stats?.downloads ?? 0,
      url: `https://hangar.papermc.io/${p.namespace.owner}/${p.namespace.slug}`,
      installed: manifest[`hangar:${p.id}`]?.version || null,
    }));
  }
  if (source !== 'modrinth') throw httpError(400, 'Search Modrinth or Hangar');
  const facets = [];
  if (prof.kind === 'datapacks') facets.push(['project_type:datapack']);
  else {
    facets.push(prof.loaders.map((l) => `categories:${l}`));
    facets.push([`project_type:${prof.kind === 'mods' ? 'mod' : 'plugin'}`]);
    if (prof.kind === 'mods') facets.push(['server_side:required', 'server_side:optional']);
  }
  if (prof.gameVersion) facets.push([`versions:${prof.gameVersion}`]);
  const params = new URLSearchParams({ limit: '24', facets: JSON.stringify(facets), index: query ? 'relevance' : 'downloads' });
  if (query) params.set('query', query);
  const d = await modrinth(`/search?${params}`);
  return (d.hits || []).map((h) => ({
    source: 'modrinth',
    title: h.title,
    author: h.author,
    description: h.description || '',
    icon: h.icon_url || null,
    downloads: h.downloads ?? 0,
    url: `https://modrinth.com/project/${h.slug}`,
    installed: manifest[h.project_id]?.version || null,
  }));
}

// ---------------------------------------------------------------- links

function filenameFrom(res, url) {
  const cd = res.headers.get('content-disposition') || '';
  const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd);
  if (m) return decodeURIComponent(m[1] || m[2]);
  return decodeURIComponent(new URL(res.url || url).pathname.split('/').pop() || '');
}

/** Download any http(s) URL into `relDir` of the server folder. */
async function fetchUrl(inst, link, relDir) {
  const u = urlOf(link);
  if (!u) throw httpError(400, 'Enter a full link starting with https://');
  const dir = files.resolveIn(inst.dir, relDir || '');
  const res = await fetch(u, { headers: { 'User-Agent': UA }, redirect: 'follow', method: 'HEAD' }).catch(() => null);
  const raw = res?.ok ? filenameFrom(res, u.href) : decodeURIComponent(u.pathname.split('/').pop() || '');
  if (!raw || /^text\/html/i.test(res?.headers.get('content-type') || '')) {
    throw httpError(400, 'That link opens a web page, not a file. Paste a Modrinth, Hangar or GitHub project link, or a direct download link.');
  }
  const name = safeName(raw);
  await fsp.mkdir(dir, { recursive: true });
  inst.panel(`Downloading ${name} from ${u.host}...`);
  const bytes = await providers.download(u.href, path.join(dir, name));
  return { file: relDir ? `${relDir}/${name}` : name, size: bytes };
}

function report(inst, ctx) {
  for (const r of ctx.results) if (r.status !== 'already installed') inst.panel(`${r.dependency ? 'Dependency ' : ''}${r.title} ${r.version} ${r.status} (${r.file})`);
  for (const w of ctx.warnings) inst.panel(w);
}

/**
 * Install from a Modrinth, Hangar or GitHub link, or download a direct link. `version` is as in profile().
 * `replace` is the file being updated: when the new file has another name, the old one is removed (it may have
 * been added by hand, so WebbMC did not know it belonged to this project), and a disabled plugin stays disabled.
 */
async function install(inst, link, asset, version, replace) {
  const result = await installFrom(inst, link, asset, version);
  const main = result.results?.find((r) => !r.dependency);
  if (!replace || !main?.file) return result;
  const prof = profile(inst);
  const old = String(replace);
  const inFolder = [prof.dir, prof.datapackDir].filter(Boolean).some((d) => old.startsWith(`${d}/`) && !old.slice(d.length + 1).includes('/'));
  if (!inFolder || !/\.(jar|zip)(\.disabled)?$/i.test(old)) throw httpError(400, 'Only a plugin, mod or datapack file can be replaced');
  const oldBase = old.replace(/\.disabled$/, '');
  if (oldBase !== main.file) await fsp.rm(files.resolveIn(inst.dir, old), { force: true }).catch(() => {});
  if (old.endsWith('.disabled') && fs.existsSync(files.resolveIn(inst.dir, main.file))) {
    await fsp.rm(files.resolveIn(inst.dir, `${main.file}.disabled`), { force: true });
    await fsp.rename(files.resolveIn(inst.dir, main.file), files.resolveIn(inst.dir, `${main.file}.disabled`));
  }
  return result;
}

async function installFrom(inst, link, asset, version) {
  const prof = profile(inst, version);
  const raw = String(link || '').trim();
  const ctx = newCtx();
  const mr = parseModrinth(raw);
  const hg = !mr && parseHangar(raw);
  const gh = !mr && !hg && parseGithub(raw);
  if (mr) {
    await installModrinth(inst, prof, mr.slug, mr.version, ctx);
    if (!prof.gameVersion && !prof.anyVersion && !mr.version) {
      ctx.warnings.push('WebbMC could not tell which Minecraft version this server runs, so it picked the newest build. Start the server once and reinstall if it does not load.');
    }
  } else if (hg) {
    await installHangar(inst, prof, hg.slug, hg.version, ctx);
  } else if (gh) {
    const choose = await installGithub(inst, prof, gh, asset ? String(asset) : null, ctx);
    if (choose) return { results: [], warnings: [], choose };
  } else {
    if (prof.kind === 'datapacks') throw httpError(400, 'Vanilla servers cannot load plugin jars. Use a Modrinth datapack link instead.');
    const r = await fetchUrl(inst, raw, prof.dir);
    const isJar = /\.jar$/i.test(r.file);
    return {
      results: [{ title: path.basename(r.file), file: r.file, status: isJar ? 'installed' : 'downloaded' }],
      warnings: isJar ? [] : ['That file is not a .jar, so the server will probably ignore it.'],
    };
  }
  report(inst, ctx);
  return { results: ctx.results, warnings: ctx.warnings };
}

/** Installed jars (and .jar.disabled) in the plugins/mods folder, plus datapacks. */
async function list(inst) {
  const prof = profile(inst);
  const manifest = await readManifest(inst.dir);
  const byFile = Object.fromEntries(Object.values(manifest).map((m) => [m.file, m]));
  const read = async (relDir, match) => {
    let entries = [];
    try {
      entries = await files.list(inst.dir, relDir);
    } catch {
      return [];
    }
    return entries
      .filter((e) => !e.dir && match(e.name))
      .map((e) => {
        const enabled = !e.name.endsWith('.disabled');
        const file = `${relDir}/${enabled ? e.name : e.name.slice(0, -'.disabled'.length)}`;
        const m = byFile[file];
        return {
          name: e.name,
          path: `${relDir}/${e.name}`,
          size: e.size,
          mtime: e.mtime,
          enabled,
          title: m?.title || '',
          version: m?.version || '',
          source: m?.source || (m ? 'modrinth' : ''),
          page: m?.page || (m?.slug ? `https://modrinth.com/project/${m.slug}` : ''),
        };
      });
  };
  const isJar = (n) => /\.jar(\.disabled)?$/i.test(n);
  const addons = prof.kind === 'datapacks' ? [] : await read(prof.dir, isJar);
  // Geyser extensions (MCXboxBroadcast...) live in Geyser's own folder: list them with the plugins.
  if (prof.kind !== 'datapacks') for (const d of await geyserDataDirs(inst, prof)) addons.push(...(await read(`${d}/extensions`, isJar)).map((a) => ({ ...a, extension: true })));
  const datapacks = prof.datapackDir ? await read(prof.datapackDir, (n) => /\.zip(\.disabled)?$/i.test(n)) : [];
  return { ...prof, addons, datapacks };
}

// ---------------------------------------------------------------- update check

async function modrinthPost(p, body) {
  let res;
  try {
    res = await fetch(`${MODRINTH}${p}`, {
      method: 'POST',
      headers: { 'User-Agent': UA, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw httpError(502, 'Could not reach Modrinth');
  }
  if (!res.ok) throw httpError(502, `Modrinth responded with HTTP ${res.status}`);
  return res.json();
}

/** Run `fn` over `items`, at most `limit` at a time. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** The newest Modrinth version for these loaders and Minecraft version, releases first (as installing picks). */
async function modrinthBest(projectId, loaders, gameVersion) {
  const q = new URLSearchParams({ loaders: JSON.stringify(loaders) });
  if (gameVersion) q.set('game_versions', JSON.stringify([gameVersion]));
  return bestOf(await modrinth(`/project/${enc(projectId)}/version?${q}`), loaders);
}

async function hangarLatest(idOrSlug, prof) {
  const project = await hangar(`/projects/${enc(idOrSlug)}`);
  const find = async (params) =>
    (await hangar(`/projects/${enc(project.namespace.slug)}/versions?${new URLSearchParams({ limit: '1', platform: prof.platform, ...params })}`)).result?.[0];
  const gv = prof.gameVersion ? { platformVersion: prof.gameVersion } : {};
  return { project, version: (await find({ ...gv, channel: 'Release' })) || (await find(gv)) };
}

const TYPE_LABEL = {
  paper: 'Paper',
  purpur: 'Purpur',
  folia: 'Folia',
  spigot: 'Spigot',
  bukkit: 'Bukkit',
  fabric: 'Fabric',
  quilt: 'Quilt',
  forge: 'Forge',
  neoforge: 'NeoForge',
  velocity: 'Velocity',
  bungeecord: 'BungeeCord',
  waterfall: 'Waterfall',
  geyser: 'Geyser extension',
  datapack: 'Datapack',
};

// The descriptor each kind of server looks for inside a jar.
const JAR_TYPES = [
  ['paper-plugin.yml', 'paper'],
  ['plugin.yml', 'bukkit'],
  ['velocity-plugin.json', 'velocity'],
  ['bungee.yml', 'bungeecord'],
  ['fabric.mod.json', 'fabric'],
  ['quilt.mod.json', 'quilt'],
  ['META-INF/neoforge.mods.toml', 'neoforge'],
  ['META-INF/mods.toml', 'forge'],
  ['extension.yml', 'geyser'],
];

/** Which server types a jar says it is for, from the descriptors inside it. */
async function jarTypes(file) {
  const names = new Set(await zip.entryNames(file).catch(() => []));
  return JAR_TYPES.filter(([name]) => names.has(name)).map(([, type]) => type);
}

/** The type to show for a file: the one this server prefers among `types`, or the first when none fits. */
function builtFor(types, loaders) {
  if (!types?.length) return {};
  const rank = loaderRank({ loaders: types }, loaders);
  const main = rank === Infinity ? types[0] : loaders[rank];
  return { builtFor: TYPE_LABEL[main] || main, types: types.map((t) => TYPE_LABEL[t] || t), fits: rank !== Infinity };
}

// Answers per file (path, size and modified time), so after one update only that file is looked up again.
const updateCache = new Map();
const UPDATE_TTL = 15 * 60 * 1000;

/**
 * For every installed plugin, mod and datapack: is a newer build available for this server? Files WebbMC installed
 * are checked where they came from (Modrinth, Hangar, GitHub, EssentialsX). Files added by hand are looked up on
 * Modrinth by their checksum, so most of them are recognised too.
 */
async function checkUpdates(inst, version, force) {
  const prof = profile(inst, version);
  const LOADER = TYPE_LABEL;
  const base0 = prof.kind === 'datapacks' ? 'Vanilla' : LOADER[prof.loaders[0]] || prof.loaders[0];
  const target = `${base0}${prof.gameVersion && !prof.proxy ? ` ${prof.gameVersion}` : ''}`;
  const { addons, datapacks } = await list(inst);
  const manifest = await readManifest(inst.dir);
  const byFile = Object.fromEntries(Object.entries(manifest).map(([key, m]) => [m.file, { key, ...m }]));
  const items = [...addons.map((a) => ({ ...a, datapack: false })), ...datapacks.map((d) => ({ ...d, datapack: true }))].map((a) => ({
    ...a,
    file: a.enabled ? a.path : a.path.slice(0, -'.disabled'.length),
    cacheKey: `${inst.id}|${prof.gameVersion}|${prof.loaders.join(',')}|${a.path}|${a.size}|${a.mtime}`,
  }));

  const fresh = (i) => {
    const hit = updateCache.get(i.cacheKey);
    return !force && hit && Date.now() - hit.t < UPDATE_TTL ? hit.result : null;
  };
  const todo = items.filter((i) => !fresh(i));
  const base = (i) => ({
    path: i.path,
    name: i.name,
    size: i.size,
    mtime: i.mtime,
    enabled: i.enabled,
    datapack: i.datapack,
    title: i.title || i.name.replace(/\.(jar|zip)(\.disabled)?$/i, ''),
    version: i.version || '',
    source: i.source || null,
    page: i.page || '',
    icon: null,
    latest: '',
    released: null, // when the newest build (`latest`) came out
    status: 'unknown',
    action: null,
    error: null,
  });
  const results = new Map();

  // 1. Checksums, and which of the files Modrinth knows (also files added by hand).
  const sha1 = new Map();
  await mapLimit(todo, 8, async (i) => sha1.set(i, await digest('sha1', files.resolveIn(inst.dir, i.path)).catch(() => null)));
  const hashes = [...new Set([...sha1.values()].filter(Boolean))];
  let known = {};
  if (hashes.length) known = await modrinthPost('/version_files', { hashes, algorithm: 'sha1' }).catch(() => ({}));

  // 2. Modrinth: one request per group for the newest compatible build of every recognised file.
  const fromModrinth = todo.filter((i) => {
    const m = byFile[i.file];
    return known[sha1.get(i)] && !ESSX_FILE.test(i.name) && !geyserProjectOf(i) && (!m || m.source === 'modrinth' || !m.source);
  });
  const latestByHash = {};
  for (const datapack of [false, true]) {
    const group = fromModrinth.filter((i) => i.datapack === datapack).map((i) => sha1.get(i));
    if (!group.length) continue;
    const body = { hashes: group, algorithm: 'sha1', loaders: datapack ? ['datapack'] : prof.loaders };
    if (prof.gameVersion) body.game_versions = [prof.gameVersion];
    Object.assign(latestByHash, await modrinthPost('/version_files/update', body).catch(() => ({})));
  }
  const projectIds = [...new Set(fromModrinth.map((i) => known[sha1.get(i)].project_id))];
  const projects = {};
  if (projectIds.length) {
    for (const p of await modrinth(`/projects?ids=${enc(JSON.stringify(projectIds))}`).catch(() => [])) projects[p.id] = p;
  }
  await mapLimit(fromModrinth, 6, async (i) => {
    const r = base(i);
    const current = known[sha1.get(i)];
    const project = projects[current.project_id];
    Object.assign(r, {
      source: 'modrinth',
      title: project?.title || r.title,
      icon: project?.icon_url || null,
      page: project ? `https://modrinth.com/project/${project.slug}` : r.page,
      version: current.version_number,
    });
    try {
      let best = latestByHash[sha1.get(i)] || null;
      // The bulk answer may be a beta or another loader's build (Spigot on Paper); installing prefers releases and
      // this server's own loader, so check the same way.
      const loaders = i.datapack ? ['datapack'] : prof.loaders;
      if (best && (best.version_type !== 'release' || !best.loaders.includes(loaders[0]))) best = (await modrinthBest(current.project_id, loaders, prof.gameVersion)) || best;
      // Some projects upload one jar as several versions, one per loader (ViaVersion: a Fabric and a Paper entry for
      // the same file), and the checksum lookup may name any of them. A build holding this very file is this file.
      const other = best && best.id !== current.id && !best.files.some((f) => f.hashes?.sha1 === sha1.get(i));
      // Newer, or the same release built for a better loader (a Spigot jar on Paper when a Paper build exists).
      const later = other && Date.parse(best.date_published) > Date.parse(current.date_published);
      const better = other && loaderRank(best, loaders) < loaderRank(current, loaders);
      const newer = later || better;
      Object.assign(r, { status: newer ? 'update' : 'latest', latest: newer ? best.version_number : current.version_number });
      r.released = Date.parse((newer ? best : current).date_published) || null;
      // Not a newer release, only this server's own build of it: offered as a switch (Spigot to Paper).
      if (better && !later) r.switchTo = LOADER[loaders[loaderRank(best, loaders)]] || loaders[loaderRank(best, loaders)];
      // What this file is built for. When the lookup named another loader's upload of the same jar, look for this
      // server's own upload of it among the project's builds.
      let types = (best && !other ? best : current).loaders;
      if (loaderRank({ loaders: types }, loaders) === Infinity) {
        const q = new URLSearchParams({ loaders: JSON.stringify(loaders) });
        const list = await modrinth(`/project/${current.project_id}/version?${q}`).catch(() => []);
        const twin = list.find((v) => v.files.some((f) => f.hashes?.sha1 === sha1.get(i)));
        if (twin) types = [...new Set([...twin.loaders, ...types])];
      }
      r.types = types;
      if (!best) r.note = `No build for ${target} on Modrinth`;
      if (newer) r.action = { url: r.page };
    } catch (err) {
      Object.assign(r, { status: 'error', error: err.message });
    }
    results.set(i, r);
  });

  // 3. Everything else: EssentialsX, Hangar, GitHub, or unknown.
  await mapLimit(
    todo.filter((i) => !results.has(i)),
    4,
    async (i) => {
      const r = base(i);
      const m = byFile[i.file];
      const essx = ESSX_FILE.exec(i.name);
      const gp = !i.datapack && geyserProjectOf(i);
      try {
        if (gp) {
          // GeyserMC: compare the file's SHA-256 with the official newest build for this platform.
          const latest = await geyserLatest(gp.id, geyserPlatform(inst, prof));
          const sha = await digest('sha256', files.resolveIn(inst.dir, i.path));
          Object.assign(r, { source: 'geysermc', title: gp.name, page: gp.page, icon: await geyserIcon(gp), version: (await geyserBuildOf(gp.id, sha, latest)) || r.version || 'unknown build' });
          if (!latest) {
            r.note = `GeyserMC has no ${gp.name} build for this kind of server`;
          } else if (latest.sha256 && sha === latest.sha256) {
            Object.assign(r, { status: 'latest', latest: latest.label });
          } else {
            Object.assign(r, { status: 'update', latest: latest.label, action: { geysermc: gp.id } });
          }
          if (latest) r.released = latest.published;
        } else if (essx && !i.datapack) {
          const module = ESSX_MODULES.find((x) => x.id === essx[1]);
          const channel = /dev|snapshot/i.test(essx[2]) ? 'dev' : 'stable';
          const build = await essentialsBuild(channel);
          const latest = build.files[essx[1]]?.version;
          r.released = build.published;
          Object.assign(r, { source: 'essentialsx', title: module?.name || r.title, version: essx[2], page: 'https://essentialsx.net/downloads', latest: latest || essx[2] });
          r.status = !latest ? 'latest' : latest !== essx[2] ? 'update' : 'latest';
          if (r.status === 'update') r.action = { essentialsx: essx[1], channel };
          if (channel === 'dev') r.note = 'Dev build';
        } else if (m?.source === 'hangar' && m.key.startsWith('hangar:')) {
          const { project, version: v } = await hangarLatest(m.key.slice(7), prof);
          Object.assign(r, { source: 'hangar', title: project.name, icon: project.avatarUrl || null, page: m.page, latest: v?.name || m.version, released: Date.parse(v?.createdAt) || null });
          r.status = v && v.name !== m.version ? 'update' : 'latest';
          if (!v) r.note = `No build for ${target} on Hangar`;
          if (r.status === 'update') r.action = { url: m.page };
        } else if (m?.source === 'github' && m.key.startsWith('github:')) {
          const [owner, repo] = m.key.slice(7).split('/');
          const rel = await githubLatest({ owner, repo, tag: null });
          Object.assign(r, { source: 'github', page: m.page, latest: rel.tag_name, released: Date.parse(rel.published_at) || null });
          r.status = rel.tag_name !== m.version ? 'update' : 'latest';
          if (r.status === 'update') r.action = { url: m.page };
        } else {
          r.note = 'Not found on Modrinth, and not installed by WebbMC, so there is nothing to compare it with';
        }
      } catch (err) {
        Object.assign(r, { status: 'error', error: err.message });
      }
      // What it is built for: GeyserMC names its builds by platform, EssentialsX is one build for Paper and
      // Spigot, Hangar files were fetched for this server's platform; anything else says so inside the jar.
      const named = /-(spigot|paper|velocity|bungeecord|fabric|neoforge)\b/i.exec(i.name)?.[1].toLowerCase();
      if (i.datapack) r.types = ['datapack'];
      else if (gp) r.types = gp.extension ? ['geyser'] : named ? [named] : await jarTypes(files.resolveIn(inst.dir, i.path));
      else if (essx) r.types = ['paper', 'spigot'];
      else if (r.source === 'hangar') r.types = [prof.platform.toLowerCase()];
      else r.types = await jarTypes(files.resolveIn(inst.dir, i.path));
      results.set(i, r);
    },
  );

  for (const [i, r] of results) Object.assign(r, builtFor(r.types, i.datapack ? ['datapack'] : prof.loaders));
  for (const [i, r] of results) if (r.status !== 'error') updateCache.set(i.cacheKey, { t: Date.now(), result: r });
  const out = items.map((i) => fresh(i) || results.get(i));
  // Keep the per-file answers current (enabled state can change without a new check).
  for (const [n, i] of items.entries()) Object.assign(out[n], { path: i.path, name: i.name, enabled: i.enabled });
  return { target, checkedAt: Date.now(), items: out };
}

/** Enable/disable by renaming foo.jar <-> foo.jar.disabled. */
async function toggle(inst, relPath) {
  const p = String(relPath || '');
  if (!/\.(jar|zip)(\.disabled)?$/i.test(p)) throw httpError(400, 'Only .jar and datapack .zip files can be toggled');
  const to = p.endsWith('.disabled') ? p.slice(0, -'.disabled'.length) : `${p}.disabled`;
  await files.rename(inst.dir, p, to);
  return { path: to };
}

module.exports = { install, list, toggle, fetchUrl, profile, search, githubRelease, essentialsInfo, essentialsInstall, geyserInfo, geyserInstall, checkUpdates };
