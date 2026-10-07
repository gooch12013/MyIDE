// Checks panel scope resolution and the command line's parser and completion (src/renderer/command.ts).
// Usage: node scripts/check-home.mjs
import assert from 'node:assert/strict';
import { byName, complete, parse, resolveScope, tokens } from '../src/renderer/command.ts';

// Scope: the tab's project by default (all on Home or with no tab), 'all', or a pinned project.
assert.equal(resolveScope(undefined, 'p1'), 'p1');
assert.equal(resolveScope('tab', 'p1'), 'p1');
assert.equal(resolveScope('tab', 'home'), null);
assert.equal(resolveScope(undefined, 'home'), null);
assert.equal(resolveScope(undefined, null), null);
assert.equal(resolveScope('all', 'p1'), null);
assert.equal(resolveScope('p2', 'p1'), 'p2');
assert.equal(resolveScope('p2', 'home'), 'p2');

assert.deepEqual(tokens(`a "b c" 'd e' f`).map((t) => t.text), ['a', 'b c', 'd e', 'f']);
assert.deepEqual(tokens('"unterminated quote').map((t) => t.text), ['unterminated quote']);

assert.deepEqual(parse('issue alpha "Leaderboard flickers"'), { cmd: 'issue', project: 'alpha', title: 'Leaderboard flickers' });
assert.deepEqual(parse('issue "No project given"'), { cmd: 'issue', project: undefined, title: 'No project given' });
assert.deepEqual(parse('issue alpha Unquoted title words'), { cmd: 'issue', project: 'alpha', title: 'Unquoted title words' });
assert.ok('error' in parse('issue'));
assert.deepEqual(parse('todo "Renew the cert" @sysadmin'), { cmd: 'todo', text: 'Renew the cert @sysadmin' });
assert.deepEqual(parse('assign alpha/alpha-one "drop stale presence"'), { cmd: 'assign', project: 'alpha', employee: 'alpha-one', text: 'drop stale presence' });
assert.deepEqual(parse('assign alpha-one "in scope"'), { cmd: 'assign', employee: 'alpha-one', text: 'in scope' });
assert.ok('error' in parse('assign alpha/alpha-one'));
assert.ok('error' in parse('assign "only text"'));
assert.deepEqual(parse('hire beta Helper "write the tests"'), { cmd: 'hire', project: 'beta', role: 'Helper', text: 'write the tests' });
assert.deepEqual(parse('hire Helper "in scope"'), { cmd: 'hire', role: 'Helper', text: 'in scope' });
assert.ok('error' in parse('hire beta Helper'));
assert.ok('error' in parse('hire a b c "too many words"'));
assert.deepEqual(parse('go alpha/alpha-one'), { cmd: 'go', project: 'alpha', employee: 'alpha-one' });
assert.deepEqual(parse('GO alpha-one'), { cmd: 'go', employee: 'alpha-one' });
assert.ok('error' in parse('go'));
assert.deepEqual(parse('pause beta'), { cmd: 'pause', project: 'beta' });
assert.deepEqual(parse('resume'), { cmd: 'resume', project: undefined });
assert.deepEqual(parse('help'), { cmd: 'help' });
assert.match(parse('frobnicate x').error, /Unknown command/);
assert.match(parse('   ').error, /Type a command/);

const ps = [{ id: 'a1', name: 'Alpha' }, { id: 'b2', name: 'beta' }];
assert.equal(byName(ps, 'alpha')?.id, 'a1');
assert.equal(byName(ps, 'b2')?.name, 'beta');
assert.equal(byName(ps, 'gamma'), undefined);
assert.equal(byName(ps, undefined), undefined);

const ctx = { projects: ['alpha', 'beta'], employees: { alpha: ['alpha-one', 'alpha-two'], beta: [] }, roles: ['Helper', 'reviewer'] };
assert.deepEqual(complete('as', ctx), ['assign ']);
assert.deepEqual(complete('', ctx).length, 8);
assert.deepEqual(complete('assign a', ctx), ['assign alpha/']);
assert.deepEqual(complete('assign alpha/', ctx), ['assign alpha/alpha-one ', 'assign alpha/alpha-two ']);
assert.deepEqual(complete('go alpha/alpha-t', ctx), ['go alpha/alpha-two ']);
assert.deepEqual(complete('pause ', ctx), ['pause alpha ', 'pause beta ']);
assert.deepEqual(complete('hire beta h', ctx), ['hire beta Helper ']);
assert.deepEqual(complete('issue alpha "Some ti', ctx), []);

console.log('check-home: ok');
