// The user's own `claude`, checked once per launch against the version the spikes ran on.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawnEnv } from '../pty';

const TESTED = '2.1.292';
const run = promisify(execFile);
let cached: ReturnType<typeof probe> | undefined;

async function probe(): Promise<{ version: string | null; tested: boolean; testedVersion: string }> {
  let version: string | null = null;
  try { version = /\d+\.\d+\.\d+/.exec((await run('claude', ['--version'], { env: await spawnEnv(), timeout: 15_000 })).stdout)?.[0] ?? null; } catch { /* not installed */ }
  return { version, tested: version === TESTED, testedVersion: TESTED };
}

export function claudeInfo(): ReturnType<typeof probe> {
  return (cached ??= probe());
}
