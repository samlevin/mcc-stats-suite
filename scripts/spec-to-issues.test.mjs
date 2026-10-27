import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ownershipNotes } from './delivery-queue.mjs';
import { applyEdges, buildPlan, printTree } from './spec-to-issues.mjs';

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
      ['P0.4', 'LEAF', 'phase-0'],
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
    'phase-0: [phase-fields] missing Exit criteria',
    'P0.1: [slice-heading] invalid size L',
    'P0.1: [unique-ids] duplicate Plan ID',
    'P0.2: [unique-titles] duplicate title Duplicate contract',
    'P0.2: [slice-fields] missing Provides',
    'P0.1: [labels] unknown label missing label',
    'P0.1: [blocked-by] unknown blocked-by slice P9.9',
    'P0.3: [cross-spec-prerequisites] Blocked by names a slice in another spec; move it to Cross-spec prerequisites',
    'P0.3: [cross-spec-prerequisites] Cross-spec prerequisites must be none or spec <number> <Plan ID> entries',
    'P0.3: [files] Files must be backticked paths on one line, or `none`',
    'P0.3: [provides] Provides must be comma-separated contract names on one line',
  ])
    assert.ok(errors.includes(expected), `${expected}\n${errors.join('\n')}`);
  assert.ok(
    errors.some((e) => /\[acyclic-blockers\] dependency cycle/.test(e)),
  );
});

// Rule names come from the template's §20 rule table, so a rule cannot be
// added there without a failing case here.
const ruleTable = [
  ...readFileSync(
    new URL('../specs/TEMPLATE.md', import.meta.url),
    'utf8',
  ).matchAll(/^> \| `([a-z-]+)` \|/gm),
].map((match) => match[1]);

const violations = {
  'spec-title': [
    ['# Fixture: Technical Specification\n', '\n'],
    'spec: [spec-title] missing document title',
  ],
  'plan-sections': [
    ['### 20.2 Seam contracts', '### Seam contracts'],
    '§20.2: [plan-sections] missing required section',
  ],
  'phase-heading': [
    ['### Phase 0: Contracts', '### Phase zero'],
    'Phase zero: [phase-heading] expected Phase <number>: <title>',
  ],
  'phase-fields': [
    ['**Exit criteria:** All port and adapter tests pass.', ''],
    'phase-0: [phase-fields] missing Exit criteria',
  ],
  'slice-heading': [
    [
      '#### P0.3 Describe storage API (XS)',
      '#### P0.3 Describe storage API (L)',
    ],
    'P0.3: [slice-heading] invalid size L',
  ],
  'slice-fields': [
    [
      '- **Spec:** §3\n- **Files:** `docs/storage.md`',
      '- **Files:** `docs/storage.md`',
    ],
    'P0.3: [slice-fields] missing Spec',
  ],
  'split-slice': [
    [
      '##### P0.2.2 Build write adapter (S)',
      '##### P0.5 Build write adapter (S)',
    ],
    'P0.5: [split-slice] child Plan ID must extend its split container ID',
  ],
  'blocked-by': [
    [
      '- **Blocked by:** P0.1\n- **Spec:** §3, §16\n- **Files:** `src/adapters/`',
      '- **Blocked by:** P0.1 and P0.3\n- **Spec:** §3, §16\n- **Files:** `src/adapters/`',
    ],
    'P0.2: [blocked-by] Blocked by must be none or Plan IDs',
  ],
  'cross-spec-prerequisites': [
    [
      '- **Cross-spec prerequisites:** spec 2.3 P5.2',
      '- **Cross-spec prerequisites:** #12',
    ],
    'P0.3: [cross-spec-prerequisites] Cross-spec prerequisites must be none or spec <number> <Plan ID> entries',
  ],
  files: [
    [
      '- **Files:** `docs/storage.md`, `docs/index.md`',
      '- **Files:** `docs/storage.md` (API section)',
    ],
    'P0.3: [files] Files must be backticked paths on one line, or `none`',
  ],
  provides: [
    [
      '- **Provides:** API documentation, Storage glossary',
      '- **Provides:** API documentation,,',
    ],
    'P0.3: [provides] Provides must be comma-separated contract names on one line',
  ],
  'spec-links': [
    ['- **Spec:** §3, §16', '- **Spec:** §99'],
    'P0.1: [spec-links] unknown spec section §99',
  ],
  'unique-ids': [
    [
      '#### P0.3 Describe storage API (XS)',
      '#### P0.1 Describe storage API (XS)',
    ],
    'P0.1: [unique-ids] duplicate Plan ID',
  ],
  'unique-titles': [
    [
      '#### P0.3 Describe storage API (XS)',
      '#### P0.3 Define storage port (XS)',
    ],
    'P0.3: [unique-titles] duplicate title Define storage port',
  ],
  'acyclic-blockers': [
    [
      '- **Blocked by:** none\n- **Spec:** §3, §16',
      '- **Blocked by:** P0.2.1\n- **Spec:** §3, §16',
    ],
    /^P0\.\d: \[acyclic-blockers\] dependency cycle/,
  ],
  'backlog-blocker': [
    [
      '- **Blocked by:** none\n- **Spec:** §3, §16',
      '- **Blocked by:** P1.1\n- **Spec:** §3, §16',
    ],
    'P0.1: [backlog-blocker] blocked by deferred slice P1.1; resolve before filing',
  ],
  priority: [
    ['- **Priority:** P1', '- **Priority:** P9'],
    'P0.1: [priority] invalid priority P9',
  ],
  labels: [
    ['package: contracts\n', 'package: missing\n'],
    'P0.1: [labels] unknown label package: missing',
  ],
};

test('every rule in the template table has a passing and a failing case', () => {
  assert.ok(ruleTable.length > 10, ruleTable.join(', '));
  assert.deepEqual(Object.keys(violations).sort(), [...ruleTable].sort());
  assert.deepEqual(parse().errors, []);
  for (const [rule, [[before, after], expected]] of Object.entries(
    violations,
  )) {
    assert.ok(conforming.includes(before), `${rule}: fixture lacks ${before}`);
    const { errors } = parse(conforming.replace(before, after));
    assert.ok(
      errors.some((e) =>
        typeof expected === 'string' ? e === expected : expected.test(e),
      ),
      `${rule}: ${errors.join('\n')}`,
    );
  }
});

test('every pre-flight error carries a rule name from the template table', () => {
  const errors = [
    ...parse(fixture('violating')).errors,
    ...parse('# No plan').errors,
    ...Object.values(violations).flatMap(
      ([[before, after]]) => parse(conforming.replace(before, after)).errors,
    ),
  ];
  for (const error of errors) {
    const rule = /^[^\n]+?: \[([a-z-]+)\] \S/.exec(error)?.[1];
    assert.ok(ruleTable.includes(rule), error);
  }
});

test('a cross-spec prerequisite is carried to the issue and is never a local blocker', () => {
  const plan = parse();
  const docs = plan.nodes.find((n) => n.ref === 'P0.3');
  assert.deepEqual(docs.blockedBy, []);
  assert.match(
    docs.body,
    /Provides: API documentation, Storage glossary\n\nCross-spec prerequisites: spec 2\.3 P5\.2\n\n### Validation/,
  );
  assert.doesNotMatch(
    plan.nodes.find((n) => n.ref === 'P0.4').body,
    /Cross-spec prerequisites/,
  );
  const misplaced = parse(
    conforming
      .replace(
        '#### P0.3 Describe storage API (XS)',
        '#### P5.2 Describe storage API (XS)',
      )
      .replace(
        '- **Blocked by:** none\n- **Cross-spec prerequisites:** spec 2.3 P5.2',
        '- **Blocked by:** spec 2.3 P5.2',
      ),
  );
  assert.deepEqual(misplaced.errors, [
    'P5.2: [cross-spec-prerequisites] Blocked by names a slice in another spec; move it to Cross-spec prerequisites',
  ]);
});

test('the delivery queue reads slice Files and Provides as complete ownership', () => {
  const plan = parse();
  assert.deepEqual(
    ownershipNotes(plan.nodes.find((n) => n.ref === 'P0.3').body),
    {
      files: ['docs/storage.md', 'docs/index.md'],
      contracts: ['API documentation', 'Storage glossary'],
      complete: true,
    },
  );
  assert.deepEqual(
    ownershipNotes(plan.nodes.find((n) => n.ref === 'P0.4').body),
    {
      files: ['none'],
      contracts: [],
      complete: true,
    },
  );
});

test('required fields, malformed headers, priorities, sections and deferred blockers reject filing', () => {
  for (const [before, after, expected] of [
    [
      '**Goal:** A storage port and independently testable adapters exist.',
      '**Goal:**',
      'phase-0: [phase-fields] missing Goal',
    ],
    [
      '- **Files:** `packages/contracts/src/index.ts`',
      '',
      'P0.1: [slice-fields] missing Files',
    ],
    [
      '- **Acceptance:**\n  - Port types compile.\n  - Existing APIs remain available.',
      '- **Acceptance:**',
      'P0.1: [slice-fields] missing Acceptance',
    ],
    [
      '#### P0.1 Define storage port (XS)',
      '#### Define storage port',
      '[slice-heading] expected Plan ID',
    ],
    [
      '- **Priority:** P1',
      '- **Priority:** P9',
      'P0.1: [priority] invalid priority P9',
    ],
    [
      '- **Spec:** §3, §16',
      '- **Spec:** §99',
      'P0.1: [spec-links] unknown spec section §99',
    ],
    [
      '- **Blocked by:** none',
      '- **Blocked by:** P1.1',
      'P0.1: [backlog-blocker] blocked by deferred slice P1.1',
    ],
    [
      '- **Blocked by:** none',
      '- **Blocked by:** P0.2 or later',
      'P0.1: [blocked-by] Blocked by must be none or Plan IDs',
    ],
    [
      '- **Split into:** P0.2.1, P0.2.2',
      '- **Split into:** P0.2.1',
      'P0.2: [split-slice] Split into must list exactly its nested children',
    ],
  ]) {
    const { errors } = parse(conforming.replace(before, after));
    assert.ok(
      errors.some((e) => e.includes(expected)),
      `${expected}: ${errors.join('\n')}`,
    );
  }
  assert.deepEqual(parse('# No plan').errors, [
    '§20: [plan-sections] missing delivery plan',
  ]);
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
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).nodes.length, 8);
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

test('bold-labeled acceptance bullets remain verbatim in draft issue bodies', () => {
  const bullet = '  - **Compatibility:** Existing APIs remain available.';
  const plan = parse(
    conforming.replace('  - Existing APIs remain available.', bullet),
  );
  assert.deepEqual(plan.errors, []);
  const node = plan.nodes.find((n) => n.ref === 'P0.1');
  assert.ok(node.fields.Acceptance.includes(bullet));
  assert.ok(node.body.includes(bullet));
});

test('slice headings at incorrect levels reject the entire plan', () => {
  for (const level of [1, 2, 3, 6]) {
    const plan = parse(
      conforming.replace(
        '#### P0.3 Describe storage API (XS)',
        `${'#'.repeat(level)} P0.3 Describe storage API (XS)`,
      ),
    );
    assert.ok(
      plan.errors.some(
        (error) =>
          error.includes('P0.3') && /slice heading|split level/.test(error),
      ),
      `${level}: ${plan.errors.join('\n')}`,
    );
  }
});

test('phase headings at incorrect levels cannot truncate the plan silently', () => {
  for (const level of [1, 2, 4, 5, 6]) {
    const plan = parse(
      conforming.replace(
        '### Phase 0: Contracts',
        `${'#'.repeat(level)} Phase 0: Contracts`,
      ),
    );
    assert.ok(
      plan.errors.some(
        (error) =>
          error.includes('Phase 0: Contracts') &&
          error.includes('phase heading must use three hashes'),
      ),
    );
  }
});

test('noncanonical lowercase blockers reject known, unknown and cyclic references', () => {
  for (const blocker of ['p0.1', 'p9.9', 'p0.2.1', 'P0.1, p9.9']) {
    const plan = parse(
      conforming.replace(
        '- **Blocked by:** P0.1',
        `- **Blocked by:** ${blocker}`,
      ),
    );
    assert.ok(
      plan.errors.includes(
        'P0.2: [blocked-by] Blocked by must be none or Plan IDs',
      ),
      blocker,
    );
  }
});

test('active phase titles mentioning backlog retain their epic and slices', () => {
  for (const title of ['Process the message backlog', 'Backlog processing']) {
    const text = conforming
      .replace('### Phase 0: Contracts', `### Phase 0: ${title}`)
      .replace(
        '### Phase 1: Backlog (not filed with v1)',
        `### Phase 2: Operations

**Goal:** Operators can verify storage.
**Exit criteria:** Verification succeeds.

#### P2.1 Verify storage (XS)

- **Blocked by:** none
- **Spec:** §3
- **Files:** \`scripts/verify.mjs\`
- **Provides:** Storage verification
- **Acceptance:**
  - Operators can verify storage.

### Phase 1: Backlog (not filed with v1)`,
      );
    const plan = parse(text);
    assert.deepEqual(plan.errors, []);
    assert.equal(
      plan.nodes.find((node) => node.ref === 'phase-0').title,
      title,
    );
    assert.ok(plan.nodes.some((node) => node.ref === 'P0.1'));
    assert.ok(plan.nodes.some((node) => node.ref === 'P2.1'));
    assert.deepEqual(plan.deferred, ['P1.1']);
    assert.ok(!plan.nodes.some((node) => node.ref === 'phase-1'));
  }
});

test('triager edges join leaf blockers, dependencies sections and the printed tree', () => {
  const plan = parse();
  assert.deepEqual(applyEdges(plan, 'EDGES | none'), []);
  assert.deepEqual(plan, parse());
  assert.deepEqual(
    applyEdges(
      plan,
      'EDGES | P0.3 <- P0.2.2: both edit the adapter; P0.3 <- P0.1: uses the port types',
    ),
    [],
  );
  const later = plan.nodes.find((n) => n.ref === 'P0.3');
  assert.deepEqual(later.blockedBy, ['P0.2.2', 'P0.1']);
  assert.match(later.body, /### Dependencies\n\nP0\.2\.2, P0\.1$/);
  assert.match(printTree(plan), /\| phase-0 \| P0\.2\.2, P0\.1 \|/);
  assert.deepEqual(applyEdges(plan, 'EDGES | P0.3 <- P0.1: repeated edge'), []);
  assert.deepEqual(later.blockedBy, ['P0.2.2', 'P0.1']);
});

test('malformed, unknown, non-leaf, self and cyclic triager edges leave the plan unchanged', () => {
  for (const [line, expected] of [
    ['P0.3 <- P0.1: no prefix', /expected "EDGES \|/],
    ['EDGES | P0.3 <- P0.1', /malformed edge/],
    ['EDGES | P0.3 <- P9.9: missing slice', /P9\.9 is not a leaf/],
    ['EDGES | P0.3 <- P0.2: container blocker', /P0\.2 is not a leaf/],
    ['EDGES | P0.3 <- P0.3: same leaf', /cannot block itself/],
    ['EDGES | P0.1 <- P0.2.1: closes the loop', /dependency cycle/],
    ['EDGES | P0.3 <- P0.1: fine; P0.1 <- P0.3: reversed', /dependency cycle/],
  ]) {
    const plan = parse();
    const errors = applyEdges(plan, line);
    assert.ok(
      errors.some((e) => expected.test(e)),
      `${line}: ${errors}`,
    );
    assert.deepEqual(plan, parse(), line);
  }
});

test('an edge onto a body without a trailing Dependencies section changes nothing', () => {
  const plan = parse();
  const later = plan.nodes.find((n) => n.ref === 'P0.3');
  later.body += '\n';
  const before = structuredClone(plan);
  assert.deepEqual(
    applyEdges(
      plan,
      'EDGES | P0.2.2 <- P0.2.1: reads the adapter; P0.3 <- P0.1: shares the port',
    ),
    ['EDGES: P0.3 body does not end with its Dependencies'],
  );
  assert.deepEqual(plan, before);
});

test('the edges CLI applies a triager line to saved drafts outside the repository', () => {
  const directory = mkdtempSync(join(tmpdir(), 'spec-to-issues-edges-'));
  const drafts = join(directory, 'drafts.json');
  const script = new URL('./spec-to-issues.mjs', import.meta.url).pathname;
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: directory },
    });
  const plan = run(
    'plan',
    new URL('./fixtures/spec-to-issues/conforming.md', import.meta.url)
      .pathname,
    '--output',
    drafts,
  );
  assert.equal(plan.status, 0, plan.stderr);
  const line = 'EDGES | P0.3 <- P0.1: both edit the contracts index';
  const preview = run('edges', drafts, line);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /\| phase-0 \| P0\.1 \|/);
  const triaged = join(directory, 'triaged.json');
  const saved = run('edges', drafts, line, '--output', triaged);
  assert.equal(saved.status, 0, saved.stderr);
  const node = JSON.parse(readFileSync(triaged, 'utf8')).nodes.find(
    (n) => n.ref === 'P0.3',
  );
  assert.deepEqual(node.blockedBy, ['P0.1']);
  assert.match(node.body, /### Dependencies\n\nP0\.1$/);
  const again = run('edges', drafts, line, '--output', triaged);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /EEXIST/);
  const bad = run(
    'edges',
    drafts,
    'EDGES | P0.3 <- P9.9: unknown',
    '--output',
    join(directory, 'bad.json'),
  );
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /P9\.9 is not a leaf/);
  assert.throws(() => readFileSync(join(directory, 'bad.json')), /ENOENT/);
});
