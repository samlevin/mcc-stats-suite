import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  readFileSync,
  cpSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { classify, selectScopes } from './ci-scope.mjs';
import {
  evaluate,
  runScript,
  workflow as loadWorkflow,
} from './workflow-test-helpers.mjs';
import {
  checks,
  runChecks,
  workspaceMode,
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

test('root, infrastructure, unknown, and empty changes require every workspace', () => {
  for (const path of [
    'turbo.json',
    'package-lock.json',
    '.github/workflows/ci.yml',
    'scripts/ci-checks.mjs',
    'infrastructure/dev/foundation/main.tf',
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

test('documentation and recognized repository scopes avoid workspace and infrastructure commands', () => {
  assert.deepEqual(checks({ full: false, repository: false }), [
    ['npm', ['run', 'format:check']],
  ]);
  const commands = checks({ full: false, repository: true });
  assert.equal(commands.length, 3);
  assert.ok(!JSON.stringify(commands).match(/turbo|tofu|synth|bundle/));
  assert.ok(JSON.stringify(commands).includes('issue-triage.test.mjs'));
});

test('full gate contains repository checks and the dependency-aware workspace gate', () => {
  const commands = checks({ full: true, mode: 'all' });
  for (const command of [
    'format:check',
    'eslint',
    'release:check',
    'issue-triage.test.mjs',
    'ci-checks.test.mjs',
  ]) {
    assert.ok(JSON.stringify(commands).includes(command));
  }
  assert.ok(!JSON.stringify(commands).includes('tofu'));
  assert.ok(!workspaceArguments('all').includes('--affected'));
  assert.ok(workspaceArguments('affected').includes('--affected'));
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
  const plan = JSON.parse(
    execFileSync(turbo, [...workspaceArguments('all').slice(1), '--dry=json'], {
      cwd: root,
      encoding: 'utf8',
    }),
  );
  const tasks = new Map(plan.tasks.map((task) => [task.taskId, task]));
  assert.equal(
    plan.tasks.filter((task) => task.command !== '<NONEXISTENT>').length,
    27,
  );
  for (const name of applicationNames) {
    assert.ok(
      tasks
        .get(`@samlevin/${name}#ci:synth`)
        .dependencies.includes('@samlevin/cdk-config#build'),
    );
    assert.ok(
      tasks
        .get(`@samlevin/${name}#ci:test`)
        .dependencies.includes(`@samlevin/${name}#build`),
    );
  }
  assert.ok(
    tasks
      .get('@samlevin/match-to-csv#ci:synth')
      .dependencies.includes('@samlevin/contracts#build'),
  );
  assert.deepEqual(
    tasks.get('@samlevin/match-to-csv#verify:bundle').dependencies,
    ['@samlevin/match-to-csv#ci:synth'],
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
    /Start trusted dev Turbo cache\n[ ]+if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(workflow, /compareCommitsWithBasehead/);
  assert.match(workflow, /getContent\([\s\S]*scripts\/ci-scope\.mjs/);
  assert.match(workflow, /actions\/cache@v4/);
  assert.ok(
    !JSON.stringify(parsedWorkflow.jobs['application-checks'].steps).includes(
      'actions/cache@',
    ),
  );
  assert.match(
    workflow,
    /needs: \[scope, infrastructure, application-checks\]/,
  );
  assert.match(workflow, /if: \$\{\{ !cancelled\(\) \}\}/);
  assert.match(workflow, /select-deployment:/);
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
  assert.match(action, /rharkor\/caching-for-turbo@v2\.5\.1/);
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
  assert.ok(
    workflow.indexOf('Start environment Turbo cache') <
      workflow.indexOf('AWS_CDK_DEPLOY_ROLE_ARN'),
  );
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
        full: true,
        repository: false,
        infrastructure: true,
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
    assert.deepEqual(selectScopes(paths), expected);
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
      evaluate(ciWorkflow.jobs.infrastructure.if, { needs }),
      expected.infrastructure,
    );
  }
  assert.equal(
    classify('infrastructure/modules/foundation/tests/cache.tftest.hcl'),
    'infrastructure',
  );
  assert.equal(classify('infrastructure/.envrc.example'), 'full');
  assert.equal(classify('infrastructure/.tool-versions'), 'full');
  assert.equal(classify('infrastructure/dev/backend.tfvars.example'), 'full');
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
  assert.equal(ciWorkflow.jobs.scope.steps[1].uses, 'actions/github-script@v9');
  assert.match(ciWorkflow.jobs.scope.steps[0].uses, /^actions\/checkout@v4$/);
  assert.equal(
    ciWorkflow.jobs.scope.steps[0].if,
    "github.event_name == 'push'",
  );
  assert.equal(
    ciWorkflow.jobs.scope.steps[0].name,
    'Checkout files for push classification',
  );
  assert.match(ciWorkflow.jobs.scope.steps[1].with.script, /event === 'push'/);
  assert.match(ciWorkflow.jobs.scope.steps[1].with.script, /base, head, '--'/);
  assert.match(
    ciWorkflow.jobs.scope.steps[1].with.script,
    /supported entry point/,
  );
  assert.doesNotMatch(
    ciWorkflow.jobs.scope.steps[1].with.script,
    /source\.slice\(/,
  );
  const aggregator = ciWorkflow.jobs.check.steps[0].run;
  assert.ok(
    aggregator.includes('if [[ "$SCOPE_INFRASTRUCTURE" != false ]]; then'),
  );
  assert.ok(
    aggregator.includes('if [[ "$SCOPE_APPLICATIONS" != false ]]; then'),
  );
});

test('workflow executes gate selection for push, PR, retired baseline, and API failure', async () => {
  const ciWorkflow = loadWorkflow('ci');
  const script = ciWorkflow.jobs.scope.steps[1].with.script;
  const currentClassifier = readFileSync(
    new URL('./ci-scope.mjs', import.meta.url),
  );
  const oldRunnerTemp = process.env.RUNNER_TEMP;
  const run = async ({
    event = 'pull_request',
    paths = [],
    baseline = currentClassifier,
    apiError = false,
    fetchError = false,
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
            return { data: { files: paths.map((filename) => ({ filename })) } };
          },
          getContent: async () => ({
            data: { content: Buffer.from(baseline).toString('base64') },
          }),
        },
      },
    };
    const mockedRequire = (name) =>
      name === 'child_process'
        ? {
            execFileSync: (_command, args) => {
              if (args[0] === 'fetch' && fetchError)
                throw new Error('fetch unavailable');
              return args[0] === 'fetch' ? '' : paths.join('\0');
            },
          }
        : require(name);
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
  const failedFetch = await run({ event: 'push', fetchError: true });
  assert.equal(failedFetch.outputs.base, 'b'.repeat(40));
  assert.equal(failedFetch.outputs.infrastructure, true);
  assert.equal(failedFetch.outputs.check, true);
});

test('standalone infrastructure gate formats, validates all roots, and tests without credentials', () => {
  const ciWorkflow = loadWorkflow('ci');
  const job = ciWorkflow.jobs.infrastructure;
  assert.equal(
    job.steps.find((step) => step.name === 'Check OpenTofu roots').run,
    './scripts/tofu-checks.sh',
  );
  const commands = readFileSync(
    new URL('./tofu-checks.sh', import.meta.url),
    'utf8',
  );
  assert.match(commands, /tofu fmt -check -recursive infrastructure/);
  assert.doesNotMatch(JSON.stringify(job.steps), /tofu fmt -check/);
  assert.match(commands, /for environment in dev prod/);
  assert.match(commands, /for module in bootstrap foundation data-platform/);
  assert.match(commands, /init_args=\(-backend=false -input=false\)/);
  assert.match(commands, /tofu -chdir="\$root" validate/);
  assert.match(commands, /init_args\+=\(-test-directory="\$test_directory"\)/);
  assert.match(commands, /tofu -chdir="\$root" init "\$\{init_args\[@\]\}"/);
  assert.match(commands, /test -test-directory="\$test_directory"/);
  assert.equal(
    job.env.TF_PLUGIN_CACHE_DIR,
    '${{ github.workspace }}/.tofu-plugin-cache',
  );
  assert.doesNotMatch(job.env.TF_PLUGIN_CACHE_DIR, /runner\./);
  assert.ok(job.steps.some((step) => step.uses === 'actions/cache@v4'));
  assert.equal((commands.match(/tofu -chdir="\$root" init/g) || []).length, 1);
  assert.ok(
    !JSON.stringify(job).match(
      /id-token|configure-aws|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|secrets\./,
    ),
  );
  assert.equal(job.env.AWS_EC2_METADATA_DISABLED, 'true');
});
