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
import ts from 'typescript';
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
    'tofu:fmt:check',
  ]) {
    assert.ok(JSON.stringify(commands).includes(command));
  }
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
        .get(`@mcc/${name}#ci:synth`)
        .dependencies.includes('@mcc/cdk-config#build'),
    );
    assert.ok(
      tasks
        .get(`@mcc/${name}#ci:test`)
        .dependencies.includes(`@mcc/${name}#build`),
    );
  }
  assert.ok(
    tasks
      .get('@mcc/match-to-csv#ci:synth')
      .dependencies.includes('@mcc/contracts#build'),
  );
  assert.deepEqual(tasks.get('@mcc/match-to-csv#verify:bundle').dependencies, [
    '@mcc/match-to-csv#ci:synth',
  ]);
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
        [`@mcc/${name}`],
      ]),
      ['packages/contracts', ['@mcc/contracts', '@mcc/match-to-csv']],
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

test('workflow isolates cache namespaces, retains ARM64, and gates main deployment', () => {
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
    /github\.event_name == 'push' && 'trusted-main' \|\| format\('pr-\{0\}'/,
  );
  assert.match(workflow, /uses: actions\/cache\/restore@v4/);
  assert.match(workflow, /uses: actions\/cache\/save@v4/);
  assert.match(workflow, /git show "\$BASE:scripts\/ci-scope\.mjs"/);
  assert.match(
    workflow,
    /deploy-dev:\n[ ]{4}if: github\.event_name == 'push'.*\n[ ]{4}needs: check/,
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
