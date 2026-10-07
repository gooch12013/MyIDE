import { execFile } from 'node:child_process';

// Forge tokens live in the macOS login keychain (service myide-github / myide-forgejo, account = host),
// never in a file. MYIDE_KEYCHAIN names another keychain file (tests use a temp one).
// No `-T` access list: the only app that reads these items is /usr/bin/security, which an employee's shell can run
// just as well, so an ACL cannot tell MyIDE from an employee. Employees are kept off it by their deny rules
// (Bash(security *) for Claude) and the hard-deny list for Codex (acp/client.ts).
const KC = process.env.MYIDE_KEYCHAIN ? [process.env.MYIDE_KEYCHAIN] : [];

const HOST = /^[a-z0-9.-]+(:\d+)?$/i;
const TOKEN = /^[A-Za-z0-9_.-]{8,255}$/;
const check = (service: string, host: string) => {
  if (!/^myide-[a-z]+$/.test(service) || !HOST.test(host)) throw new Error('Bad keychain service or host');
};

function security(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/security', args, { timeout: 10_000 }, (err, out) => (err ? reject(err) : resolve(out)));
    if (input !== undefined) child.stdin?.end(input);
  });
}

export async function getToken(service: string, host: string): Promise<string | null> {
  check(service, host);
  try { return (await security(['find-generic-password', '-s', service, '-a', host, '-w', ...KC])).trim() || null; } catch { return null; }
}

/** Stores (or replaces) a token. It goes in through `security -i` on stdin so it never shows in the process list. */
export async function setToken(service: string, host: string, token: string): Promise<void> {
  check(service, host);
  if (!TOKEN.test(token)) throw new Error('That does not look like a token (letters, digits, _ . - only).');
  await security(['-i'], `add-generic-password -U -s ${service} -a ${host} -w ${token}${KC.map((k) => ` "${k}"`).join('')}\n`);
  if ((await getToken(service, host)) !== token) throw new Error('The keychain did not keep the token.');
}

export async function removeToken(service: string, host: string): Promise<void> {
  check(service, host);
  try { await security(['delete-generic-password', '-s', service, '-a', host, ...KC]); } catch { /* not there */ }
}
