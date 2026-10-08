// The user's own `claude`, checked once per launch against the version the spikes ran on.
import { cliVersion, spawnEnv } from '../pty';

const TESTED = '2.1.294';
let cached: ReturnType<typeof probe> | undefined;

async function probe(): Promise<{ version: string | null; tested: boolean; testedVersion: string }> {
  const version = await cliVersion('claude', await spawnEnv());
  return { version, tested: version === TESTED, testedVersion: TESTED };
}

export function claudeInfo(): ReturnType<typeof probe> {
  return (cached ??= probe());
}
