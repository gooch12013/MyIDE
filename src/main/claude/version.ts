// The user's own `claude`, checked once per launch against the version the spikes ran on.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { spawnEnv } from '../pty';

const TESTED = '2.1.292';
const run = promisify(execFile);
let cached: ReturnType<typeof probe> | undefined;

async function probe(): Promise<{ path: string | null; version: string | null; tested: boolean; testedVersion: string }> {
  const env = await spawnEnv();
  const out = async (cmd: string, args: string[]) => {
    try { return (await run(cmd, args, { env, timeout: 15_000 })).stdout.trim(); } catch { return ''; }
  };
  const path = (await out('/usr/bin/which', ['claude'])) || null;
  const version = path ? /\d+\.\d+\.\d+/.exec(await out(path, ['--version']))?.[0] ?? null : null;
  return { path, version, tested: version === TESTED, testedVersion: TESTED };
}

export function claudeInfo(): ReturnType<typeof probe> {
  return (cached ??= probe());
}
