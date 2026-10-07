import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Runs git in `cwd`; rejects with git's own error text. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    return (await run('git', ['-C', cwd, ...args])).stdout.trim();
  } catch (e) {
    throw new Error(((e as { stderr?: string }).stderr || (e as Error).message).trim());
  }
}

/** Throws a plain-language error unless `path` is a git repository with at least one commit. */
export async function checkRepo(path: string, name: string): Promise<void> {
  try { await git(path, 'rev-parse', '--show-toplevel'); } catch {
    throw new Error(`${name} is not a git repository. Employees work in git worktrees: run \`git init\` and make a first commit in ${path}.`);
  }
  try { await git(path, 'rev-parse', '--verify', 'HEAD'); } catch {
    throw new Error(`${name} has no commits yet. Make a first commit in ${path} so employees have a branch to start from.`);
  }
}

export const branchExists = (repo: string, branch: string): Promise<boolean> =>
  git(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).then(() => true, () => false);

/** New worktree on a new branch from HEAD (or `from`, e.g. a lead's branch), with the MyIDE hooks set for that worktree only. */
export async function addWorktree(repo: string, dir: string, branch: string, hooksDir: string, from?: string): Promise<void> {
  mkdirSync(dirname(dir), { recursive: true });
  await git(repo, 'worktree', 'add', dir, '-b', branch, ...(from ? [from] : []));
  await git(repo, 'config', 'extensions.worktreeConfig', 'true');
  await git(dir, 'config', '--worktree', 'core.hooksPath', hooksDir);
}

/** Removes the worktree (git refuses if it has uncommitted changes); deletes the branch only if merged. */
export async function removeWorktree(repo: string, dir: string, branch: string): Promise<void> {
  await git(repo, 'worktree', 'remove', dir);
  await git(repo, 'branch', '-d', branch).catch(() => {}); // unmerged: keep the work
}
