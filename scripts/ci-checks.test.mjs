import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  cpSync,
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
    '.github/workflows/ci.yml',
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
  ]);
  const commands = checks({ full: false, repository: true });
  assert.equal(commands.length, 4);
  assert.ok(!JSON.stringify(commands).match(/turbo|tofu|synth|bundle/));
  assert.ok(JSON.stringify(commands).includes('issue-triage.test.mjs'));
  assert.ok(JSON.stringify(commands).includes('branch-name.test.mjs'));
  assert.ok(JSON.stringify(commands).includes('agent-policy.test.mjs'));
  assert.deepEqual(commands[1], ['npm', ['run', 'agents:check']]);
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
  assert.deepEqual(
    commands.find(([command]) => command === 'node'),
    ['node', ['--test', ...buildTests()]],
  );
  assert.ok(!JSON.stringify(commands).includes('tofu'));
  assert.ok(!workspaceArguments('all').includes('--affected'));
  assert.ok(workspaceArguments('affected').includes('--affected'));
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
    '.github/workflows/pr-issue-metadata.yml',
    '.github/workflows/pr-issue-status.yml',
  ])
    assert.equal(classify(path), 'repository', path);
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
  // The full gate's eslint . already covers the automation scripts.
  assert.equal(both.filter(([, args]) => args[0] === 'eslint').length, 1);
});

test('checks overlap and any failing check rejects the gate after all checks settle', async () => {
  const started = [];
  const pending = [];
  const result = runChecks(
    [
      ['first', []],
      ['second', []],
    ],
    (command) => {
      started.push(command);
      return new Promise((resolve) => pending.push(resolve));
    },
  );
  assert.deepEqual(started, ['first', 'second']);
  pending[0](1);
  pending[1](0);
  await assert.rejects(result, /CI checks failed/);
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
    [staticTasks, 14],
    [bundleTasks, 8],
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
        .get(`@samlevin/${name}#ci:synth`)
        .dependencies.includes('@samlevin/cdk-config#build'),
    );
    // Tests run the sources and need only built dependencies, not the package's own build.
    assert.ok(
      !staticTasks
        .get(`@samlevin/${name}#ci:test`)
        .dependencies.includes(`@samlevin/${name}#build`),
    );
  }
  // cdk-config tests load the package's own dist.
  assert.ok(
    staticTasks
      .get('@samlevin/cdk-config#ci:test')
      .dependencies.includes('@samlevin/cdk-config#build'),
  );
  assert.ok(
    staticTasks
      .get('@samlevin/match-to-csv#ci:test')
      .dependencies.includes('@samlevin/contracts#build'),
  );
  assert.ok(
    bundleTasks
      .get('@samlevin/match-to-csv#ci:synth')
      .dependencies.includes('@samlevin/contracts#build'),
  );
  assert.deepEqual(
    bundleTasks.get('@samlevin/match-to-csv#verify:bundle').dependencies,
    ['@samlevin/match-to-csv#ci:synth'],
  );
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
  const jobs = loadWorkflow('ci').jobs;
  const text = (job) => JSON.stringify(job.steps);
  assert.ok(!text(jobs['application-checks']).includes('docker'));
  const steps = jobs['application-bundles'].steps;
  const pull = steps.findIndex((step) => step.run?.includes('docker pull'));
  assert.ok(
    pull >= 0 && pull < steps.findIndex((step) => step.run === 'npm ci'),
  );
  assert.equal(
    steps.find((step) => step.run === 'node scripts/ci-checks.mjs').env.CI_JOB,
    'bundle',
  );
});

test('actual Turbo affected selection includes shared consumers and skips unrelated applications', () => {
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
    ]) {
      mkdirSync(join(directory, workspace), { recursive: true });
      writeFileSync(
        join(directory, workspace, 'package.json'),
        readFileSync(new URL(`${workspace}/package.json`, root)),
      );
    }
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
        [`@samlevin/${name}`],
      ]),
      ['packages/contracts', ['@samlevin/contracts', '@samlevin/match-to-csv']],
      [
        'packages/cdk-config',
        [
          '@samlevin/cdk-config',
          ...applicationNames.map((name) => `@samlevin/${name}`),
        ],
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
            applicationNames.includes(name.replace('@samlevin/', '')),
          )
          .sort(),
      );
      git('revert', '--no-edit', head);
    }
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

test('workflow isolates cache namespaces and deploys dev and prod after CI', () => {
  const parsedWorkflow = loadWorkflow('ci');
  const workflow = readFileSync(
    new URL('../.github/workflows/ci.yml', import.meta.url),
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
    assert.equal(caches.length, name === 'infrastructure' ? 1 : 0, name);
  }
  const [providerCache] = parsedWorkflow.jobs.infrastructure.steps.filter(
    (step) => step.uses?.startsWith('actions/cache'),
  );
  assert.match(providerCache.with.key, /runner\.os.*runner\.arch/);
  assert.match(providerCache.with['restore-keys'], /runner\.os.*runner\.arch/);
  assert.deepEqual(parsedWorkflow.jobs.check.needs, [
    'scope',
    'infrastructure',
    'application-checks',
    'application-bundles',
  ]);
  assert.equal(parsedWorkflow.jobs.check.if, '${{ !cancelled() }}');
  // Job names are the required status-check contexts in the main ruleset.
  assert.equal(parsedWorkflow.jobs.check.name, undefined);
  const dev = readFileSync(
    new URL('../.github/workflows/deploy-dev.yml', import.meta.url),
    'utf8',
  );
  assert.match(dev, /workflows: \[ci\]/);
  assert.match(dev, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(dev, /_deliver-aws-application/);
  const prod = readFileSync(
    new URL(
      '../.github/workflows/_deliver-aws-application.yml',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(prod, /needs: dev/);
  assert.match(prod, /needs\.dev\.result == 'success'/);
  assert.match(prod, /environment: prod/);
  assert.ok(!workflow.includes('continue-on-error'));
  assert.ok(!workflow.includes('pull_request_target'));
  const config = JSON.parse(
    readFileSync(new URL('../turbo.json', import.meta.url)),
  );
  assert.equal(config.cacheDir, '.turbo/cache');
  assert.equal(config.tasks['ci:synth'].cache, false);
  assert.equal(config.tasks['verify:bundle'].cache, false);
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
  assert.match(action, /turbo-cache\/bucket-name/);
  assert.match(action, /turbo-cache\/data-key-arn/);
  assert.match(action, /s3-prefix: turbogha\/\$\{\{ inputs.environment \}\}/);
  assert.ok(!/max-age:|max-files:|max-size:/.test(action));
  assert.match(action, /AWS_SESSION_TOKEN=" >> "\$GITHUB_ENV/);
  const workflow = readFileSync(
    new URL(
      '../.github/workflows/_deploy-aws-application.yml',
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
      '_deploy-aws-application.yml deploy: Check out cache action from the qualified workflow revision',
      '_deploy-aws-application.yml deploy: Start environment Turbo cache',
      'ci.yml application-checks: Start trusted dev Turbo cache',
      'ci.yml application-bundles: Start trusted dev Turbo cache',
    ],
  );
  const context = (vars) => ({
    vars,
    github: { event_name: 'push', ref: 'refs/heads/main' },
    needs: { scope: { outputs: { full: 'true' } } },
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
        ['run', 'build', '--filter=@samlevin/contracts', '--dry=json'],
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
  const ciWorkflow = loadWorkflow('ci');
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
      ciWorkflow.jobs.scope.outputs[key],
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
      scope: {
        outputs: Object.fromEntries(
          Object.entries(expected).map(([key, value]) => [key, String(value)]),
        ),
      },
    };
    assert.equal(
      evaluate(ciWorkflow.jobs['application-checks'].if, { needs }),
      expected.check,
    );
    assert.equal(
      evaluate(ciWorkflow.jobs['application-bundles'].if, { needs }),
      expected.check && expected.full,
    );
    assert.equal(
      evaluate(ciWorkflow.jobs.infrastructure.if, { needs }),
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
    ciWorkflow.jobs.scope.steps.map((step) => step.uses?.split('@')[0]),
    ['actions/github-script'],
  );
  assert.match(
    ciWorkflow.jobs.scope.steps[0].uses,
    /^actions\/github-script@[a-f0-9]{40}$/,
  );
});

test('check aggregator requires exactly the selected gates', () => {
  const aggregator = loadWorkflow('ci').jobs.check.steps[0].run;
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
  const ciWorkflow = loadWorkflow('ci');
  const script = ciWorkflow.jobs.scope.steps[0].with.script;
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
  const job = loadWorkflow('ci').jobs.infrastructure;
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
