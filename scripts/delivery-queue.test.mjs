import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { loadPolicy } from './agent-policy.mjs';
import {
  claimRecord,
  deliveryQueue,
  effortRecord,
  ledgerLine,
  nextLeaf,
  restClient,
  stackReady,
} from './delivery-queue.mjs';

const policy = loadPolicy();
const repo = `repos/${policy.binding.repository}`;
const project = `users/${policy.binding.project.owner}/projectsV2/${policy.binding.project.number}`;
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const comment = (body) => ({
  body,
  author_association: 'OWNER',
  user: { login: 'owner' },
  html_url: 'claim-url',
});
const claimed = (agent = 'delivery', worktree = '.codex/worktrees/one') =>
  comment(
    `<!-- mcc-claim ${JSON.stringify({ agent, branch: 'agent/1-one', worktree })} -->`,
  );
const pull = (number, state = 'open') => ({
  number: number + 100,
  body: `Closes #${number}\nPre-PR review: APPROVE; base=${base}; head=${head}`,
  state,
  base: { sha: base },
  head: { sha: head },
  html_url: `pr-${number}`,
  merged_at: state === 'closed' ? 'today' : null,
});

function fixture({
  tree = { 10: [3, 1, 2] },
  deps = {},
  closed = [],
  comments = {},
  pulls = [],
  denied = [],
  branches = [],
  checks = [{ status: 'completed', conclusion: 'success' }],
  statuses = [],
} = {}) {
  const calls = [];
  const api = {
    get(path) {
      calls.push(path);
      const match = /\/issues\/(\d+)$/.exec(path);
      if (match) {
        const n = Number(match[1]);
        if (denied.includes(n)) throw new Error('HTTP 404');
        return {
          number: n,
          title: `Issue ${n}`,
          state: closed.includes(n) ? 'closed' : 'open',
          labels: [{ name: 'severity: critical' }],
        };
      }
      if (path.endsWith('/status')) return { statuses };
      throw new Error(`unexpected GET ${path}`);
    },
    list(path, key) {
      calls.push(path);
      const match =
        /\/issues\/(\d+)\/(sub_issues|comments|dependencies\/blocked_by)$/.exec(
          path,
        );
      if (match) {
        const n = Number(match[1]);
        if (match[2] === 'sub_issues')
          return (tree[n] ?? []).map((number) => ({ number }));
        if (match[2] === 'comments') return comments[n] ?? [];
        return (deps[n] ?? []).map((number) => ({ number }));
      }
      if (path === `${project}/fields`)
        return [
          {
            id: 1,
            name: 'Status',
            options: [{ id: 'r', name: { raw: 'Ready' } }],
          },
          { id: 2, name: 'Size', options: [{ id: 'l', name: { raw: 'L' } }] },
        ];
      if (path === `${project}/items?fields=1,2`)
        return [
          {
            content: {
              number: 1,
              repository_url: `https://api.github.com/${repo}`,
            },
            fields: [
              { id: 1, value: { id: 'r', name: { raw: 'Ready' } } },
              { id: 2, value: 'l' },
            ],
          },
        ];
      if (path === `${repo}/pulls?state=all`) return pulls;
      if (path === `${repo}/branches`) return branches;
      if (path.endsWith('/check-runs')) {
        assert.equal(key, 'check_runs');
        return checks;
      }
      throw new Error(`unexpected list ${path}`);
    },
  };
  return { api, calls };
}
const queue = (options = {}, args = {}) => {
  const f = fixture(options);
  return {
    ...deliveryQueue(policy, 10, { api: f.api, ...args }),
    calls: f.calls,
  };
};

test('recursive native leaves use dependency order and numeric ties, including external blockers', () => {
  const { rows, errors, calls } = queue({
    tree: { 10: [20, 3], 20: [2, 1] },
    deps: { 1: [3], 2: [99] },
    closed: [99],
  });
  assert.deepEqual(
    rows.map((row) => row.issue),
    [2, 3, 1],
  );
  assert.deepEqual(errors, []);
  assert.ok(calls.includes(`${repo}/issues/99`));
  assert.deepEqual(
    rows.map((row) => row.state),
    ['ready', 'ready', 'waiting'],
  );
  assert.equal(rows.find((row) => row.issue === 1).size, 'L');
  assert.equal(rows.find((row) => row.issue === 1).projectState, 'Ready');
  assert.ok(rows.every((row) => row.effort.effort === 'medium'));
  assert.deepEqual(
    queue({ deps: { 1: [99], 99: [3] } }).rows.map((row) => row.issue),
    [2, 3, 1],
  );
});

test('cycles block their leaves and do not prevent unrelated ready leaves', () => {
  const { rows } = queue({ deps: { 1: [2], 2: [1] } });
  assert.deepEqual(
    rows.filter((row) => row.state === 'ready').map((row) => row.issue),
    [3],
  );
  assert.ok(
    rows
      .filter((row) => row.issue !== 3)
      .every((row) => /cycle/.test(row.blocker)),
  );
});

test('every queue state is assigned from current PR, claim, and dependency data', () => {
  const { rows } = queue(
    {
      tree: { 10: [1, 2, 3, 4, 5, 6, 7] },
      closed: [1],
      pulls: [pull(2), pull(7, 'closed')],
      comments: { 3: [claimed('other')], 4: [claimed()] },
      deps: { 5: [99] },
    },
    { resume: 4 },
  );
  assert.deepEqual(
    Object.fromEntries(rows.map((row) => [row.issue, row.state])),
    {
      1: 'done',
      2: 'in review',
      3: 'owned elsewhere',
      4: 'resume',
      5: 'waiting',
      6: 'ready',
      7: 'done',
    },
  );
  assert.equal(rows.find((row) => row.issue === 3).claim.url, 'claim-url');
});

test('single leaves work, missing children are recorded as BLOCKED, native cycles terminate', () => {
  const leaf = fixture({ tree: {} });
  assert.equal(deliveryQueue(policy, 1, { api: leaf.api }).rows[0].issue, 1);
  const inaccessible = queue({ denied: [2] });
  assert.match(inaccessible.errors[0], /#2 inaccessible/);
  assert.match(
    inaccessible.rows.find((row) => row.issue === 2).blocker,
    /BLOCKED/,
  );
  const cyclic = queue({ tree: { 10: [20], 20: [10] } });
  assert.match(cyclic.errors[0], /native sub-issue cycle/);
});

test('resume requires the explicit request or this delivery identity and a registered worktree', () => {
  const options = { comments: { 1: [claimed()] } };
  assert.equal(queue(options).rows[0].state, 'owned elsewhere');
  assert.equal(
    queue(options, {
      actor: 'delivery',
      worktrees: ['/repo/.codex/worktrees/one'],
    }).rows[0].state,
    'resume',
  );
  assert.equal(
    queue(options, {
      actor: 'other',
      worktrees: ['/repo/.codex/worktrees/one'],
    }).rows[0].state,
    'owned elsewhere',
  );
  assert.equal(
    queue(options, { actor: 'delivery', worktrees: [] }).rows[0].state,
    'owned elsewhere',
  );
  assert.equal(queue(options, { resume: 1 }).rows[0].state, 'resume');
});

test('--next resumes first and reports an earlier foreign claim instead of skipping it', () => {
  const rows = queue(
    { comments: { 1: [claimed('other')], 3: [claimed()] } },
    { resume: 3 },
  ).rows;
  assert.equal(nextLeaf(rows).issue, 3);
  assert.equal(
    nextLeaf(rows.filter((row) => row.issue !== 3)).state,
    'owned elsewhere',
  );
  assert.equal(nextLeaf([{ state: 'waiting' }]), undefined);
});

test('stack readiness requires an open ready PR, passing checks, and exact approval pair', () => {
  const pr = pull(1);
  const good = [{ status: 'completed', conclusion: 'success' }];
  assert.equal(stackReady(pr, good, []), true);
  for (const bad of [
    { ...pr, draft: true },
    { ...pr, state: 'closed' },
    { ...pr, body: 'Closes #1' },
    { ...pr, head: { sha: 'c'.repeat(40) } },
  ])
    assert.equal(stackReady(bad, good, []), false);
  assert.equal(stackReady(pr, [], []), false);
  assert.equal(stackReady(pr, [{ status: 'in_progress' }], []), false);
  assert.equal(stackReady(pr, good, [{ state: 'failure' }]), false);
  assert.equal(
    queue({ deps: { 1: [99] }, pulls: [pull(99)] }).rows.find(
      (row) => row.issue === 1,
    ).state,
    'ready',
  );
  assert.equal(
    queue({ deps: { 1: [99] }, pulls: [pull(99)], checks: [] }).rows.find(
      (row) => row.issue === 1,
    ).state,
    'waiting',
  );
});

test('released, untrusted, and legacy claims follow ownership rules', () => {
  assert.equal(
    claimRecord([
      claimed(),
      comment('<!-- mcc-claim {"agent":"delivery","released":true} -->'),
    ]),
    null,
  );
  assert.equal(
    claimRecord([{ ...claimed(), author_association: 'NONE' }]),
    null,
  );
  const legacy = comment(
    'Agent `delivery` claims #1 on branch `agent/1-one` in `.codex/worktrees/one`.',
  );
  assert.equal(claimRecord([legacy]).branch, 'agent/1-one');
  assert.equal(claimRecord([legacy, comment('Released the claim.')]), null);
});

test('the ledger reuses only qualifying effort decisions and never escalates from metadata', () => {
  const decision = {
    effort: 'high',
    rule: 'H1-boundary',
    evidence: 'spec §3: replay race',
    reason: 'The plan leaves the write barrier unresolved.',
    question: 'Which write orders preserve immutable evidence?',
    criteria: Object.fromEntries(
      policy.implementationEffort.rules['H1-boundary'].requires.map((key) => [
        key,
        true,
      ]),
    ),
  };
  const record = comment(`<!-- mcc-effort ${JSON.stringify(decision)} -->`);
  assert.equal(effortRecord([record], policy).effort, 'high');
  assert.equal(
    effortRecord([comment('Size L; infrastructure; severity critical')], policy)
      .effort,
    'medium',
  );
  assert.equal(
    effortRecord(
      [
        comment(
          `<!-- mcc-effort ${JSON.stringify({ ...decision, criteria: {} })} -->`,
        ),
      ],
      policy,
    ).effort,
    'medium',
  );
  const { rows } = queue({ comments: { 1: [record] } });
  assert.match(
    ledgerLine(rows[0]),
    /effort=high; rule=H1-boundary; evidence=spec/,
  );
});

test('REST client follows Link pagination through gh, uses only GET, and propagates errors', () => {
  const calls = [];
  const api = restClient((command, args, options) => {
    calls.push(args);
    assert.equal(command, 'gh');
    assert.deepEqual(args.slice(2), [
      '--method',
      'GET',
      '--paginate',
      '--slurp',
    ]);
    assert.ok(options.maxBuffer > 1024 * 1024);
    return JSON.stringify([Array(100).fill({}), [{ last: true }]]);
  });
  assert.equal(api.list('repos/x/y/branches').length, 101);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /per_page=100$/);
  assert.throws(
    () =>
      restClient(() => {
        throw new Error('denied');
      }).get('x'),
    /GET x: denied/,
  );
  assert.throws(() => restClient(() => '[{}]').list('x'), /expected a list/);
  assert.deepEqual(
    restClient(() => '[{"check_runs":[1]},{"check_runs":[2]}]').list(
      'x',
      'check_runs',
    ),
    [1, 2],
  );
});

test('each run refetches its state and reads no source, diff, or persistent cache', () => {
  const f = fixture();
  deliveryQueue(policy, 10, { api: f.api });
  deliveryQueue(policy, 10, { api: f.api });
  assert.equal(
    f.calls.filter((path) => path === `${project}/fields`).length,
    2,
  );
  assert.equal(f.calls.filter((path) => path === `${repo}/issues/1`).length, 2);
  assert.ok(f.calls.every((path) => !/diff|contents|graphql/.test(path)));
});

test('CLI validates its target and documents --next and resume', () => {
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [new URL('./delivery-queue.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' },
    );
  assert.equal(run('--help').status, 0);
  assert.match(run('--help').stdout, /--next/);
  assert.match(run('not-an-issue').stderr, /positive issue number/);
});

test('an explicit medium constraint persists across later recorded high assessments', () => {
  const medium = comment(
    '<!-- mcc-effort {"effort":"medium","rule":"user override","evidence":"request","reason":"explicit medium"} -->',
  );
  const decision = {
    effort: 'high',
    rule: 'H3-demonstrated-limit',
    later: true,
    question: 'write ordering',
    evidence: 'case 1',
    reason: 'design revision',
    criteria: Object.fromEntries(
      policy.implementationEffort.rules['H3-demonstrated-limit'].requires.map(
        (key) => [key, true],
      ),
    ),
  };
  const high = comment(`<!-- mcc-effort ${JSON.stringify(decision)} -->`);
  assert.equal(effortRecord([medium, high], policy).effort, 'medium');
  assert.equal(
    claimRecord([comment('Agent `other` claimed #1 on `agent/1-one`.')]).agent,
    'other',
  );
});
