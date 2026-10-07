// Checks planCommands() in src/main/mac.ts: only the first ```bash block counts, the Undo section is never granted,
// heredocs and continued lines are one command each, and output blocks are ignored. Usage: node scripts/check-plan.mjs
import assert from 'node:assert/strict';
import { planCommands } from '../src/main/mac.ts';

const plan = (...lines) => planCommands(lines.join('\n'));

// The basics: comments, a $ prompt, duplicates, a continued line.
assert.deepEqual(plan('Plan', '```bash', 'ls -la', '# a comment', '$ touch notes.txt', '', 'touch notes.txt', 'brew upgrade \\', '  --greedy', '```'),
  ['ls -la', 'touch notes.txt', 'brew upgrade \\\n--greedy']);
assert.deepEqual(plan('no blocks here'), []);

// Only the first ```bash block; sh, console, zsh and plain blocks (output, examples) never count.
assert.deepEqual(plan('```console', '$ rm -rf ~/x', '```', '```sh', 'rm -rf ~/y', '```', '```', 'rm -rf ~/z', '```',
  '```bash', 'brew cleanup', '```', '```bash', 'rm -rf ~/later', '```'), ['brew cleanup']);

// The Undo section is never granted, before or after the commands, as a heading, bold label or plain label.
const undoFirst = plan('## Undo', '```bash', 'brew uninstall jq', '```', '## Commands', '```bash', 'brew install jq', '```');
assert.deepEqual(undoFirst, ['brew install jq']);
// Everything after an Undo label up to the next heading is Undo: with no heading after it, nothing is granted (fails closed).
assert.deepEqual(plan('**Undo**', '```bash', 'mv ~/.zshrc.bak ~/.zshrc', '```', '```bash', 'cp ~/.zshrc ~/.zshrc.bak', '```'), []);
assert.deepEqual(plan('**Undo**', '```bash', 'mv ~/.zshrc.bak ~/.zshrc', '```', '**Commands**', '```bash', 'cp ~/.zshrc ~/.zshrc.bak', '```'), ['cp ~/.zshrc ~/.zshrc.bak']);
assert.deepEqual(plan('Undo: run this', '```bash', 'launchctl unload x.plist', '```'), []);
assert.deepEqual(plan('```bash', 'launchctl load x.plist', '```', 'Undo:', '```bash', 'launchctl unload x.plist', '```'), ['launchctl load x.plist']);

// Heredocs: <<WORD, <<-WORD and quoted words run to the terminator as one command, the body exactly as written.
assert.deepEqual(plan('```bash', "cat > ~/x.conf <<'EOF'", '  indented = 1', '$notvar', 'EOF', 'echo done', '```'),
  ["cat > ~/x.conf <<'EOF'\n  indented = 1\n$notvar\nEOF", 'echo done']);
assert.deepEqual(plan('```bash', 'tee a <<-END', '\tline', '\tEND', 'ls', '```'), ['tee a <<-END\n\tline\n\tEND', 'ls']);
assert.deepEqual(plan('```bash', 'ssh pi "sh -s" << "X"', 'uptime', 'X', '```'), ['ssh pi "sh -s" << "X"\nuptime\nX']);
// A # line inside a heredoc body is content, not a comment; an unterminated heredoc is still one command.
assert.deepEqual(plan('```bash', 'cat >f <<EOF', '# keep me', 'EOF', '```'), ['cat >f <<EOF\n# keep me\nEOF']);
assert.deepEqual(plan('```bash', 'cat >f <<EOF', 'never ends', '```'), ['cat >f <<EOF\nnever ends\n']);
console.log('check-plan: ok');
