'use strict';
// Mod loaders for a server folder. Forge and NeoForge come as an installer that sets the server up (Minecraft's own
// server jar, the libraries) and leaves either a jar to run (Forge up to 1.16) or an argument file for java (1.17 on:
// java @libraries/.../unix_args.txt). Fabric is one jar to download.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');
const providers = require('./providers');
const software = require('./software');
const java = require('./java');

/** Run a Forge or NeoForge installer in the server folder, its output going to the console. */
async function runInstaller(inst, file, mc) {
  const label = inst.busy;
  const bin = inst.cfg.javaPath || (await java.forMinecraft(mc, { log: (m) => inst.panel(m), busy: (b) => inst.setBusy(b || label) }));
  await new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-jar', file, '--installServer'], { cwd: inst.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    readline.createInterface({ input: proc.stdout, crlfDelay: Infinity }).on('line', (l) => inst.push(l, 'out'));
    readline.createInterface({ input: proc.stderr, crlfDelay: Infinity }).on('line', (l) => inst.push(l, 'err'));
    proc.on('error', (err) => reject(new Error(`could not run Java (${err.code || err.message})`)));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`the installer stopped with exit code ${code}. Its output is above.`))));
  });
}

/**
 * What the installer left to start, looked for in this order: the run.sh/run.bat it just wrote (newer than
 * `since`), the argument file folder named `want`, and a forge-*.jar or neoforge-*.jar (old Forge, Forge's shim jar).
 */
function launchAfterInstall(dir, want, since) {
  for (const script of ['run.sh', 'run.bat']) {
    const file = path.join(dir, script);
    let text;
    try {
      if (fs.statSync(file).mtimeMs < since - 2000) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const args = /@(libraries\/\S+?)\/(?:unix|win)_args\.txt/.exec(text.replace(/\\/g, '/'));
    if (args) return { argsFile: args[1] };
    const jar = /-jar\s+"?([^\s"]+\.jar)/.exec(text);
    if (jar && fs.existsSync(path.join(dir, jar[1]))) return { jar: jar[1] };
  }
  const argsFile = software.findArgsFile(dir, want);
  if (argsFile) return { argsFile };
  const jars = fs
    .readdirSync(dir)
    .filter((f) => /^(neo)?forge-.+\.jar$/i.test(f) && !/installer/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return jars.length ? { jar: jars[0].f } : null;
}

/**
 * Install a mod loader into a server's folder. `loader` pins its version (newest/recommended otherwise), and
 * `installer` is an installer jar already in the folder (a server pack may bring one). Returns what to save in the
 * server's settings: { loaderVersion, jar, argsFile } (argsFile null when it starts with -jar).
 */
async function install(inst, { type, mc, loader, installer }) {
  const label = providers.label(type);
  if (type === 'fabric') {
    const url = await providers.resolveUrl('fabric', mc, loader);
    const jar = /\.jar$/i.test(inst.cfg.jar || '') ? inst.cfg.jar : 'server.jar';
    inst.panel(`Downloading ${url}`);
    await providers.download(url, path.join(inst.dir, jar), (got, total) =>
      inst.panel(total ? `Downloading... ${Math.round((got / total) * 100)}%` : `Downloading... ${(got / 1048576).toFixed(1)} MB`),
    );
    return { loaderVersion: loader || null, jar, argsFile: null };
  }
  if (!providers.usesInstaller(type)) throw new Error(`${label} servers cannot be installed by WebbMC. Upload the server jar instead.`);

  loader ||= await providers.loaderFor(type, mc);
  let file = installer && path.resolve(inst.dir, installer);
  const downloaded = !file;
  if (downloaded) {
    const url = await providers.resolveUrl(type, mc, loader);
    file = path.join(inst.dir, `.webbmc-${type}-installer.jar`);
    inst.panel(`Downloading the ${label} ${loader} installer: ${url}`);
    await providers.download(url, file).catch((err) => {
      throw new Error(`could not download the ${label} ${loader} installer for Minecraft ${mc} (${err.message})`);
    });
  }
  const started = Date.now();
  inst.panel(`Running the ${label} ${loader} installer. It downloads Minecraft and the libraries ${label} needs, which can take a few minutes...`);
  try {
    await runInstaller(inst, file, mc);
  } finally {
    if (downloaded) await fsp.rm(file, { force: true });
  }
  // The installer's log is only useful when it fails, and its output is in the console already.
  await fsp.rm(`${file}.log`, { force: true });
  const want = type === 'forge' || mc === '1.20.1' ? `${mc}-${loader}` : loader;
  const found = launchAfterInstall(inst.dir, want, started);
  if (!found) throw new Error(`the ${label} installer finished, but WebbMC cannot find what it should start. Look in the Files tab for a run script or jar, and set the jar in Settings.`);
  return { loaderVersion: loader, jar: found.jar || inst.cfg.jar || 'server.jar', argsFile: found.argsFile || null };
}

module.exports = { install };
