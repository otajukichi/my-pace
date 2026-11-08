import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { runWorkerOnce } from '../processing/running/worker.mjs';
import { createDriveClient, oauthTokenProvider } from '../processing/running/drive.mjs';
import { drivePublisher } from '../processing/running/publish.mjs';
import { privatePath } from '../processing/running/private-path.mjs';
import { atomic, json } from '../processing/running/cache.mjs';

const args = process.argv.slice(2), once = args.includes('--once'), values = args.filter(x => x !== '--once');
const options = {};
for (let i = 0; i < values.length; i += 2) {
  if (!['--input', '--config', '--interval'].includes(values[i]) || !values[i + 1]) throw Error('Usage: npm run watch:running -- --input data/raw | --config data/running-worker.json [--once]');
  options[values[i]] = values[i + 1];
}
if (!!options['--input'] === !!options['--config']) throw Error('Specify exactly one of --input or --config');
let config = options['--config'] ? JSON.parse(await readFile(await privatePath(options['--config']), 'utf8')) : { input: options['--input'] };
const output = await privatePath(config.output || 'data/running-display', { directory: true });
const cache = await privatePath(config.cache || 'data/running-cache', { directory: true });
const state = await privatePath(config.state || 'data/running-worker', { directory: true });
const input = config.input ? await privatePath(config.input, { directory: true }) : undefined;
const interval = Number(options['--interval'] || config.intervalSeconds || (input ? 10 : 300));
if (!Number.isFinite(interval) || interval < (input ? 2 : 60) || interval > 86400) throw Error('WORKER_INTERVAL_INVALID');
const tokenPath = config.tokenPath ? await privatePath(config.tokenPath) : undefined;
const drive = tokenPath ? createDriveClient({ accessToken: oauthTokenProvider(tokenPath) }) : undefined;
if (!input && (!drive || !config.sourceFolder)) throw Error('DRIVE_WORKER_CONFIG_REQUIRED');
const publisher = config.publishToDrive === true ? drivePublisher(drive, await privatePath(join(state, 'publisher'), { directory: true })) : undefined;
if (publisher && !drive) throw Error('DRIVE_AUTH_SETUP_REQUIRED');
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => stop.abort());
let failures = 0;
do {
  const started = performance.now(), requests = drive?.stats.requests || 0, downloaded = drive?.stats.downloadBytes || 0;
  try {
    const report = await runWorkerOnce({ input, drive, sourceFolder: config.sourceFolder, output, cache, state, publisher, settleMs: once ? 0 : 2000 });
    report.elapsedSeconds = Math.round((performance.now() - started) / 10) / 100;
    report.driveRequests = (drive?.stats.requests || 0) - requests;
    report.downloadBytes = (drive?.stats.downloadBytes || 0) - downloaded;
    failures = 0;
    await atomic(join(state, 'status.json'), json({ checkedAt: new Date().toISOString(), ...report }));
    console.log(JSON.stringify(report));
  } catch (error) {
    failures++;
    // Only stable error codes go to logs; never print paths, file names, HTTP bodies or tokens.
    const code = /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : (error.code || 'WORKER_UPDATE_FAILED');
    await atomic(join(state, 'status.json'), json({ checkedAt: new Date().toISOString(), status: 'error', code, failures }));
    console.error(JSON.stringify({ status: 'error', code, failures }));
    if (once) process.exitCode = 1;
  }
  if (once || stop.signal.aborted) break;
  try { await sleep(Math.min(3600000, interval * 1000 * 2 ** Math.min(4, failures)), undefined, { signal: stop.signal }); }
  catch { break; }
} while (!stop.signal.aborted);
