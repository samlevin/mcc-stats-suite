import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildPlan, printTree } from './spec-to-issues.mjs';

const catalog = JSON.parse(
  readFileSync(new URL('../.github/labels.json', import.meta.url), 'utf8'),
);
const options = {
  specPath: 'specs/fixture.md',
  repository: catalog.repository,
  labels: catalog.labels.map((l) => l.name),
};
const fixture = (name) =>
  readFileSync(
    new URL(`./fixtures/spec-to-issues/${name}.md`, import.meta.url),
    'utf8',
  );
const conforming = fixture('conforming');
const parse = (text = conforming) => buildPlan(text, options);

test('a conforming plan preserves hierarchy, acceptance, defaults and spec links', () => {
  const plan = parse();
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(
    plan.nodes.map((n) => [n.ref, n.kind, n.parent]),
    [
      ['root', 'CONTAINER', null],
      ['phase-0', 'EPIC', 'root'],
      ['P0.1', 'LEAF', 'phase-0'],
      ['P0.2', 'CONTAINER', 'phase-0'],
      ['P0.2.1', 'LEAF', 'P0.2'],
      ['P0.2.2', 'LEAF', 'P0.2'],
      ['P0.3', 'LEAF', 'phase-0'],
    ],
  );
  const port = plan.nodes.find((n) => n.ref === 'P0.1');
  assert.equal(port.priority, 'P1');
  assert.equal(port.size, 'XS');
  assert.deepEqual(port.labels, [
    'enhancement',
    'severity: none',
    'package: contracts',
  ]);
  assert.ok(
    port.body.includes(
      '- Port types compile.\n  - Existing APIs remain available.',
    ),
  );
  assert.match(port.body, /Tests never call live services/);
  assert.match(port.body, /fixture.md#3-runtime/);
  assert.match(port.body, /Files: `packages\/contracts\/src\/index.ts`/);
  assert.match(port.body, /Plan ID: P0.1/);
  assert.match(
    plan.nodes[1].body,
    /A storage port and independently testable adapters exist/,
  );
  assert.match(plan.nodes[1].body, /All port and adapter tests pass/);
  assert.deepEqual(plan.deferred, ['P1.1']);
  assert.ok(!plan.nodes.some((n) => n.ref === 'P1.1'));
  assert.equal(plan.nodes.at(-1).priority, 'P2');
  assert.match(
    printTree(plan),
    /Number \| Kind \| Plan ID \| Size \| Priority \| Parent \| Blocked by \| Labels \| Title/,
  );
  assert.match(printTree(plan), /P0.2.1 \| S \| P2 \| P0.2 \| P0.1/);
  assert.equal(plan.fingerprint, parse().fingerprint);
  assert.notEqual(plan.fingerprint, parse(conforming + '\n').fingerprint);
});

test('pre-flight returns all named violations in one pass', () => {
  const { errors } = parse(fixture('violating'));
  for (const expected of [
    'phase-0: missing Exit criteria',
    'P0.1: invalid size L',
    'P0.1: duplicate Plan ID',
    'P0.2: duplicate title Duplicate contract',
    'P0.2: missing Provides',
    'P0.1: unknown label missing label',
    'P0.1: unknown blocked-by slice P9.9',
  ])
    assert.ok(errors.includes(expected), `${expected}\n${errors.join('\n')}`);
  assert.ok(errors.some((e) => /dependency cycle/.test(e)));
});

test('required fields, malformed headers, priorities, sections and deferred blockers reject filing', () => {
  for (const [before, after, expected] of [
    [
      '**Goal:** A storage port and independently testable adapters exist.',
      '**Goal:**',
      'phase-0: missing Goal',
    ],
    [
      '- **Files:** `packages/contracts/src/index.ts`',
      '',
      'P0.1: missing Files',
    ],
    [
      '- **Acceptance:**\n  - Port types compile.\n  - Existing APIs remain available.',
      '- **Acceptance:**',
      'P0.1: missing Acceptance',
    ],
    [
      '#### P0.1 Define storage port (XS)',
      '#### Define storage port',
      'expected Plan ID',
    ],
    ['- **Priority:** P1', '- **Priority:** P9', 'P0.1: invalid priority P9'],
    [
      '- **Spec:** §3, §16',
      '- **Spec:** §99',
      'P0.1: unknown spec section §99',
    ],
    [
      '- **Blocked by:** none',
      '- **Blocked by:** P1.1',
      'P0.1: blocked by deferred slice P1.1',
    ],
    [
      '- **Blocked by:** none',
      '- **Blocked by:** spec 2.3 P0.1',
      'P0.1: Blocked by must be none or Plan IDs',
    ],
    [
      '- **Split into:** P0.2.1, P0.2.2',
      '- **Split into:** P0.2.1',
      'P0.2: Split into must list exactly its nested children',
    ],
  ]) {
    const { errors } = parse(conforming.replace(before, after));
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `${expected}: ${errors.join('\n')}`,
    );
  }
  assert.deepEqual(parse('# No plan').errors, ['§20: missing delivery plan']);
});

test('split children inherit blockers and container completion cannot depend on its child', () => {
  const changed = conforming.replace(
    '##### P0.2.1 Build read adapter (S)\n\n- **Blocked by:** P0.1',
    '##### P0.2.1 Build read adapter (S)\n\n- **Blocked by:** none',
  );
  const plan = parse(changed);
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.nodes.find((n) => n.ref === 'P0.2.1').blockedBy, [
    'P0.1',
  ]);
  const cycle = parse(
    conforming.replace('- **Blocked by:** P0.1', '- **Blocked by:** P0.2.1'),
  );
  assert.ok(cycle.errors.some((e) => /dependency cycle/.test(e)));
});

test('offline CLI writes no GitHub data and rejects invalid input before draft output', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spec-to-issues-'));
  const output = join(directory, 'drafts.json');
  const run = (name, ...extra) =>
    spawnSync(
      process.execPath,
      [
        new URL('./spec-to-issues.mjs', import.meta.url).pathname,
        'plan',
        new URL(`./fixtures/spec-to-issues/${name}.md`, import.meta.url)
          .pathname,
        ...extra,
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: directory } },
    );
  const good = run('conforming', '--output', output);
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout, '');
  const preview = run('conforming');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Fixture delivery plan/);
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).nodes.length, 7);
  const bad = run('violating', '--output', join(directory, 'bad.json'));
  assert.equal(bad.status, 1);
  assert.equal(bad.stdout, '');
  assert.match(bad.stderr, /missing Exit criteria/);
  assert.match(bad.stderr, /invalid size L/);
  assert.throws(() => readFileSync(join(directory, 'bad.json')), /ENOENT/);
  const inRepo = run(
    'conforming',
    '--output',
    new URL('./fixtures/spec-to-issues/forbidden.json', import.meta.url)
      .pathname,
  );
  assert.equal(inRepo.status, 1);
  assert.match(inRepo.stderr, /outside the repository/);
  symlinkSync(
    new URL('./fixtures/spec-to-issues/', import.meta.url).pathname,
    join(directory, 'inside'),
  );
  const linked = run(
    'conforming',
    '--output',
    join(directory, 'inside', 'forbidden.json'),
  );
  assert.equal(linked.status, 1);
  assert.match(linked.stderr, /outside the repository/);
  mkdirSync(join(directory, '.git'));
  const anotherCheckout = run(
    'conforming',
    '--output',
    join(directory, 'another.json'),
  );
  assert.equal(anotherCheckout.status, 1);
  assert.match(anotherCheckout.stderr, /outside the repository/);
});

test('numbered spec list items link to their owning section', () => {
  const plan = parse(
    conforming
      .replace('Adapters call storage.', '1. Adapters call storage.')
      .replace('- **Spec:** §3, §16', '- **Spec:** §3.1, §16'),
  );
  assert.deepEqual(plan.errors, []);
  assert.match(
    plan.nodes.find((n) => n.ref === 'P0.1').body,
    /\[§3.1\].*#3-runtime/,
  );
});
