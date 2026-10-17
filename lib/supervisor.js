'use strict';
// Restarting after an update. In a git checkout, `node server.js` runs the panel as a child process and starts it
// again whenever it exits with RESTART_CODE (after `git pull`). The terminal stays attached: Ctrl+C reaches the panel
// as before, and the supervisor exits with it. Docker images (no .git folder) run the panel directly.
// Under pm2 (which sets pm_id) pm2 is the supervisor: it restarts the panel whenever it exits, and its stop signal must
// reach the panel itself. Set WEBMC_NO_SUPERVISOR=1 to run without one (the Update button then stops the panel).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const RESTART_CODE = 75;
const CHILD_ENV = 'WEBMC_SUPERVISED';

/** The folder holding .git (a folder, or a file for worktrees), searching upward from `dir`, or null. */
function gitDir(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

const supervised = () => process.env[CHILD_ENV] === '1';
const underPm2 = () => process.env.pm_id !== undefined;
/** True when something starts the panel again after it exits (this supervisor or pm2), so updates can restart it. */
const restartsOnExit = () => supervised() || underPm2();

/** Call first thing in server.js. Returns true when this process became the supervisor (and must not run the panel). */
function run(root) {
  if (supervised() || underPm2() || process.env.WEBMC_NO_SUPERVISOR === '1' || !gitDir(root)) return false;
  let child = null;
  const start = () => {
    child = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { stdio: 'inherit', env: { ...process.env, [CHILD_ENV]: '1' } });
    child.on('exit', (code, signal) => {
      if (code === RESTART_CODE) {
        console.log('[webbmc] Restarting with the updated panel...\n');
        return start();
      }
      process.exit(code ?? (signal ? 1 : 0));
    });
  };
  // Ctrl+C in the terminal reaches the child too, which stops its servers and exits; the supervisor waits for it.
  process.on('SIGINT', () => {});
  for (const sig of ['SIGTERM', 'SIGHUP']) process.on(sig, () => child?.kill(sig));
  start();
  return true;
}

module.exports = { run, gitDir, supervised, restartsOnExit, RESTART_CODE };
