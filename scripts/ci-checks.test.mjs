import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  cpSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { parse } from 'yaml';
import { classify, selectScopes, workspaceMode } from './ci-scope.mjs';
import {
  evaluate,
  runScript,
  workflow as loadWorkflow,
} from './workflow-test-helpers.mjs';
import {
  automationTests,
  buildTests,
  checks,
  runChecks,
  turboEnvironment,
  workspaceArguments,
} from './ci-checks.mjs';

const root = new URL('../', import.meta.url);
const turbo = new URL('../node_modules/.bin/turbo', import.meta.url).pathname;
const applicationNames = [
  'admin',
  'data-pipeline',
  'match-to-csv',
  'ocr-quality',
  'player',
];
const require = createRequire(import.meta.url);
// Script test files each command runs, directly or through `//#test:scripts`.
const testFiles = (commands) =>
  commands.flatMap(([command, args]) =>
    command === 'node'
      ? args.slice(1)
      : args.includes('test:scripts')
        ? buildTests()
        : [],
  );

for (const name of [
  ...applicationNames.map((name) => `applications/${name}`),
  'packages/contracts',
  'packages/cdk-config',
]) {
  test(`${name} selects affected PR tasks and complete main tasks`, () => {
    assert.equal(
      workspaceMode([`${name}/src/example.ts`], 'pull_request'),
      'affected',
    );
    assert.equal(workspaceMode([`${name}/src/example.ts`], 'push'), 'all');
  });
}

test('root, unknown, and empty changes require every workspace', () => {
  for (const path of [
    'turbo.json',
    'package-lock.json',
    '.github/workflows/ci-checks.yml',
    'scripts/ci-checks.mjs',
    'infrastructure/.tool-versions',
    'unexpected/file',
    'applications/unknown/src/file.ts',
    'packages/unknown/src/file.ts',
  ]) {
    assert.equal(workspaceMode([path], 'pull_request'), 'all');
    assert.equal(
      workspaceMode(
        ['applications/admin/src/example.ts', path],
        'pull_request',
      ),
      'all',
    );
  }
  assert.equal(workspaceMode([], 'pull_request'), 'all');
});

test('infrastructure and documentation paths keep affected workspace mode', () => {
  for (const path of [
    'infrastructure/dev/foundation/main.tf',
    'infrastructure/dev/backend.tfvars.example',
    'TESTING.md',
  ]) {
    assert.equal(
      workspaceMode(['packages/contracts/src/index.ts', path], 'pull_request'),
      'affected',
    );
    assert.equal(workspaceMode([path], 'pull_request'), 'all');
  }
});

test('documentation and recognized repository scopes avoid workspace and infrastructure commands', () => {
  assert.deepEqual(checks({ full: false, repository: false }), [
    ['npm', ['run', 'format:check']],
    ['npx', ['eslint', '**/*.md', '--max-warnings', '0']],
  ]);
  const commands = checks({ full: false, repository: true });
  assert.equal(commands.length, 4);
  assert.ok(!JSON.stringify(commands).match(/turbo|tofu|synth|bundle/));
  assert.ok(JSON.stringify(commands).includes('issue-triage.test.mjs'));
  assert.ok(JSON.stringify(commands).includes('branch-name.test.mjs'));
  assert.ok(JSON.stringify(commands).includes('agent-policy.test.mjs'));
  // One ESLint run covers the automation scripts and every Markdown file.
  const lint = commands.filter(([, args]) => args[0] === 'eslint');
  assert.equal(lint.length, 1);
  assert.deepEqual(lint[0][1].slice(-3), ['**/*.md', '--max-warnings', '0']);
  assert.ok(lint[0][1].includes('scripts/agent-policy.mjs'));
  assert.deepEqual(commands[2], ['npm', ['run', 'agents:check']]);
});

test('agent workflow sources and generated definitions select the repository scope', () => {
  for (const path of [
    '.agents/policy.json',
    '.agents/roles/implementer.md',
    '.agents/workflows/implement.md',
    '.agents/workflows/create-github-issue/references/github-operations.md',
    '.agents/skills/mcc-implement/SKILL.md',
    '.agents/skills/mcc-implement/agents/openai.yaml',
    '.claude/agents/mcc-implementer.md',
    '.claude/skills/mcc-implement/SKILL.md',
    '.codex/agents/mcc-implementer.toml',
    'scripts/agent-policy.mjs',
    'scripts/agent-policy.test.mjs',
  ])
    assert.equal(classify(path), 'repository', path);
  assert.equal(classify('.agents/README.md'), 'documentation');
  assert.equal(classify('.agents/issue-creation.md'), 'documentation');
  assert.equal(classify('.claude/settings.json'), 'full');
  const scopes = selectScopes(['.agents/roles/implementer.md'], 'pull_request');
  assert.equal(scopes.repository, true);
  assert.equal(scopes.full, false);
});

test('full gate contains repository checks and the dependency-aware workspace gate', () => {
  const commands = checks({ full: true, mode: 'all' });
  for (const command of ['format:check', 'eslint', 'release:check']) {
    assert.ok(JSON.stringify(commands).includes(command));
  }
  // Root script tests run through Turbo's cached `//#test:scripts`, never a bare
  // `node --test`.
  assert.ok(!commands.some(([command]) => command === 'node'));
  assert.deepEqual(testFiles(commands), buildTests());
  assert.ok(!JSON.stringify(commands).includes('tofu'));
  const [base, head] = ['a'.repeat(40), 'b'.repeat(40)];
  for (const job of ['static', 'bundle'])
    assert.ok(
      !workspaceArguments('all', job, base, head).some((argument) =>
        argument.startsWith('--filter'),
      ),
    );
  // `--affected` would drop the root task whenever only workspaces change.
  assert.deepEqual(
    workspaceArguments('affected', 'static', base, head).slice(-2),
    [`--filter=...[${base}...${head}]`, '--filter=//'],
  );
  assert.equal(
    workspaceArguments('affected', 'bundle', base, head).at(-1),
    `--filter=...[${base}...${head}]`,
  );
  assert.ok(!workspaceArguments('affected').includes('--affected'));
});

test('a new script test joins the full gate unless it is an automation test', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcc-ci-build-tests-'));
  try {
    for (const name of [
      'new-build-check.test.mjs',
      'new-build-check.mjs',
      'issue-triage.test.mjs',
    ])
      writeFileSync(join(directory, name), '');
    assert.deepEqual(buildTests(directory), [
      'scripts/new-build-check.test.mjs',
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Turbo streams prefixed lines instead of its own log groups', () => {
  for (const job of ['static', 'bundle'])
    for (const mode of ['all', 'affected'])
      assert.ok(workspaceArguments(mode, job).includes('--log-order=stream'));
  // Covers Turbo runs started through npm scripts, such as build:shared.
  assert.deepEqual(turboEnvironment('a'.repeat(40), 'b'.repeat(40)), {
    TURBO_SCM_BASE: 'a'.repeat(40),
    TURBO_SCM_HEAD: 'b'.repeat(40),
    TURBO_LOG_ORDER: 'stream',
  });
});

test('automation script tests run only in the repository scope', () => {
  const build = buildTests();
  assert.ok(build.includes('scripts/ci-checks.test.mjs'));
  assert.ok(build.includes('scripts/deployment-workflows.test.mjs'));
  for (const path of automationTests) {
    assert.ok(!build.includes(path), path);
    assert.equal(classify(path), 'repository', path);
    assert.equal(classify(path.replace('.test.mjs', '.mjs')), 'repository');
  }
  for (const path of [
    '.github/workflows/ci-pr-title.yml',
    '.github/workflows/ci-secret-scan.yml',
    '.github/workflows/tracker-issue-states.yml',
    '.github/workflows/tracker-pr-issue-status.yml',
    '.github/workflows/tracker-pr-metadata.yml',
    '.github/workflows/tracker-project-membership.yml',
  ])
    assert.equal(classify(path), 'repository', path);
  // Workflows that build, deploy, or release always run the full gate.
  for (const path of [
    '.github/workflows/ci-checks.yml',
    '.github/workflows/delivery-deploy-releases.yml',
    '.github/workflows/delivery-rollback.yml',
    '.github/workflows/_delivery-release-application.yml',
    '.github/workflows/_delivery-deploy-environment.yml',
    '.github/workflows/release-pr.yml',
  ])
    assert.equal(classify(path), 'full', path);
  const application = selectScopes(
    ['applications/match-to-csv/src/index.ts'],
    'pull_request',
  );
  assert.equal(application.repository, false);
  const full = JSON.stringify(checks({ full: true, mode: 'affected' }));
  for (const path of automationTests) assert.ok(!full.includes(path), path);
  const both = checks({ full: true, repository: true, mode: 'all' });
  assert.ok(
    both.some(
      ([command, args]) =>
        command === 'node' &&
        JSON.stringify(args) === JSON.stringify(['--test', ...automationTests]),
    ),
  );
  // The full gate's eslint . already covers the automation scripts and
  // Markdown.
  assert.deepEqual(
    both.filter(([, args]) => args[0] === 'eslint'),
    [['npx', ['eslint', '.', '--max-warnings', '0']]],
  );
});

test('shared CLI changes select build and automation checks', () => {
  for (const event of ['pull_request', 'push']) {
    const scopes = selectScopes(['scripts/cli.cjs'], event);
    assert.equal(scopes.full, true);
    assert.equal(scopes.repository, true);
    assert.equal(scopes.mode, 'all');
    const commands = checks(scopes);
    assert.ok(commands.some(([, args]) => args.includes('agents:check')));
    const tests = testFiles(commands);
    for (const path of [...automationTests, 'scripts/cli.test.mjs'])
      assert.equal(tests.filter((test) => test === path).length, 1, path);
  }
});

test('workflow timeout checks run once for repository and full scopes', () => {
  const runs = (paths) =>
    testFiles(checks(selectScopes(paths, 'pull_request'))).filter(
      (path) => path === 'scripts/workflow-timeouts.test.mjs',
    ).length;
  assert.ok(buildTests().includes('scripts/workflow-timeouts.test.mjs'));
  for (const path of [
    '.github/workflows/ci-pr-title.yml',
    '.github/workflows/ci-secret-scan.yml',
    '.github/workflows/tracker-pr-metadata.yml',
  ])
    assert.equal(runs([path]), 1, path);
  assert.equal(runs(['.github/workflows/ci-checks.yml']), 1);
  assert.equal(
    runs([
      '.github/workflows/tracker-pr-metadata.yml',
      '.github/workflows/ci-checks.yml',
    ]),
    1,
  );
});

test('repository-only workflow changes run the checkout credentials test', () => {
  for (const event of ['pull_request', 'push']) {
    const scopes = selectScopes(
      ['.github/workflows/ci-secret-scan.yml'],
      event,
    );
    assert.equal(scopes.full, false, event);
    assert.equal(scopes.repository, true, event);
    const tests = testFiles(checks(scopes));
    assert.ok(
      tests.includes('scripts/workflow-checkout-credentials.test.mjs'),
      event,
    );
  }
  const full = testFiles(checks({ full: true, repository: true, mode: 'all' }));
  assert.equal(
    full.filter(
      (path) => path === 'scripts/workflow-checkout-credentials.test.mjs',
    ).length,
    1,
  );
});

test('repository-only workflow changes run the pull_request_target test', () => {
  for (const event of ['pull_request', 'push']) {
    const scopes = selectScopes(
      ['.github/workflows/tracker-pr-metadata.yml'],
      event,
    );
    assert.equal(scopes.full, false, event);
    assert.equal(scopes.repository, true, event);
    const tests = testFiles(checks(scopes));
    assert.ok(
      tests.includes('scripts/workflow-pull-request-target.test.mjs'),
      event,
    );
  }
  const full = testFiles(checks({ full: true, repository: true, mode: 'all' }));
  assert.equal(
    full.filter(
      (path) => path === 'scripts/workflow-pull-request-target.test.mjs',
    ).length,
    1,
  );
});

test('automation consumer changes run CLI compatibility without workspace tasks', () => {
  for (const path of [
    'scripts/branch-name.mjs',
    'scripts/issue-triage.mjs',
    'scripts/issue-containers.mjs',
    'scripts/agent-policy.mjs',
  ]) {
    const scopes = selectScopes([path], 'pull_request');
    assert.equal(scopes.full, false, path);
    assert.equal(scopes.repository, true, path);
    const commands = checks(scopes);
    assert.ok(
      commands.some(
        ([command, args]) =>
          command === 'node' && args.includes('scripts/cli.test.mjs'),
      ),
      path,
    );
    const lint = commands.find(([, args]) => args[0] === 'eslint')[1];
    assert.ok(lint.includes('scripts/cli.cjs'), path);
    assert.ok(lint.includes('scripts/cli.test.mjs'), path);
    assert.ok(!JSON.stringify(commands).includes('turbo'), path);
  }
});

test('every scope that selects a setup-node workflow runs the Node version test', () => {
  for (const path of [
    '.github/workflows/tracker-pr-metadata.yml',
    '.github/workflows/ci-checks.yml',
    '.github/workflows/_delivery-deploy-environment.yml',
  ]) {
    const tests = testFiles(checks(selectScopes([path], 'pull_request')));
    assert.equal(
      tests.filter((test) => test === 'scripts/workflow-node-version.test.mjs')
        .length,
      1,
      path,
    );
  }
});

test('checks overlap and any failing check rejects the gate after all checks settle', async () => {
  const started = [];
  const pending = [];
  let settled = false;
  const result = runChecks(
    [
      ['first', []],
      ['second', []],
    ],
    (command) => {
      started.push(command);
      return new Promise((resolve) => pending.push(resolve));
    },
    () => {},
  ).finally(() => {
    settled = true;
  });
  assert.deepEqual(started, ['first', 'second']);
  pending[0]({ code: 1, output: '' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  pending[1]({ code: 0, output: '' });
  await assert.rejects(result, /CI checks failed/);
});

// Settles each fake check in the given order and records what the gate writes.
async function runFakeChecks(commands, results, order) {
  const pending = new Map();
  const log = [];
  const result = runChecks(
    commands,
    (command) => new Promise((resolve) => pending.set(command, resolve)),
    (text) => log.push(text),
  ).then(
    () => undefined,
    (error) => error,
  );
  for (const command of order) {
    pending.get(command)(results[command]);
    await new Promise((resolve) => setImmediate(resolve));
  }
  return { log: log.join(''), error: await result };
}

const fakeCommands = [
  ['format', ['run', 'format:check']],
  ['lint', ['.', '--max-warnings', '0']],
  ['test', ['--test', 'a.test.mjs']],
];

test('each check prints a start line outside any group, then its buffered output in one group named after its command, in completion order', async () => {
  const { log, error } = await runFakeChecks(
    fakeCommands,
    {
      format: { code: 0, output: 'format line 1\nformat line 2\n' },
      lint: { code: 0, output: 'lint output' },
      test: { code: 0, output: '' },
    },
    ['test', 'format', 'lint'],
  );
  assert.equal(error, undefined);
  assert.equal(
    log,
    [
      'Started format run format:check',
      'Started lint . --max-warnings 0',
      'Started test --test a.test.mjs',
      '::group::test --test a.test.mjs',
      '::endgroup::',
      '::group::format run format:check',
      'format line 1',
      'format line 2',
      '::endgroup::',
      '::group::lint . --max-warnings 0',
      'lint output',
      '::endgroup::',
      '',
    ].join('\n'),
  );
});

test('one failing check is named with its exit code after every check runs', async () => {
  const { log, error } = await runFakeChecks(
    fakeCommands,
    {
      format: { code: 0, output: 'formatted\n' },
      lint: { code: 1, output: 'lint error\n' },
      test: { code: 0, output: 'tests passed\n' },
    },
    ['lint', 'format', 'test'],
  );
  assert.equal(
    error?.message,
    '1 of 3 CI checks failed:\n  lint . --max-warnings 0 (exit code 1)',
  );
  for (const output of ['formatted', 'lint error', 'tests passed'])
    assert.match(log, new RegExp(output));
});

test('two failing checks are both named with their exit codes in command order', async () => {
  const { error } = await runFakeChecks(
    fakeCommands,
    {
      format: { code: 2, output: '' },
      lint: { code: 0, output: '' },
      test: { code: 1, output: '' },
    },
    ['test', 'lint', 'format'],
  );
  assert.equal(
    error?.message,
    [
      '2 of 3 CI checks failed:',
      '  format run format:check (exit code 2)',
      '  test --test a.test.mjs (exit code 1)',
    ].join('\n'),
  );
});

test('the default runner buffers stdout and stderr and reports a failed exit code', async () => {
  const log = [];
  const script =
    "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(3)";
  await assert.rejects(
    runChecks([[process.execPath, ['-e', script]]], undefined, (text) =>
      log.push(text),
    ),
    (error) => error.message.endsWith('(exit code 3)'),
  );
  const output = log.join('');
  assert.match(output, /^Started .+ -e .+\n::group::.+ -e /);
  assert.match(output, /out\n/);
  assert.match(output, /err\n/);
  assert.match(output, /::endgroup::\n$/);
});

test('Turbo dependency graph orders shared/own builds, synthesis, and native verification', () => {
  const dryRun = (job) =>
    new Map(
      JSON.parse(
        execFileSync(
          turbo,
          [...workspaceArguments('all', job).slice(1), '--dry=json'],
          { cwd: root, encoding: 'utf8' },
        ),
      ).tasks.map((task) => [task.taskId, task]),
    );
  const staticTasks = dryRun('static');
  const bundleTasks = dryRun('bundle');
  for (const [tasks, expected] of [
    [staticTasks, 18],
    [bundleTasks, 10],
  ]) {
    assert.equal(
      [...tasks.values()].filter((task) => task.command !== '<NONEXISTENT>')
        .length,
      expected,
    );
  }
  assert.ok(
    ![...staticTasks.keys()].some((id) => /synth|verify|typecheck/.test(id)),
  );
  assert.ok(
    ![...bundleTasks.keys()].some((id) => /#ci:test$|typecheck/.test(id)),
  );
  for (const name of applicationNames) {
    assert.ok(
      bundleTasks
        .get(`@mcc/${name}#ci:synth`)
        .dependencies.includes('@mcc/cdk-config#build'),
    );
    // Tests run the sources and need only built dependencies, not the package's own build.
    assert.ok(
      !staticTasks
        .get(`@mcc/${name}#ci:test`)
        .dependencies.includes(`@mcc/${name}#build`),
    );
  }
  // cdk-config tests load the package's own dist.
  assert.ok(
    staticTasks
      .get('@mcc/cdk-config#ci:test')
      .dependencies.includes('@mcc/cdk-config#build'),
  );
  assert.ok(
    staticTasks
      .get('@mcc/match-to-csv#ci:test')
      .dependencies.includes('@mcc/contracts#build'),
  );
  assert.ok(
    bundleTasks
      .get('@mcc/match-to-csv#ci:synth')
      .dependencies.includes('@mcc/contracts#build'),
  );
  // match-to-csv tests and bundles load @mcc/roster and @mcc/recipients from
  // their dist.
  for (const dependency of ['@mcc/roster#build', '@mcc/recipients#build']) {
    assert.ok(
      staticTasks
        .get('@mcc/match-to-csv#ci:test')
        .dependencies.includes(dependency),
    );
    assert.ok(
      bundleTasks
        .get('@mcc/match-to-csv#ci:synth')
        .dependencies.includes(dependency),
    );
  }
  assert.deepEqual(
    bundleTasks.get('@mcc/match-to-csv#verify:bundle').dependencies,
    ['@mcc/match-to-csv#ci:synth'],
  );
  // Root script tests load every shared package's dist and nothing else built.
  assert.deepEqual(staticTasks.get('//#test:scripts').dependencies, [
    '@mcc/cdk-config#build',
    '@mcc/contracts#build',
    '@mcc/recipients#build',
    '@mcc/roster#build',
  ]);
  assert.ok(!bundleTasks.has('//#test:scripts'));
});

test('root script tests miss the Turbo cache only when a declared input changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcc-ci-script-inputs-'));
  try {
    const git = (...args) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' });
    git('init', '-q');
    for (const name of [
      'package.json',
      'package-lock.json',
      'turbo.json',
      '.gitignore',
      ...applicationNames.map((name) => `applications/${name}/package.json`),
      ...['cdk-config', 'contracts', 'recipients', 'roster'].map(
        (name) => `packages/${name}/package.json`,
      ),
    ]) {
      mkdirSync(join(directory, name, '..'), { recursive: true });
      writeFileSync(join(directory, name), readFileSync(new URL(name, root)));
    }
    // Paths the root tests read, then paths outside the declared inputs.
    const inputs = [
      'scripts/example.test.mjs',
      '.github/workflows/example.yml',
      '.terrateam/config.yml',
      'infrastructure/dev/foundation/main.tf',
      'applications/admin/cdk/bin/admin.ts',
      'packages/contracts/src/index.ts',
      'docs/self-hosting/policies/example.json.template',
      'tsconfig.base.json',
      '.tool-versions',
    ];
    const outside = [
      'docs/example.md',
      'specs/example.md',
      '.agents/example.md',
      'README.md',
      // The lockfile and build dependencies cover installs and build output.
      'node_modules/ignored.js',
      'packages/contracts/dist/index.js',
      'packages/contracts/.turbo/turbo-build.log',
      'applications/admin/cdk.out/manifest.json',
    ];
    for (const path of [...inputs, ...outside]) {
      mkdirSync(join(directory, path, '..'), { recursive: true });
      writeFileSync(join(directory, path), '');
    }
    git('add', '.');
    const hash = () =>
      JSON.parse(
        execFileSync(turbo, ['run', 'test:scripts', '--dry=json'], {
          cwd: directory,
          encoding: 'utf8',
        }),
      ).tasks.find((task) => task.taskId === '//#test:scripts').hash;
    const original = hash();
    for (const path of [...inputs, ...outside]) {
      writeFileSync(join(directory, path), '// changed\n');
      assert.equal(hash() !== original, inputs.includes(path), path);
      writeFileSync(join(directory, path), '');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the bundle job is the only Docker job and runs only synthesis and verification', () => {
  assert.deepEqual(checks({ full: true, mode: 'all', job: 'bundle' }), [
    ['npx', workspaceArguments('all', 'bundle')],
  ]);
  assert.deepEqual(
    checks({ full: false, repository: true, job: 'bundle' }),
    [],
  );
  assert.ok(
    !JSON.stringify(checks({ full: true, mode: 'all' })).match(
      /synth|bundle|typecheck/,
    ),
  );
  const jobs = loadWorkflow('ci-checks').jobs;
  const text = (job) => JSON.stringify(job.steps);
  assert.ok(!text(jobs['check-workspaces']).includes('docker'));
  const steps = jobs['check-bundles'].steps;
  const pull = steps.findIndex((step) => step.run?.includes('docker pull'));
  assert.ok(
    pull >= 0 && pull < steps.findIndex((step) => step.run === 'npm ci'),
  );
  assert.equal(
    steps.find((step) => step.run === 'node scripts/ci-checks.mjs').env.CI_JOB,
    'bundle',
  );
});

test('CI synthesis transpiles only, and build type-checks every synthesized CDK app', () => {
  const jobs = loadWorkflow('ci-checks').jobs;
  for (const name of ['check-workspaces', 'check-bundles'])
    assert.equal(jobs[name].env.TS_NODE_TRANSPILE_ONLY, 'true', name);
  const turbo = JSON.parse(
    readFileSync(new URL('../turbo.json', import.meta.url)),
  );
  // Strict env mode drops variables Turbo does not pass through.
  assert.ok(turbo.globalPassThroughEnv.includes('TS_NODE_TRANSPILE_ONLY'));
  // Local synth, diff, and deploy keep ts-node type checking.
  const base = JSON.parse(
    readFileSync(new URL('../tsconfig.base.json', import.meta.url)),
  );
  assert.equal(base['ts-node'], undefined);
  const applications = new URL('../applications/', import.meta.url);
  const apps = readdirSync(applications).filter((app) =>
    existsSync(new URL(`${app}/cdk.json`, applications)),
  );
  assert.ok(apps.length > 0);
  for (const app of apps) {
    const read = (name) =>
      JSON.parse(readFileSync(new URL(`${app}/${name}`, applications)));
    assert.equal(read('package.json').scripts.build, 'tsc -p tsconfig.json');
    const { include } = read('tsconfig.json');
    assert.ok(include.includes('cdk/**/*.ts'), app);
    const tests = readdirSync(new URL(`${app}/test/`, applications));
    if (tests.some((name) => name.endsWith('.ts')))
      assert.ok(include.includes('test/**/*.ts'), app);
  }
});

test('actual Turbo selects affected consumers and invalidates caches for shared CLI changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcc-ci-selection-'));
  try {
    const git = (...args) =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=CI Test',
          '-c',
          'user.email=ci@example.invalid',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd: directory, encoding: 'utf8' },
      ).trim();
    // An independent fixture repository avoids moving any real worktree branch.
    git('init', '-q');
    for (const name of [
      'package.json',
      'package-lock.json',
      'turbo.json',
      '.gitignore',
    ]) {
      writeFileSync(join(directory, name), readFileSync(new URL(name, root)));
    }
    for (const workspace of [
      ...applicationNames.map((name) => `applications/${name}`),
      'packages/contracts',
      'packages/cdk-config',
      // The root script tests depend on these builds.
      'packages/roster',
      'packages/recipients',
    ]) {
      mkdirSync(join(directory, workspace), { recursive: true });
      writeFileSync(
        join(directory, workspace, 'package.json'),
        readFileSync(new URL(`${workspace}/package.json`, root)),
      );
    }
    mkdirSync(join(directory, 'scripts'));
    const cli = join(directory, 'scripts/cli.cjs');
    writeFileSync(cli, '// CLI fixture\n');
    git('add', '.');
    git(
      '-c',
      'user.name=CI Test',
      '-c',
      'user.email=ci@example.invalid',
      'commit',
      '-qm',
      'fixture',
    );
    const base = git('rev-parse', 'HEAD');
    for (const [workspace, expected] of [
      ...applicationNames.map((name) => [
        `applications/${name}`,
        [`@mcc/${name}`],
      ]),
      [
        'packages/contracts',
        [
          '@mcc/contracts',
          '@mcc/match-to-csv',
          '@mcc/recipients',
          '@mcc/roster',
        ],
      ],
      [
        'packages/cdk-config',
        ['@mcc/cdk-config', ...applicationNames.map((name) => `@mcc/${name}`)],
      ],
    ]) {
      writeFileSync(
        join(directory, workspace, 'selection-fixture.txt'),
        workspace,
      );
      git('add', '.');
      git(
        '-c',
        'user.name=CI Test',
        '-c',
        'user.email=ci@example.invalid',
        'commit',
        '-qm',
        'change',
      );
      const head = git('rev-parse', 'HEAD');
      const plan = JSON.parse(
        execFileSync(turbo, ['run', 'typecheck', '--affected', '--dry=json'], {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head },
        }),
      );
      assert.deepEqual(
        plan.tasks
          .filter((task) => task.task === 'typecheck')
          .map((task) => task.package)
          .sort(),
        expected.sort(),
      );
      // The static job's explicit range selects the same workspaces and adds
      // the root script tests.
      const staticPlan = JSON.parse(
        execFileSync(
          turbo,
          [
            ...workspaceArguments('affected', 'static', base, head).slice(1),
            '--dry=json',
          ],
          { cwd: directory, encoding: 'utf8' },
        ),
      ).tasks.filter((task) => task.command !== '<NONEXISTENT>');
      assert.deepEqual(
        staticPlan
          .filter((task) => task.task === 'ci:test')
          .map((task) => task.package)
          .sort(),
        expected.sort(),
      );
      assert.ok(
        staticPlan.some((task) => task.taskId === '//#test:scripts'),
        workspace,
      );
      const deploymentPlan = JSON.parse(
        execFileSync(turbo, ['run', 'cdk:deploy', '--affected', '--dry=json'], {
          cwd: directory,
          encoding: 'utf8',
          env: { ...process.env, TURBO_SCM_BASE: base, TURBO_SCM_HEAD: head },
        }),
      );
      assert.deepEqual(
        deploymentPlan.tasks
          .filter(
            (task) =>
              task.task === 'cdk:deploy' && task.command !== '<NONEXISTENT>',
          )
          .map((task) => task.package)
          .sort(),
        expected
          .filter((name) =>
            applicationNames.includes(name.replace('@mcc/', '')),
          )
          .sort(),
      );
      git('revert', '--no-edit', head);
    }
    const cliConsumerHashes = () =>
      JSON.parse(
        execFileSync(
          turbo,
          [
            'run',
            'build',
            'ci:test',
            '--filter=@mcc/match-to-csv',
            '--dry=json',
          ],
          { cwd: directory, encoding: 'utf8' },
        ),
      ).tasks.filter((task) => task.package === '@mcc/match-to-csv');
    const before = cliConsumerHashes();
    assert.deepEqual(before.map((task) => task.task).sort(), [
      'build',
      'ci:test',
    ]);
    writeFileSync(cli, '// Changed CLI fixture\n');
    const after = cliConsumerHashes();
    for (const task of before)
      assert.notEqual(
        task.hash,
        after.find(({ taskId }) => taskId === task.taskId).hash,
        task.taskId,
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CI cdk-config tests cannot invoke another compiler or modify built declarations', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mcc-ci-readonly-tests-'));
  try {
    const manifest = JSON.parse(
      readFileSync(
        new URL('../packages/cdk-config/package.json', import.meta.url),
      ),
    );
    writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest));
    cpSync(
      new URL('../packages/cdk-config/test', import.meta.url),
      join(directory, 'test'),
      { recursive: true },
    );
    mkdirSync(join(directory, 'dist'));
    const compiled = ts.transpileModule(
      readFileSync(
        new URL('../packages/cdk-config/src/index.ts', import.meta.url),
        'utf8',
      ),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          target: ts.ScriptTarget.ES2022,
        },
      },
    );
    writeFileSync(join(directory, 'dist/index.js'), compiled.outputText);
    writeFileSync(
      join(directory, 'dist/index.d.ts'),
      '// Already built declarations\n',
    );
    mkdirSync(join(directory, 'bin'));
    // Any script-level compiler bypasses Turbo's tracked build and fails this test.
    writeFileSync(join(directory, 'bin/tsc'), '#!/bin/sh\nexit 91\n', {
      mode: 0o755,
    });
    const snapshot = () =>
      ['index.js', 'index.d.ts'].map((name) => ({
        content: readFileSync(join(directory, 'dist', name), 'utf8'),
        modified: statSync(join(directory, 'dist', name), { bigint: true })
          .mtimeNs,
      }));
    const before = snapshot();
    execFileSync('npm', ['run', 'ci:test'], {
      cwd: directory,
      env: {
        ...process.env,
        PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
      },
    });
    assert.deepEqual(snapshot(), before);
    assert.match(manifest.scripts.test, /npm run build/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow isolates cache namespaces and keeps validation independent of releases', () => {
  const parsedWorkflow = loadWorkflow('ci-checks');
  const workflow = readFileSync(
    new URL('../.github/workflows/ci-checks.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /runs-on: ubuntu-24\.04-arm/);
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/,
  );
  assert.match(workflow, /format\('push-\{0\}', github\.run_id\)/);
  assert.match(
    workflow,
    /Start trusted dev Turbo cache\n(?:[ ]+#.*\n)?[ ]+if: vars\.MCC_TURBO_CACHE == 'true' && github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
  );
  // Only the infrastructure job restores a generic cache, keyed to its own
  // provider binaries; every other job uses isolated caches.
  for (const [name, job] of Object.entries(parsedWorkflow.jobs)) {
    const caches = job.steps.filter((step) =>
      step.uses?.startsWith('actions/cache'),
    );
    assert.equal(caches.length, name === 'check-infrastructure' ? 1 : 0, name);
  }
  const [providerCache] = parsedWorkflow.jobs[
    'check-infrastructure'
  ].steps.filter((step) => step.uses?.startsWith('actions/cache'));
  assert.match(providerCache.with.key, /runner\.os.*runner\.arch/);
  assert.match(providerCache.with['restore-keys'], /runner\.os.*runner\.arch/);
  const gate = parsedWorkflow.jobs['require-scoped-checks'];
  assert.deepEqual(gate.needs, [
    'detect-changes',
    'check-infrastructure',
    'check-workspaces',
    'check-bundles',
  ]);
  assert.equal(gate.if, '${{ !cancelled() }}');
  // Job names are the required status-check contexts in the main ruleset.
  assert.equal(gate.name, 'Require every check selected for the changed files');
  assert.equal(parsedWorkflow.jobs['select-applications'], undefined);
  assert.ok(
    !Object.values(parsedWorkflow.jobs).some((job) =>
      job.uses?.includes('deploy'),
    ),
  );
  assert.ok(!workflow.includes('continue-on-error'));
  assert.ok(!workflow.includes('pull_request_target'));
  const config = JSON.parse(
    readFileSync(new URL('../turbo.json', import.meta.url)),
  );
  assert.equal(config.cacheDir, '.turbo/cache');
  assert.equal(config.tasks['ci:synth'].cache, false);
  assert.equal(config.tasks['verify:bundle'].cache, false);
});

test('only the delivery workflows call the reusable deploy workflows', () => {
  // CI and release runs never deploy, so only real deploys post Slack deploy
  // messages.
  const directory = new URL('../.github/workflows/', import.meta.url);
  const callers = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) =>
      Object.entries(
        parse(readFileSync(new URL(name, directory), 'utf8')).jobs ?? {},
      )
        .filter(([, job]) => job.uses?.startsWith('./.github/workflows/'))
        .map(([id, job]) => `${name} ${id} -> ${job.uses.split('/').at(-1)}`),
    )
    .sort();
  assert.deepEqual(callers, [
    '_delivery-release-application.yml deploy-dev -> _delivery-deploy-environment.yml',
    '_delivery-release-application.yml deploy-prod -> _delivery-deploy-environment.yml',
    'delivery-deploy-releases.yml deliver-applications -> _delivery-release-application.yml',
    'delivery-rollback.yml rollback-prod -> _delivery-deploy-environment.yml',
  ]);
});

test('cache uses dedicated session credentials and environment contracts without cleanup', () => {
  const action = readFileSync(
    new URL('../.github/actions/turbo-s3-cache/action.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    action,
    /uses: rharkor\/caching-for-turbo@[a-f0-9]{40} # v2\.5\.1\s*$/m,
  );
  assert.match(action, /provider: s3/);
  for (const [input, output] of [
    ['s3-access-key-id', 'aws-access-key-id'],
    ['s3-secret-access-key', 'aws-secret-access-key'],
    ['s3-session-token', 'aws-session-token'],
  ]) {
    assert.ok(
      action.includes(
        input + ': ${{ steps.credentials.outputs.' + output + ' }}',
      ),
    );
  }
  assert.match(action, /allowed-account-ids:/);
  assert.match(action, /aws sts get-caller-identity/);
  // CI contracts stay outside /mcc/<environment>/, which holds only application config.
  assert.match(
    action,
    /"\/mcc-ci\/\$CACHE_ENVIRONMENT\/turbo-cache\/bucket-name"/,
  );
  assert.match(
    action,
    /"\/mcc-ci\/\$CACHE_ENVIRONMENT\/turbo-cache\/data-key-arn"/,
  );
  assert.ok(!action.includes('/mcc/'));
  assert.match(action, /s3-prefix: turbogha\/\$\{\{ inputs.environment \}\}/);
  assert.ok(!/max-age:|max-files:|max-size:/.test(action));
  assert.match(action, /AWS_SESSION_TOKEN=" >> "\$GITHUB_ENV/);
  const workflow = readFileSync(
    new URL(
      '../.github/workflows/_delivery-deploy-environment.yml',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    workflow,
    /MCC_BUILD_ENVIRONMENT: \$\{\{ inputs.environment \}\}/,
  );
  assert.match(workflow, /ref: \$\{\{ github.workflow_sha \}\}/);
  assert.match(workflow, /npx turbo run build --filter=/);
  assert.ok(workflow.includes('role-to-assume: arn:aws:iam::'));
  assert.ok(
    workflow.indexOf('Start environment Turbo cache') <
      workflow.indexOf('role-to-assume: arn:aws:iam::'),
  );
});

test('Turbo cache steps run only in repositories that opt in', () => {
  // Find cache steps by what they do, so a new or renamed step cannot slip
  // past the MCC_TURBO_CACHE gate.
  const directory = new URL('../.github/workflows/', import.meta.url);
  const steps = readdirSync(directory)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) =>
      Object.entries(
        parse(readFileSync(new URL(name, directory), 'utf8')).jobs ?? {},
      ).flatMap(([job, { steps = [] }]) =>
        steps
          .filter(
            (step) =>
              step.uses?.endsWith('/actions/turbo-s3-cache') ||
              step.with?.path === '.cache-workflow',
          )
          .map((step) => ({ id: `${name} ${job}: ${step.name}`, step })),
      ),
    );
  assert.deepEqual(
    steps.map(({ id }) => id),
    [
      '_delivery-deploy-environment.yml deploy: Check out cache action from the qualified workflow revision',
      '_delivery-deploy-environment.yml deploy: Start environment Turbo cache',
      'ci-checks.yml check-workspaces: Start trusted dev Turbo cache',
      'ci-checks.yml check-bundles: Start trusted dev Turbo cache',
    ],
  );
  const context = (vars) => ({
    vars,
    github: { event_name: 'push', ref: 'refs/heads/main' },
    needs: { 'detect-changes': { outputs: { full: 'true' } } },
    steps: { 'version-guard': { outputs: { deploy: 'true' } } },
  });
  for (const { id, step } of steps) {
    assert.equal(typeof step.if, 'string', id);
    assert.ok(!step.if.includes('${{'), id);
    assert.equal(
      evaluate(step.if, context({ MCC_TURBO_CACHE: 'true' })),
      true,
      id,
    );
    for (const vars of [{}, { MCC_TURBO_CACHE: 'false' }]) {
      assert.equal(evaluate(step.if, context(vars)), false, id);
    }
  }
});

test('same revision has separate dev and prod Turbo task hashes', () => {
  const plan = (environment) =>
    JSON.parse(
      execFileSync(
        turbo,
        ['run', 'build', '--filter=@mcc/contracts', '--dry=json'],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, MCC_BUILD_ENVIRONMENT: environment },
        },
      ),
    );
  const dev = plan('dev');
  const prod = plan('prod');
  assert.notEqual(dev.tasks[0].hash, prod.tasks[0].hash);
  assert.equal(dev.tasks[0].hash, plan('dev').tasks[0].hash);
});

test('classifier selects independent infrastructure and application gates', () => {
  const ciWorkflow = loadWorkflow('ci-checks');
  for (const key of [
    'full',
    'repository',
    'infrastructure',
    'check',
    'mode',
    'base',
    'head',
  ]) {
    assert.equal(
      ciWorkflow.jobs['detect-changes'].outputs[key],
      '${{ steps.scope.outputs.' + key + ' }}',
    );
  }
  for (const [paths, expected] of [
    [
      ['infrastructure/dev/foundation/main.tf'],
      { full: false, repository: false, infrastructure: true, check: false },
    ],
    [
      // Prettier formats the Terrateam config, so it keeps the full gate too.
      ['.terrateam/config.yml'],
      { full: true, repository: false, infrastructure: true, check: true },
    ],
    [
      ['infrastructure/dev/foundation/backend.tfvars'],
      {
        full: false,
        repository: false,
        infrastructure: true,
        check: false,
      },
    ],
    [
      ['applications/match-to-csv/src/index.ts'],
      {
        full: true,
        repository: false,
        infrastructure: false,
        check: true,
      },
    ],
    [
      [
        'infrastructure/prod/bootstrap/main.tf',
        'packages/contracts/src/index.ts',
      ],
      {
        full: true,
        repository: false,
        infrastructure: true,
        check: true,
      },
    ],
    [
      ['infrastructure/README.md'],
      {
        full: false,
        repository: false,
        infrastructure: false,
        check: true,
      },
    ],
    [
      [
        'infrastructure/.envrc.example',
        'infrastructure/dev/backend.tfvars.example',
      ],
      {
        full: false,
        repository: false,
        infrastructure: false,
        check: true,
      },
    ],
    [
      [],
      {
        full: true,
        repository: false,
        infrastructure: true,
        check: true,
      },
    ],
  ]) {
    const { mode, ...gates } = selectScopes(paths, 'pull_request');
    assert.deepEqual(gates, expected);
    assert.equal(mode, workspaceMode(paths, 'pull_request'));
    const needs = {
      'detect-changes': {
        outputs: Object.fromEntries(
          Object.entries(expected).map(([key, value]) => [key, String(value)]),
        ),
      },
    };
    assert.equal(
      evaluate(ciWorkflow.jobs['check-workspaces'].if, { needs }),
      expected.check,
    );
    assert.equal(
      evaluate(ciWorkflow.jobs['check-bundles'].if, { needs }),
      expected.check && expected.full,
    );
    assert.equal(
      evaluate(ciWorkflow.jobs['check-infrastructure'].if, { needs }),
      expected.infrastructure,
    );
  }
  assert.equal(
    classify('infrastructure/modules/foundation/tests/cache.tftest.hcl'),
    'infrastructure',
  );
  assert.equal(classify('infrastructure/.envrc.example'), 'documentation');
  assert.equal(classify('infrastructure/.tool-versions'), 'full');
  assert.equal(
    classify('infrastructure/dev/backend.tfvars.example'),
    'documentation',
  );
  for (const environment of ['dev', 'prod']) {
    assert.equal(
      classify(
        `infrastructure/${environment}/foundation/external-inputs.revision`,
      ),
      'documentation',
    );
  }
  assert.equal(
    classify('infrastructure/dev/foundation/other.revision'),
    'full',
  );
  // The local bootstrap freshness test is a full-gate script test.
  for (const path of [
    'infrastructure/dev/local-cdk/bootstrap-template.json',
    'infrastructure/dev/local-cdk/stack-policy.json',
    'scripts/local-cdk-bootstrap.mjs',
    'scripts/cdk-targets.mjs',
    'package-lock.json',
  ]) {
    assert.equal(classify(path), 'full', path);
  }
  assert.ok(buildTests().includes('scripts/local-cdk-bootstrap.test.mjs'));
  assert.equal(classify('.terrateam/config.yml'), 'full');
  assert.equal(classify('.terrateam/other.yml'), 'full');
  assert.equal(
    classify('applications/match-to-csv/src/index.ts'),
    'application',
  );
  assert.equal(classify('applications/unknown-app/src/index.ts'), 'full');
  assert.deepEqual(ciWorkflow.on, {
    pull_request: null,
    push: { branches: ['main'] },
  });
  // Classification needs no checkout; the compare API serves pushes and PRs.
  assert.deepEqual(
    ciWorkflow.jobs['detect-changes'].steps.map(
      (step) => step.uses?.split('@')[0],
    ),
    ['actions/github-script'],
  );
  assert.match(
    ciWorkflow.jobs['detect-changes'].steps[0].uses,
    /^actions\/github-script@[a-f0-9]{40}$/,
  );
});

test('check aggregator requires exactly the selected gates', () => {
  const aggregator =
    loadWorkflow('ci-checks').jobs['require-scoped-checks'].steps[0].run;
  const passes = (env) => {
    try {
      execFileSync('bash', ['-euo', 'pipefail', '-c', aggregator], {
        env: { ...process.env, ...env },
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };
  for (const scope of ['success', 'failure'])
    for (const infrastructure of ['true', 'false'])
      for (const applications of ['true', 'false'])
        for (const infrastructureResult of ['success', 'failure', 'skipped'])
          for (const applicationsResult of ['success', 'failure', 'skipped'])
            for (const full of ['true', 'false'])
              for (const bundlesResult of ['success', 'failure', 'skipped'])
                assert.equal(
                  passes({
                    SCOPE_RESULT: scope,
                    SCOPE_INFRASTRUCTURE: infrastructure,
                    SCOPE_APPLICATIONS: applications,
                    SCOPE_FULL: full,
                    INFRASTRUCTURE_RESULT: infrastructureResult,
                    APPLICATIONS_RESULT: applicationsResult,
                    BUNDLES_RESULT: bundlesResult,
                  }),
                  scope === 'success' &&
                    (infrastructure === 'false' ||
                      infrastructureResult === 'success') &&
                    (applications === 'false' ||
                      (applicationsResult === 'success' &&
                        (full === 'false' || bundlesResult === 'success'))),
                );
});

test('workflow executes gate selection for push, PR, retired baseline, and API failure', async () => {
  const ciWorkflow = loadWorkflow('ci-checks');
  const script = ciWorkflow.jobs['detect-changes'].steps[0].with.script;
  const currentClassifier = readFileSync(
    new URL('./ci-scope.mjs', import.meta.url),
  );
  const oldRunnerTemp = process.env.RUNNER_TEMP;
  const run = async ({
    event = 'pull_request',
    paths = [],
    baseline = currentClassifier,
    apiError = false,
    fileCount,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), 'mcc-scope-script-'));
    process.env.RUNNER_TEMP = directory;
    const outputs = {};
    const warnings = [];
    const github = {
      rest: {
        repos: {
          compareCommitsWithBasehead: async () => {
            if (apiError) throw new Error('comparison unavailable');
            const files = fileCount
              ? Array.from({ length: fileCount }, (_, index) => ({
                  filename: `docs/${index}.md`,
                }))
              : paths.map((filename) => ({ filename }));
            return {
              data: { files, merge_base_commit: { sha: 'c'.repeat(40) } },
            };
          },
          getContent: async () => ({
            data: { content: Buffer.from(baseline).toString('base64') },
          }),
        },
      },
    };
    const mockedRequire = (name) => {
      assert.notEqual(name, 'child_process');
      return require(name);
    };
    const context = {
      eventName: event,
      repo: { owner: 'owner', repo: 'repo' },
      sha: 'b'.repeat(40),
      payload: {
        before: 'a'.repeat(40),
        pull_request: {
          base: { sha: 'a'.repeat(40) },
          head: { sha: 'b'.repeat(40) },
        },
      },
    };
    try {
      await runScript(script, {
        require: mockedRequire,
        context,
        github,
        core: {
          setOutput: (name, value) => {
            outputs[name] = value;
          },
          warning: (message) => warnings.push(message),
        },
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
      if (oldRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
      else process.env.RUNNER_TEMP = oldRunnerTemp;
    }
    return { outputs, warnings };
  };

  const infra = await run({ paths: ['infrastructure/dev/foundation/main.tf'] });
  assert.deepEqual(
    [
      infra.outputs.full,
      infra.outputs.repository,
      infra.outputs.infrastructure,
      infra.outputs.check,
    ],
    [false, false, true, false],
  );
  assert.equal(infra.outputs.base, 'c'.repeat(40));
  const affected = await run({
    paths: ['packages/contracts/src/index.ts', 'TESTING.md'],
  });
  assert.equal(affected.outputs.mode, 'affected');
  assert.equal(affected.outputs.base, 'c'.repeat(40));
  const pushAffected = await run({
    event: 'push',
    paths: ['packages/contracts/src/index.ts'],
  });
  assert.equal(pushAffected.outputs.mode, 'all');
  const truncated = await run({ fileCount: 300 });
  assert.equal(truncated.outputs.full, true);
  assert.equal(truncated.outputs.check, true);
  assert.equal(truncated.outputs.mode, 'all');
  assert.equal(truncated.outputs.base, 'b'.repeat(40));
  assert.match(truncated.warnings.join('\n'), /file list limit/);
  const push = await run({ event: 'push', paths: ['scripts/ci-scope.mjs'] });
  assert.deepEqual(
    [
      push.outputs.full,
      push.outputs.repository,
      push.outputs.infrastructure,
      push.outputs.check,
    ],
    [true, false, true, true],
  );
  const retired = await run({ baseline: 'export function classify() {}' });
  assert.deepEqual(
    [
      retired.outputs.full,
      retired.outputs.repository,
      retired.outputs.infrastructure,
      retired.outputs.check,
    ],
    [true, true, true, true],
  );
  assert.match(retired.warnings.join('\n'), /supported entry point/);
  const constExport = await run({
    paths: ['infrastructure/dev/foundation/main.tf'],
    baseline: String(currentClassifier).replace(
      'export function selectScopes(paths, event) {',
      'export const selectScopes = function (paths, event) {',
    ),
  });
  assert.equal(constExport.outputs.check, false);
  assert.equal(constExport.outputs.infrastructure, true);
  const failed = await run({ apiError: true });
  assert.deepEqual(
    [
      failed.outputs.full,
      failed.outputs.repository,
      failed.outputs.infrastructure,
      failed.outputs.check,
    ],
    [true, true, true, true],
  );
  assert.match(failed.warnings.join('\n'), /comparison unavailable/);
  assert.equal(failed.outputs.mode, 'all');
  assert.equal(failed.outputs.base, 'b'.repeat(40));
  const failedPush = await run({ event: 'push', apiError: true });
  assert.equal(failedPush.outputs.base, 'b'.repeat(40));
  assert.equal(failedPush.outputs.infrastructure, true);
  assert.equal(failedPush.outputs.check, true);
});

test('standalone infrastructure gate runs without credentials', () => {
  const job = loadWorkflow('ci-checks').jobs['check-infrastructure'];
  assert.ok(job.steps.some((step) => step.run === './scripts/tofu-checks.sh'));
  assert.ok(
    job.steps.some((step) =>
      step.run?.includes('tofu-checks.sh --pinned-version'),
    ),
  );
  assert.equal(
    job.env.TF_PLUGIN_CACHE_DIR,
    '${{ github.workspace }}/.tofu-plugin-cache',
  );
  assert.ok(
    !JSON.stringify(job).match(
      /id-token|configure-aws|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|secrets\./,
    ),
  );
  assert.equal(job.env.AWS_EC2_METADATA_DISABLED, 'true');
});

test('tofu checks discover every root and module suite and require agreeing pins', () => {
  const script = new URL('./tofu-checks.sh', import.meta.url).pathname;
  const setup = ({
    pins = ['1.2.3', '1.2.3', '1.2.3'],
    orphan = false,
  } = {}) => {
    const directory = mkdtempSync(join(tmpdir(), 'mcc-tofu-checks-'));
    const write = (path, content) => {
      mkdirSync(join(directory, path, '..'), { recursive: true });
      writeFileSync(join(directory, path), content);
    };
    write('.tool-versions', `nodejs 22.16.0\nopentofu ${pins[0]}\n`);
    write('infrastructure/.tool-versions', `opentofu ${pins[1]}\n`);
    write(
      '.terrateam/config.yml',
      `engine:\n  name: tofu\n  version: ${pins[2]}\n\nother:\n  version: 9.9.9\n`,
    );
    for (const environment of ['dev', 'prod', 'qa'])
      for (const module of ['alpha', 'beta'])
        write(`infrastructure/${environment}/${module}/main.tf`, '');
    write('infrastructure/modules/alpha/tests/a.tftest.hcl', '');
    write('infrastructure/modules/beta/main.tf', '');
    if (orphan) write('infrastructure/modules/gamma/tests/g.tftest.hcl', '');
    write('bin/tofu', '#!/usr/bin/env bash\necho "$*" >> "$TOFU_LOG"\n');
    execFileSync('chmod', ['+x', join(directory, 'bin/tofu')]);
    return directory;
  };
  const run = (directory, args = []) =>
    execFileSync('bash', [script, ...args], {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${join(directory, 'bin')}:${process.env.PATH}`,
        TOFU_LOG: join(directory, 'tofu.log'),
        TF_PLUGIN_CACHE_DIR: join(directory, 'plugins'),
      },
    });

  const directory = setup();
  try {
    assert.equal(run(directory, ['--pinned-version']).trim(), '1.2.3');
    run(directory);
    const calls = readFileSync(join(directory, 'tofu.log'), 'utf8')
      .trim()
      .split('\n');
    assert.equal(calls[0], 'fmt -check -recursive infrastructure');
    for (const environment of ['dev', 'prod', 'qa'])
      for (const module of ['alpha', 'beta']) {
        const root = `-chdir=infrastructure/${environment}/${module}`;
        const suite =
          environment === 'dev' && module === 'alpha'
            ? ' -test-directory=../../modules/alpha/tests'
            : '';
        assert.ok(
          calls.includes(
            `${root} init -backend=false -input=false -lockfile=readonly${suite}`,
          ),
        );
        assert.ok(calls.includes(`${root} validate`));
      }
    assert.deepEqual(
      calls.filter((call) => call.includes(' test ')),
      [
        '-chdir=infrastructure/dev/alpha test -test-directory=../../modules/alpha/tests',
      ],
    );
    assert.ok(!calls.some((call) => call.includes('infrastructure/modules/')));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  for (const options of [
    { pins: ['1.2.3', '1.2.4', '1.2.3'] },
    { pins: ['1.2.3', '1.2.3', '1.2.4'] },
    { orphan: true },
  ]) {
    const failing = setup(options);
    try {
      assert.throws(() => run(failing));
    } finally {
      rmSync(failing, { recursive: true, force: true });
    }
  }
});
