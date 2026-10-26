'use strict';
// Modpacks uploaded as a zip. A CurseForge server pack holds the server's own files (mods, configs, and often the
// loader's installer, a start script or variables.txt). A CurseForge export (manifest.json and an overrides folder)
// only lists its mods: those are downloaded from CurseForge, which needs a CURSEFORGE_API_KEY.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const zip = require('./zip');
const files = require('./files');
const properties = require('./properties');
const providers = require('./providers');
const software = require('./software');
const modloader = require('./modloader');

const UPLOAD = '.webbmc-modpack.zip';
const CURSEFORGE = 'https://api.curseforge.com/v1';
// CurseForge project classes that are not mods. Data packs go into the world; the rest only matter to players.
const CLASS_MOD = 6;
const CLASS_DATAPACK = 6945;
const CLASS_NAMES = { 12: 'resource pack', 17: 'world', 4546: 'customization', 6552: 'shader pack' };

const readText = (dir, file) => {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8');
  } catch {
    return null;
  }
};
const readJson = (dir, file) => {
  try {
    return JSON.parse(readText(dir, file));
  } catch {
    return null;
  }
};

/** Save the uploaded zip in the server folder. */
async function receive(inst, req) {
  inst.assertIdle('install a modpack');
  inst.setBusy('Uploading modpack');
  try {
    await files.upload(inst.dir, UPLOAD, req);
    return path.join(inst.dir, UPLOAD);
  } finally {
    inst.setBusy(null);
  }
}

/** The folder the pack's files are in: zips often wrap everything in one folder named after the pack. */
async function packRoot(dir) {
  for (;;) {
    const names = (await fsp.readdir(dir)).filter((n) => n !== '__MACOSX');
    if (names.length !== 1 || ['mods', 'config', 'overrides', 'libraries'].includes(names[0].toLowerCase())) return dir;
    const only = path.join(dir, names[0]);
    if (!(await fsp.stat(only)).isDirectory()) return dir;
    dir = only;
  }
}

/** Move everything in `src` into `dest`, merging folders and replacing files that are already there. */
async function moveInto(src, dest) {
  await fsp.mkdir(dest, { recursive: true });
  for (const e of await fsp.readdir(src, { withFileTypes: true })) {
    if (e.name === '__MACOSX') continue;
    const from = path.join(src, e.name);
    const to = path.join(dest, e.name);
    const there = await fsp.stat(to).catch(() => null);
    if (there && there.isDirectory() && e.isDirectory()) await moveInto(from, to);
    else {
      if (there) await fsp.rm(to, { recursive: true, force: true });
      await fsp.rename(from, to);
    }
  }
}

/**
 * Which loader and Minecraft version the pack is for, and how it can be started: { type, mc, loader, installer,
 * argsFile, jar }. Read from manifest.json, variables.txt (ServerPackCreator, All the Mods), server-setup-config.yaml
 * (ServerStarter), an installer in the folder, an installed Forge/NeoForge, or the loader's jar.
 */
function detect(dir, manifest) {
  const out = { type: null, mc: null, loader: null, installer: null, argsFile: null, jar: null };
  const learn = (type, mc, loader) => {
    type = String(type || '').toLowerCase();
    if (out.type && type && type !== out.type) return; // another source names another loader: trust the first
    if (software.MOD_LOADERS.includes(type)) out.type ||= type;
    if (/^\d+\.\d+/.test(mc || '')) out.mc ||= mc;
    if (loader && (type === out.type || !type)) {
      // Some name the loader with its Minecraft version in front (1.20.1-47.1.106): WebbMC wants just 47.1.106.
      const v = String(loader);
      out.loader ||= out.mc && v.startsWith(`${out.mc}-`) ? v.slice(out.mc.length + 1) : v;
    }
  };

  if (manifest?.minecraft) {
    const loaders = manifest.minecraft.modLoaders || [];
    const m = /^(forge|neoforge|fabric|quilt)-(.+)$/i.exec((loaders.find((l) => l.primary) || loaders[0])?.id || '');
    learn(m?.[1], manifest.minecraft.version, m?.[2]);
  }
  const vars = readText(dir, 'variables.txt');
  if (vars) {
    const get = (k) => new RegExp(`^\\s*${k}\\s*=\\s*["']?([^"'\\r\\n]*)`, 'm').exec(vars)?.[1].trim();
    learn(get('MODLOADER'), get('MINECRAFT_VERSION'), get('MODLOADER_VERSION'));
  }
  const yaml = readText(dir, 'server-setup-config.yaml');
  const yamlMc = yaml && /^\s*mcVersion:\s*["']?([\d.]+)/m.exec(yaml)?.[1];
  if (yamlMc) learn(/neoforge/i.test(yaml) ? 'neoforge' : /fabric/i.test(yaml) ? 'fabric' : 'forge', yamlMc, /^\s*loaderVersion:\s*["']?([\w.-]+)/m.exec(yaml)?.[1]);

  const names = fs.readdirSync(dir);
  for (const f of names) {
    let m;
    if ((m = /^forge-(\d+\.\d+(?:\.\d+)?)-([\w.]+?)(?:-\d+\.\d+(?:\.\d+)?)?-installer\.jar$/i.exec(f))) {
      learn('forge', m[1], m[2]);
      if (out.type === 'forge' && out.loader === m[2]) out.installer = f;
    } else if ((m = /^neoforge-([\w.-]+)-installer\.jar$/i.exec(f))) {
      learn('neoforge', providers.neoforgeMc(m[1]), m[1]);
      if (out.type === 'neoforge' && out.loader === m[1]) out.installer = f;
    }
  }

  // Already installed (the pack shipped its libraries folder).
  const want = out.loader && (out.type === 'neoforge' && out.mc !== '1.20.1' ? out.loader : `${out.mc}-${out.loader}`);
  out.argsFile = software.findArgsFile(dir, want) || (!out.loader ? software.findArgsFile(dir) : null);
  const info = software.argsFileInfo(out.argsFile);
  if (info) learn(info.type, info.mc, info.loader);

  for (const f of names) {
    let m;
    if ((m = /^forge-(\d+\.\d+(?:\.\d+)?)-(.+?)(?:-universal)?\.jar$/i.exec(f)) && !/installer/i.test(f)) {
      learn('forge', m[1], m[2]);
      out.jar ||= f;
    } else if (/^fabric-server-mc\..+\.jar$/i.test(f) || /^fabric-server-launch\.jar$/i.test(f)) {
      learn('fabric');
      out.jar = /^fabric-server-mc/i.test(f) ? f : out.jar || f;
    } else if (/^quilt-server-launch\.jar$/i.test(f)) {
      learn('quilt');
      out.jar ||= f;
    }
  }
  return out;
}

/** Keep the port the server was created with: a pack's own server.properties would otherwise move it. */
function keepPort(dir, port) {
  if (!port) return;
  const file = path.join(dir, 'server.properties');
  const text = readText(dir, 'server.properties');
  if (text != null && properties.parse(text)['server-port'] !== String(port)) fs.writeFileSync(file, properties.stringify({ 'server-port': port }, text));
}

async function curseforge(pathname, body) {
  let res;
  try {
    res = await fetch(`${CURSEFORGE}${pathname}`, {
      method: 'POST',
      headers: { 'x-api-key': process.env.CURSEFORGE_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error('could not reach CurseForge');
  }
  if (res.status === 401 || res.status === 403) throw new Error('CurseForge refused the API key in CURSEFORGE_API_KEY. Check it at console.curseforge.com.');
  if (!res.ok) throw new Error(`CurseForge responded with HTTP ${res.status}`);
  return (await res.json()).data || [];
}

/** Download the mods a CurseForge export lists into mods/ (data packs into the world). */
async function curseforgeMods(inst, manifest) {
  const wanted = (manifest.files || []).filter((f) => f.required !== false && f.fileID);
  if (!wanted.length) return;
  if (!process.env.CURSEFORGE_API_KEY) {
    throw new Error(
      `this is a CurseForge export: its ${wanted.length} mods are not in the zip, and downloading them needs a CurseForge API key. ` +
        'Get one free at console.curseforge.com and set CURSEFORGE_API_KEY in Panel settings > Environment, or upload the ' +
        "pack's server pack instead (the Server Packs download on the pack's Files page on CurseForge).",
    );
  }
  inst.panel(`Looking up ${wanted.length} mods on CurseForge...`);
  const found = [];
  for (let i = 0; i < wanted.length; i += 500) found.push(...(await curseforge('/mods/files', { fileIds: wanted.slice(i, i + 500).map((f) => f.fileID) })));
  const projects = new Map();
  const modIds = [...new Set(found.map((f) => f.modId))];
  for (let i = 0; i < modIds.length; i += 500) for (const p of await curseforge('/mods', { modIds: modIds.slice(i, i + 500) })) projects.set(p.id, p);

  const levelName = software.readProps(inst.cfg)['level-name'] || 'world';
  const todo = [];
  const skipped = [];
  const blocked = [];
  for (const f of found) {
    const p = projects.get(f.modId);
    const name = p?.name || f.displayName || f.fileName;
    const cls = p?.classId || CLASS_MOD;
    if (cls !== CLASS_MOD && cls !== CLASS_DATAPACK) {
      skipped.push(`${name} (${CLASS_NAMES[cls] || 'not a mod'})`);
      continue;
    }
    const gv = f.gameVersions || [];
    if (gv.includes('Client') && !gv.includes('Server')) {
      skipped.push(`${name} (client only)`);
      continue;
    }
    // Authors can turn off downloads outside the CurseForge website and app. Those have to be fetched by hand.
    if (!f.downloadUrl) {
      blocked.push(`${name}: ${p?.links?.websiteUrl ? `${p.links.websiteUrl}/files/${f.id}` : f.fileName}`);
      continue;
    }
    todo.push({ url: f.downloadUrl, dest: files.resolveIn(inst.dir, `${cls === CLASS_DATAPACK ? `${levelName}/datapacks` : 'mods'}/${path.basename(f.fileName)}`) });
  }
  const missing = wanted.length - found.length;
  if (missing > 0) inst.panel(`CurseForge no longer has ${missing} of the pack's files. The server may still start without them.`);

  const total = todo.length;
  let done = 0;
  inst.panel(`Downloading ${total} mods...`);
  const worker = async () => {
    for (let job; (job = todo.shift()); ) {
      await fsp.mkdir(path.dirname(job.dest), { recursive: true });
      await providers.download(job.url, job.dest);
      if (++done % 10 === 0 || done === total) inst.panel(`Downloaded ${done} of ${total} mods`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  if (skipped.length) inst.panel(`Skipped ${skipped.length} that servers do not use: ${skipped.join(', ')}`);
  if (blocked.length) {
    inst.panel(`${blocked.length} mod${blocked.length === 1 ? '' : 's'} can only be downloaded from the CurseForge website, as the authors chose. Download each file and upload it into the mods folder in the Files tab before starting:`);
    for (const b of blocked) inst.panel(`  ${b}`);
  }
}

/** Unpack an uploaded modpack zip into the server's folder and install the mod loader it needs. */
async function install(inst, file, uploadName = '') {
  inst.assertIdle('install a modpack');
  inst.setBusy('Installing modpack');
  const work = path.join(inst.dir, `.webbmc-pack-${crypto.randomBytes(3).toString('hex')}`);
  const fallbackName = path.basename(String(uploadName), path.extname(String(uploadName))).slice(0, 80) || 'Modpack';
  try {
    inst.panel(`Unpacking ${uploadName || 'the modpack'}...`);
    await zip.extractZip(file, work).catch((err) => {
      throw new Error(`could not unpack it (${err.message}). Upload the modpack as a .zip file.`);
    });
    await fsp.rm(file, { force: true });
    const root = await packRoot(work);
    const manifest = readJson(root, 'manifest.json');
    const isExport = Boolean(manifest?.minecraft && Array.isArray(manifest.files) && fs.existsSync(path.join(root, manifest.overrides || 'overrides')));
    const port = software.readProps(inst.cfg)['server-port'];
    await moveInto(isExport ? path.join(root, manifest.overrides || 'overrides') : root, inst.dir);
    keepPort(inst.dir, port);

    const pack = detect(inst.dir, manifest);
    const label = pack.type ? providers.label(pack.type) : 'the mod loader';
    inst.panel(`This pack is for ${pack.type ? providers.label(pack.type) : 'an unknown loader'}${pack.loader ? ` ${pack.loader}` : ''}${pack.mc ? `, Minecraft ${pack.mc}` : ''}.`);
    const modsThere = () => (fs.existsSync(path.join(inst.dir, 'mods')) ? fs.readdirSync(path.join(inst.dir, 'mods')).some((f) => /\.jar$/i.test(f)) : false);
    if (manifest?.files?.length && (isExport || !modsThere())) await curseforgeMods(inst, manifest);

    let launch;
    if (pack.argsFile) launch = { argsFile: pack.argsFile, jar: inst.cfg.jar, loaderVersion: pack.loader };
    else if (pack.mc && ((providers.usesInstaller(pack.type) && pack.loader) || (pack.type === 'fabric' && !/^fabric-server-mc/i.test(pack.jar || ''))))
      launch = await modloader.install(inst, { type: pack.type, mc: pack.mc, loader: pack.loader, installer: pack.installer });
    else if (pack.jar) launch = { jar: pack.jar, argsFile: null, loaderVersion: pack.loader };
    else
      throw new Error(
        `WebbMC cannot tell how to start this pack (which ${label} version${pack.mc ? '' : ' and Minecraft version'} it needs). ` +
          "Use the pack's server pack, or install the loader yourself: its files are in place, so pick Forge, NeoForge or Fabric in Settings > Software.",
      );

    const c = inst.cfg;
    Object.assign(c, {
      type: 'modpack',
      version: pack.mc || '',
      jar: launch.jar,
      build: null,
      loader: pack.type ? { type: pack.type, version: launch.loaderVersion || pack.loader || null } : null,
      packName: String(manifest?.name || fallbackName).slice(0, 80),
      packVersion: manifest?.version ? String(manifest.version).slice(0, 40) : null,
    });
    if (launch.argsFile) c.argsFile = launch.argsFile;
    else delete c.argsFile;
    delete c.javaMin;
    delete c.loaderVersion;
    store.save();
    const what = `${c.packName}${c.packVersion ? ` ${c.packVersion}` : ''}`;
    inst.panel(`Installed ${what}. It starts with ${launch.argsFile ? `@${launch.argsFile}` : launch.jar}.`);
    store.logActivity(inst.id, `Installed modpack ${what}`);
    await inst.java();
    inst.panel('Ready to start. Modpacks often need 6 GB of RAM or more: raise Maximum RAM in Settings if it runs out.');
  } catch (err) {
    inst.panel(`Modpack install failed: ${err.message}`);
    store.logActivity(inst.id, `Modpack install failed: ${err.message}`, 'error');
    throw err;
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    await fsp.rm(file, { force: true }).catch(() => {});
    inst.setBusy(null);
  }
}

module.exports = { receive, install, detect };
