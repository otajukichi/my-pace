import { spawn } from 'node:child_process';

/** Linux advisory lock: the kernel releases it even after SIGKILL. A persistent
 * guard inode must never be unlinked while another process could be waiting. */
export async function acquireLock(path, message) {
  if (process.platform !== 'linux') throw Error('RUNNING_WORKER_REQUIRES_LINUX_FLOCK');
  const child = spawn('flock', ['--exclusive', '--nonblock', '--conflict-exit-code', '73', path, process.execPath, '-e',
    'process.stdout.write("locked\\n"); process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));'], { stdio: ['pipe', 'pipe', 'pipe'] });
  // If the parent disappears, stdin closes and the guard process exits.
  child.stdin.on('error', () => {});
  let released = false;
  const exited = new Promise(resolve => child.once('exit', resolve));
  await new Promise((resolve, reject) => {
    child.once('error', () => reject(Error('RUNNING_WORKER_FLOCK_UNAVAILABLE')));
    child.once('exit', code => reject(Error(code === 73 ? message : 'RUNNING_WORKER_LOCK_FAILED')));
    child.stdout.once('data', data => data.toString().startsWith('locked') ? resolve() : reject(Error('RUNNING_WORKER_LOCK_FAILED')));
  });
  return async () => { if (!released) { released = true; child.stdin.end(); await exited; } };
}
