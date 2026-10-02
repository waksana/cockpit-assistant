import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function identity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, started: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}

// Linux process metadata, never native Chat files. Preserve start times so a
// reused PID cannot be mistaken for one of this fixture's former descendants.
export function ownedProcesses(rootPid) {
  const rows = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map(row => row.trim().split(/\s+/).map(Number));
  const owned = new Set([rootPid]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) {
      owned.add(pid); changed = true;
    }
  }
  return [...owned].map(identity).filter(Boolean);
}

export function survivingProcesses(owned) {
  return owned.filter(item => identity(item.pid)?.started === item.started);
}

export function terminateProcesses(owned, signal = 'SIGKILL') {
  for (const item of survivingProcesses(owned).reverse()) {
    if (item.pid === process.pid) continue;
    try { process.kill(item.pid, signal); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
}
