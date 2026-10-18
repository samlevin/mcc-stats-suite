import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  affectedRoots,
  applyResult,
  GATE_CONTEXT,
  updateGate,
} from './infrastructure-merge-gate.mjs';
import { runScript, workflow } from './workflow-test-helpers.mjs';

const config = parse(
  readFileSync(new URL('../.terrateam/config.yml', import.meta.url), 'utf8'),
);
const dev = 'infrastructure/dev/foundation';
const prod = 'infrastructure/prod/foundation';
const local = 'infrastructure/dev/local-cdk';
const bot = { login: 'terrateam-action[bot]', type: 'Bot' };
const success = (context) => ({ context, state: 'success', creator: bot });
const applies = (roots) =>
  [
    'terrateam apply',
    ...roots.map((root) => `terrateam apply: ${root} default`),
  ].map(success);
const releaseFiles = [
  '.release-please-manifest.json',
  'package-lock.json',
  ...['contracts', 'recipients', 'roster'].flatMap((name) => [
    `packages/${name}/package.json`,
    `packages/${name}/CHANGELOG.md`,
  ]),
  'applications/match-to-csv/package.json',
  'applications/match-to-csv/CHANGELOG.md',
];

test('release-only and ordinary noninfra changes succeed without any Terrateam status', () => {
  for (const paths of [
    releaseFiles,
    ['docs/guide.md'],
    ['applications/match-to-csv/src/handler.ts'],
  ]) {
    const roots = affectedRoots(paths, [config]);
    assert.deepEqual(roots, []);
    assert.equal(applyResult(roots, []).state, 'success');
  }
});

test('committed mappings select shared modules, environment roots, inputs and local templates', () => {
  for (const [path, expected] of [
    ['infrastructure/modules/foundation/recipients.tf', [dev, prod]],
    [`${dev}/main.tf`, [dev]],
    [`${prod}/.terraform.lock.hcl`, [prod]],
    [`${prod}/external-inputs.revision`, [prod]],
    [`${local}/bootstrap-template.json`, [local]],
    [`${local}/stack-policy.json`, [local]],
    ['.terrateam/config.yml', [dev, local, prod]],
    ['infrastructure/dev/bootstrap/main.tf', []],
    ['infrastructure/modules/foundation/tests/recipients.tftest.hcl', []],
  ])
    assert.deepEqual(affectedRoots([path], [config]), expected, path);
});

test('both base and proposed mappings protect removals and cover newly managed roots', () => {
  const changed = structuredClone(config);
  changed.dirs[dev].when_modified.file_patterns = ['!**/*'];
  changed.dirs[prod].when_modified.file_patterns = ['!**/*'];
  assert.deepEqual(
    affectedRoots(
      ['infrastructure/modules/foundation/main.tf'],
      [config, changed],
    ),
    [dev, prod],
  );
  const added = structuredClone(config);
  added.dirs['infrastructure/dev/new'] = {
    when_modified: { file_patterns: ['${DIR}/*.tf'] },
  };
  assert.deepEqual(
    affectedRoots(['infrastructure/dev/new/main.tf'], [config, added]),
    ['infrastructure/dev/new'],
  );
  assert.throws(
    () => affectedRoots(['infrastructure/dev/unmapped/main.tf'], [config]),
    /no explicit Terrateam mapping/,
  );
  assert.throws(() => affectedRoots(['a'], [{}]), /explicit Terrateam dirs/);
  const unsupported = structuredClone(config);
  unsupported.dirs[dev].when_modified.file_patterns = [
    'infrastructure/{a,b}/*.tf',
  ];
  assert.throws(
    () => affectedRoots(['a'], [unsupported]),
    /Unsupported Terrateam file pattern/,
  );
});

test('managed infrastructure requires aggregate and every applicable root apply on the same head', () => {
  assert.equal(applyResult([dev, prod], []).state, 'pending');
  assert.equal(
    applyResult([dev, prod], [success('terrateam apply')]).state,
    'pending',
  );
  assert.equal(applyResult([dev, prod], applies([dev])).state, 'pending');
  assert.equal(applyResult([dev, prod], applies([dev, prod])).state, 'success');
  assert.equal(applyResult([prod], applies([prod])).state, 'success');
  for (const state of ['pending', 'failure', 'error']) {
    const statuses = [
      { ...success(`terrateam apply: ${prod} default`), state },
      ...applies([dev, prod]),
    ];
    assert.equal(
      applyResult([dev, prod], statuses).state,
      state === 'pending' ? 'pending' : 'failure',
    );
  }
  const forged = applies([dev, prod]).map((status) => ({
    ...status,
    creator: { login: 'other-user', type: 'User' },
  }));
  assert.equal(applyResult([dev, prod], forged).state, 'pending');
  assert.equal(
    applyResult(
      [dev],
      [{ ...success('terrateam apply'), creator: null }, ...applies([dev])],
    ).state,
    'pending',
  );
});

function harness({
  paths = releaseFiles,
  statuses = [],
  eventName = 'pull_request_target',
  branch = 'release-please--branches--main',
  error,
  renamed,
  changedFiles,
  freshHead,
  freshBase,
} = {}) {
  const writes = [];
  const calls = [];
  const pr = {
    number: 277,
    state: 'open',
    changed_files: changedFiles ?? paths.length,
    base: { ref: 'main', sha: 'base' },
    head: { sha: 'head', ref: branch },
  };
  let reads = 0;
  const rest = {
    pulls: {
      get: async () => ({
        data:
          ++reads > 1
            ? {
                ...pr,
                head: { ...pr.head, sha: freshHead ?? pr.head.sha },
                base: { ...pr.base, sha: freshBase ?? pr.base.sha },
              }
            : pr,
      }),
      listFiles: 'files',
    },
    repos: {
      getContent: async ({ ref }) => {
        calls.push(['config', ref]);
        if (error) throw error;
        return {
          data: {
            encoding: 'base64',
            content: Buffer.from(JSON.stringify(config)).toString('base64'),
          },
        };
      },
      listCommitStatusesForRef: 'statuses',
      listPullRequestsAssociatedWithCommit: 'prs',
      createCommitStatus: async (status) => writes.push(status),
    },
  };
  const github = {
    rest,
    paginate: async (method, args) => {
      calls.push([method, args]);
      if (method === 'files')
        return paths.map((filename) => ({
          filename,
          ...(renamed ? { previous_filename: renamed } : {}),
        }));
      if (method === 'statuses') return statuses;
      if (method === 'prs')
        return [pr, { ...pr, number: 99, head: { sha: 'stale' } }];
      throw new Error('Unexpected pagination');
    },
  };
  const context = {
    eventName,
    repo: { owner: 'samlevin', repo: 'mcc-stats-suite' },
    payload: {
      pull_request: pr,
      sha: 'head',
      context: 'terrateam apply',
      inputs: { 'pull-request': '277' },
    },
  };
  const core = { error: () => {}, info: () => {} };
  return { github, context, core, writes, calls };
}

test('PR gate posts its own present success for release-only changes and never writes an apply result', async () => {
  const h = harness();
  await updateGate(h);
  assert.deepEqual(
    h.writes.map((s) => [s.sha, s.context, s.state]),
    [
      ['head', GATE_CONTEXT, 'pending'],
      ['head', GATE_CONTEXT, 'success'],
    ],
  );
  assert.equal(
    h.calls.some(([method]) => method === 'statuses'),
    false,
  );
  assert.deepEqual(
    h.calls.filter(([method]) => method === 'config'),
    [
      ['config', 'base'],
      ['config', 'head'],
    ],
  );
});

test('release branch name cannot exempt infrastructure; partial applies remain blocked', async () => {
  const h = harness({
    paths: ['infrastructure/modules/foundation/main.tf'],
    statuses: applies([dev]),
  });
  await updateGate(h);
  assert.equal(h.writes.at(-1).state, 'pending');
  assert.equal(
    h.calls.find(([method]) => method === 'statuses')[1].ref,
    'head',
  );
});

test('renames include the previous infrastructure path', async () => {
  const h = harness({ paths: ['docs/moved.md'], renamed: `${dev}/main.tf` });
  await updateGate(h);
  assert.equal(h.writes.at(-1).state, 'pending');
});

test('Terrateam status events reevaluate exact matching open PR heads without polling', async () => {
  const h = harness({
    paths: [`${dev}/main.tf`],
    statuses: applies([dev]),
    eventName: 'status',
  });
  await updateGate(h);
  assert.equal(h.writes.at(-1).state, 'success');
  assert.equal(h.writes.length, 2);
  const own = harness({ eventName: 'status' });
  own.context.payload.context = GATE_CONTEXT;
  await updateGate(own);
  assert.deepEqual(own.writes, []);
});

test('manual dispatch evaluates existing release PRs after rollout', async () => {
  const h = harness({ eventName: 'workflow_dispatch' });
  await updateGate(h);
  assert.equal(h.writes.at(-1).state, 'success');
});

test('API errors and incomplete file lists fail closed, and concurrent changes never publish success', async () => {
  for (const options of [
    { error: new Error('API failure') },
    { changedFiles: 999 },
    { paths: [] },
  ]) {
    const h = harness(options);
    await updateGate(h);
    assert.equal(h.writes.at(-1).state, 'failure');
  }
  for (const options of [
    { freshHead: 'new-head' },
    { freshBase: 'new-base' },
  ]) {
    const h = harness(options);
    await assert.rejects(updateGate(h), /changed during evaluation/);
    assert.deepEqual(
      h.writes.map((s) => s.state),
      ['pending'],
    );
  }
});

test('trusted workflow always evaluates PR changes and reacts to Terrateam statuses, with no PR checkout or executable content', async () => {
  const definition = workflow('ci-infrastructure-gate');
  assert.deepEqual(Object.keys(definition.on), [
    'pull_request_target',
    'status',
    'workflow_dispatch',
  ]);
  assert.deepEqual(definition.on.pull_request_target.branches, ['main']);
  assert.equal(definition.on.pull_request_target.paths, undefined);
  assert.equal(definition.on.pull_request_target['paths-ignore'], undefined);
  assert.deepEqual(definition.permissions, {
    contents: 'read',
    'pull-requests': 'read',
    statuses: 'write',
  });
  const steps = definition.jobs['evaluate-infrastructure'].steps;
  assert.match(steps[0].with.script, /state: 'pending'/);
  const checkout = steps.find((step) =>
    step.uses?.startsWith('actions/checkout@'),
  );
  assert.equal(
    checkout.with.ref,
    '${{ github.event.repository.default_branch }}',
  );
  assert.equal(checkout.with['persist-credentials'], false);
  assert.equal(steps.find((step) => step.run).run, 'npm ci --ignore-scripts');
  const h = harness();
  await runScript(steps[0].with.script, h);
  assert.equal(h.writes[0].state, 'pending');
  assert.equal(h.writes[0].sha, 'head');
});

test('apply prerequisites ignore only the circular gate while retaining CI, ordering, approval and lock protections', () => {
  assert.deepEqual(config.apply_requirements.checks, [
    {
      tag_query: '',
      approved: { enabled: false },
      merge_conflicts: { enabled: true },
      status_checks: {
        enabled: true,
        ignore_matching: [
          '^Require applicable Terrateam applies$',
          '^Evaluate infrastructure merge requirements$',
        ],
      },
    },
  ]);
  assert.equal(config.lock_policy, 'apply');
  assert.equal(config.automerge.require_explicit_apply, true);
  assert.deepEqual(config.dirs[prod].when_modified.depends_on, {
    tag_query: `dir:${dev}`,
  });
  assert.deepEqual(config.destination_branches, [
    {
      branch: 'main',
      source_branches: ['*', '!release-please--branches--main'],
    },
  ]);
  assert.deepEqual(
    config.access_control.policies.map(({ tag_query, apply }) => ({
      tag_query,
      apply,
    })),
    [
      {
        tag_query: 'dev',
        apply: ['role:write', 'role:maintain', 'role:admin'],
      },
      { tag_query: 'prod', apply: ['role:admin'] },
    ],
  );
});
