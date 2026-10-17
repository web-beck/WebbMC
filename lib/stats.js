'use strict';
// Host and per-process resource sampling without native modules.
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const v of Object.values(cpu.times)) total += v;
    idle += cpu.times.idle;
  }
  return { idle, total };
}

let lastCpu = cpuTimes();
/** Host CPU % since the previous call. */
function hostCpu() {
  const now = cpuTimes();
  const idle = now.idle - lastCpu.idle;
  const total = now.total - lastCpu.total;
  lastCpu = now;
  return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0;
}

/**
 * Memory as the panel sees it. Inside a container (Railway, Docker) os.totalmem() reports the
 * whole host, so prefer the cgroup v2 limit and usage when one is set.
 */
function memory() {
  const total = os.totalmem();
  const fallback = { total, used: total - os.freemem(), limited: false };
  if (process.platform !== 'linux') return fallback;
  try {
    const max = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (max === 'max' || Number(max) >= total) return fallback;
    const current = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8').trim());
    return { total: Number(max), used: current, limited: true };
  } catch {
    return fallback;
  }
}

async function disk(p) {
  try {
    const s = await fs.promises.statfs(p);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return null;
  }
}

const parseClock = (s) => s.split(':').reduce((acc, part) => acc * 60 + Number.parseFloat(part), 0) * 1000;

/** Resolve to Map<pid, { cpuMs, rss }> with cumulative CPU time and resident memory. */
function sampleProcs(pids) {
  if (!pids.length) return Promise.resolve(new Map());

  if (process.platform === 'win32') {
    const cmd =
      `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { '{0} {1} {2}' -f $_.Id, [int64]$_.TotalProcessorTime.TotalMilliseconds, $_.WorkingSet64 }`;
    return new Promise((resolve) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 8000 }, (_err, stdout) => {
        const map = new Map();
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const [pid, cpuMs, rss] = line.trim().split(/\s+/).map(Number);
          if (pid) map.set(pid, { cpuMs, rss });
        }
        resolve(map);
      });
    });
  }

  if (process.platform === 'linux') {
    const map = new Map();
    for (const pid of pids) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ticks = Number(fields[11]) + Number(fields[12]); // utime + stime
        const pages = Number(fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]);
        map.set(pid, { cpuMs: ticks * 10, rss: pages * 4096 });
      } catch {
        /* process exited between listing and sampling */
      }
    }
    return Promise.resolve(map);
  }

  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pid=,time=,rss=', '-p', pids.join(',')], { timeout: 5000 }, (_err, stdout) => {
      const map = new Map();
      for (const line of String(stdout || '').split('\n')) {
        const [pid, time, rss] = line.trim().split(/\s+/);
        if (pid) map.set(Number(pid), { cpuMs: parseClock(time), rss: Number(rss) * 1024 });
      }
      resolve(map);
    });
  });
}

module.exports = { hostCpu, memory, disk, sampleProcs };
