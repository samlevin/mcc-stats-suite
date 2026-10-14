import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import {
  FOUNDATION_ROOTS,
  affectedRoots,
  assertOrder,
  ciStatus,
  main,
} from './apply-foundation.mjs';

const config = readFileSync(
  new URL('../.terrateam/config.yml', import.meta.url),
  'utf8',
);
const terrateam = parse(config);
// Fake values only; tests never call AWS or GitHub.
const ACCOUNTS = { dev: '000000000000', prod: '111111111111' };

test('root selection follows the foundation file_patterns in .terrateam/config.yml', () => {
  const cases = [
    [['infrastructure/modules/foundation/main.tf'], ['dev', 'prod']],
    [['.terrateam/config.yml'], ['dev', 'prod']],
    [['infrastructure/dev/foundation/main.tf'], ['dev']],
    [['infrastructure/dev/foundation/.terraform.lock.hcl'], ['dev']],
    [['infrastructure/prod/foundation/prod.tfvars'], ['prod']],
    [
      [
        'infrastructure/prod/foundation/main.tf',
        'infrastructure/dev/foundation/main.tf',
      ],
      ['dev', 'prod'],
    ],
    [['infrastructure/modules/foundation/tests/storage.tftest.hcl'], []],
    [['infrastructure/dev/foundation/nested/main.tf'], []],
    [['infrastructure/dev/foundation/backend.hcl.example'], []],
    [['infrastructure/dev/bootstrap/main.tf'], []],
    [['infrastructure/modules/bootstrap/main.tf'], []],
    [['infrastructure/prod/data-platform/main.tf'], []],
    [['infrastructure/modules/data-platform/main.tf'], []],
    [['README.md', 'scripts/apply-foundation.mjs'], []],
  ];
  for (const [files, roots] of cases)
    assert.deepEqual(affectedRoots(terrateam, files), roots, files.join(', '));
});

test('only the two foundation roots can ever be selected', () => {
  const everything = {
    dirs: {
      'infrastructure/dev/bootstrap': {
        tags: ['dev', 'foundation'],
        when_modified: { file_patterns: ['**/*'] },
      },
      'infrastructure/prod/data-platform': {
        tags: ['prod', 'foundation'],
        when_modified: { file_patterns: ['**/*'] },
      },
      ...Object.fromEntries(
        Object.entries(FOUNDATION_ROOTS).map(([environment, dir]) => [
          dir,
          {
            tags: [environment, 'foundation'],
            when_modified: { file_patterns: ['${DIR}/*.tf'] },
          },
        ]),
      ),
    },
  };
  assert.deepEqual(
    affectedRoots(everything, ['infrastructure/dev/bootstrap/main.tf']),
    [],
  );
  assert.deepEqual(Object.values(FOUNDATION_ROOTS), [
    'infrastructure/dev/foundation',
    'infrastructure/prod/foundation',
  ]);
  const missing = structuredClone(terrateam);
  delete missing.dirs['infrastructure/prod/foundation'];
  assert.throws(
    () => affectedRoots(missing, []),
    /no file_patterns for infrastructure\/prod\/foundation/,
  );
  const mistagged = structuredClone(terrateam);
  mistagged.dirs['infrastructure/dev/foundation'].tags = ['prod', 'foundation'];
  assert.throws(() => affectedRoots(mistagged, []), /does not tag/);
});

test('prod waits for dev only when dev is part of the run', () => {
  assert.throws(
    () => assertOrder({ roots: ['dev', 'prod'], applied: {} }, 'prod'),
    /prod depends on dev/,
  );
  assertOrder({ roots: ['dev', 'prod'], applied: { dev: 'now' } }, 'prod');
  assertOrder({ roots: ['prod'], applied: {} }, 'prod');
  assertOrder({ roots: ['dev', 'prod'], applied: {} }, 'dev');
});

test('CI status ignores Terrateam checks and reports failures and pending checks', () => {
  assert.deepEqual(
    ciStatus([
      { name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'lint', status: 'IN_PROGRESS', conclusion: '' },
      { context: 'legacy', state: 'PENDING' },
      { name: 'terrateam plan', status: 'COMPLETED', conclusion: 'FAILURE' },
    ]),
    { total: 4, failed: ['build'], pending: ['lint', 'legacy'] },
  );
});

// A fake checkout, GitHub, AWS, and OpenTofu. Every command the script runs
// lands in `calls`; nothing leaves the process.
function harness(options = {}) {
  const base = mkdtempSync(join(tmpdir(), 'apply-foundation-'));
  const checkout = join(base, 'repo');
  mkdirSync(join(checkout, 'infrastructure/dev/foundation'), {
    recursive: true,
  });
  mkdirSync(join(checkout, 'infrastructure/prod/foundation'), {
    recursive: true,
  });
  const world = {
    head: 'a'.repeat(40),
    live: undefined,
    files: ['infrastructure/modules/foundation/main.tf'],
    behind: '',
    rollup: [{ name: 'check', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    prStates: {},
    callerAccount: (profile) =>
      ({ 'mcc-dev-admin': ACCOUNTS.dev, 'my-prod': ACCOUNTS.prod })[profile],
    planStatus: 2,
    applyStatus: 0,
    mergeStatus: 0,
    plans: 0,
    resolved: {},
    ...options,
  };
  const worktrees = new Map();
  const calls = [];
  const variables = (environment) => ({
    [`${environment.toUpperCase()}_TOFU_STATE_BUCKET`]: `state-${environment}`,
    [`${environment.toUpperCase()}_AWS_REGION`]: 'us-east-2',
    [`${environment.toUpperCase()}_MCC_EMAIL_DOMAIN`]: `${environment}.example.test`,
    [`${environment.toUpperCase()}_TERRATEAM_ROLE_ARN`]: `arn:aws:iam::${ACCOUNTS[environment]}:role/terrateam`,
  });
  const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
  const fail = (stderr = 'failed') => ({ status: 1, stdout: '', stderr });
  const run = (command, args, options = {}) => {
    calls.push({ command, args, options });
    const joined = args.join(' ');
    if (command === 'git') {
      if (args.includes('--git-common-dir')) return ok(`${checkout}/.git\n`);
      if (joined.endsWith('remote get-url origin'))
        return ok('git@github.com:example/repo.git\n');
      if (args[2] === 'rev-parse')
        return worktrees.has(args[1])
          ? ok(`${worktrees.get(args[1])}\n`)
          : fail();
      if (args[2] === 'merge-base') return ok(`${'b'.repeat(40)}\n`);
      if (args[2] === 'diff' && args.includes('origin/main'))
        return ok(world.behind);
      if (args[2] === 'diff') return ok(`${world.files.join('\n')}\n`);
      if (args[2] === 'show') return ok(config);
      if (args[2] === 'worktree' && args[3] === 'add') {
        mkdirSync(args[6], { recursive: true });
        worktrees.set(args[6], args[7]);
        return ok();
      }
      if (args[2] === 'worktree' && args[3] === 'remove') {
        worktrees.delete(args[5]);
        rmSync(args[5], { recursive: true, force: true });
        return ok();
      }
      return ok();
    }
    if (command === 'gh') {
      if (args[0] === 'variable') {
        const environment = args.includes('-e')
          ? args[args.indexOf('-e') + 1].replace('infra/foundation-', '')
          : undefined;
        const value =
          environment === undefined
            ? { MCC_GITHUB_OIDC_SUBJECT_REPOSITORY: 'example@1/repo@2' }[
                args[2]
              ]
            : variables(environment)[args[2]];
        return value ? ok(`${value}\n`) : fail('variable not found');
      }
      if (
        args[0] === 'pr' &&
        args[1] === 'view' &&
        joined.includes('headRefOid -q')
      )
        return ok(`${world.live ?? world.head}\n`);
      if (args[0] === 'pr' && args[1] === 'view' && joined.includes('state -q'))
        return ok(`${world.prStates[args[2]] ?? 'OPEN'}\n`);
      if (args[0] === 'pr' && args[1] === 'view')
        return ok(
          JSON.stringify({
            number: Number(args[2]),
            title: 'feat(infrastructure): change the foundation',
            state: 'OPEN',
            isDraft: false,
            baseRefName: 'main',
            headRefOid: world.live ?? world.head,
            mergeable: 'MERGEABLE',
            statusCheckRollup: world.rollup,
          }),
        );
      if (args[0] === 'pr' && args[1] === 'merge')
        return world.mergeStatus === 0 ? ok() : fail('required check');
    }
    if (command === 'aws') {
      const account = world.callerAccount(options.env.AWS_PROFILE);
      return account ? ok(`${account}\n`) : fail('expired');
    }
    if (command === 'tofu') {
      if (args[0] === 'init') return ok('initialized');
      if (args[0] === 'plan') {
        world.plans += 1;
        const out = args.find((arg) => arg.startsWith('-out=')).slice(5);
        writeFileSync(out, `plan ${world.plans}`);
        return { status: world.planStatus, stdout: 'planned', stderr: '' };
      }
      if (args[0] === 'show' && args[1] === '-json')
        return ok(
          JSON.stringify({
            resource_changes: [
              {
                address: 'module.foundation.aws_s3_bucket.x',
                change: { actions: ['update'] },
              },
            ],
          }),
        );
      if (args[0] === 'show') return ok('plan text');
      if (args[0] === 'apply')
        return world.applyStatus === 0 ? ok('applied') : fail('apply failed');
    }
    if (command === 'direnv') {
      if (args[0] === 'allow') return ok();
      const dir = args[1];
      const name = args[4].match(/\$(\w+)/)[1];
      const file = join(dir, '.envrc');
      const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const value =
        [...text.matchAll(new RegExp(`^export ${name}="(.*)"$`, 'gm'))].at(
          -1,
        )?.[1] ?? '';
      return ok(world.resolved[name] ?? value);
    }
    throw new Error(`Unexpected command: ${command} ${joined}`);
  };
  const lines = [];
  const env = {
    PATH: process.env.PATH,
    MCC_INFRA_APPLY_STATE: join(base, 'state'),
    MCC_PROD_INFRA_PROFILE: 'my-prod',
    AWS_ACCESS_KEY_ID: 'ambient-key',
    AWS_SECRET_ACCESS_KEY: 'ambient-secret',
    AWS_PROFILE: 'ambient-profile',
    TF_VAR_email_domain: 'ambient.example.test',
    TF_CLI_ARGS_apply: '-auto-approve',
  };
  const cli = (...args) => {
    lines.length = 0;
    main(args, { run, env, cwd: checkout, out: (line) => lines.push(line) });
    return [...lines];
  };
  const stateDir = join(base, 'state', 'foundation');
  const digest = (environment) =>
    JSON.parse(
      readFileSync(join(stateDir, 'pr-12', 'state.json'), 'utf8'),
    ).plans[environment].digest.slice(0, 12);
  return { world, calls, cli, checkout, stateDir, digest };
}

test('a module change plans and applies dev, then prod, then merges', () => {
  const { world, calls, cli, stateDir, digest } = harness();
  const preflight = cli('preflight', '#12');
  assert.ok(
    preflight.includes(
      'Roots:   infrastructure/dev/foundation, infrastructure/prod/foundation',
    ),
  );
  assert.ok(
    calls.some(
      (call) =>
        call.command === 'git' &&
        call.args.join(' ').includes(`fetch -q origin main refs/pull/12/head`),
    ),
  );

  assert.throws(() => cli('plan', '12', 'prod'), /prod depends on dev/);
  const devPlan = cli('plan', '12', 'dev');
  assert.ok(devPlan.includes('Result:  changes'));
  assert.ok(devPlan.includes('  update: module.foundation.aws_s3_bucket.x'));
  assert.ok(devPlan.includes(`Digest:  ${digest('dev')}`));

  const tofuCalls = calls.filter((call) => call.command === 'tofu');
  const init = tofuCalls.find((call) => call.args[0] === 'init');
  assert.ok(init.args.includes('-lockfile=readonly'));
  assert.ok(init.args.includes('-backend-config=bucket=state-dev'));
  assert.match(
    init.options.cwd,
    /pr-12\/src\/infrastructure\/dev\/foundation$/,
  );
  for (const call of tofuCalls) {
    assert.equal(call.options.env.AWS_PROFILE, 'mcc-dev-admin');
    assert.equal(call.options.env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(call.options.env.AWS_SECRET_ACCESS_KEY, undefined);
    assert.equal(call.options.env.TF_CLI_ARGS_apply, undefined);
    assert.equal(call.options.env.TF_VAR_email_domain, 'dev.example.test');
    assert.equal(
      call.options.env.TF_VAR_github_oidc_subject_repository,
      'example@1/repo@2',
    );
  }
  const awsCalls = calls.filter((call) => call.command === 'aws');
  assert.equal(awsCalls.length, 1);
  assert.equal(awsCalls[0].options.env.AWS_ACCESS_KEY_ID, undefined);

  assert.throws(
    () => cli('apply', '12', 'prod', 'x'.repeat(12)),
    /prod depends on dev/,
  );
  assert.throws(() => cli('apply', '12', 'dev'), /Pass the digest/);
  assert.throws(
    () => cli('apply', '12', 'dev', 'f'.repeat(12)),
    /does not match/,
  );
  assert.throws(() => cli('merge', '12'), /dev has not applied/);
  assert.deepEqual(cli('apply', '12', 'dev', digest('dev')), [
    `Applied: infrastructure/dev/foundation at ${world.head}`,
  ]);
  const applyCall = calls.findLast((call) => call.command === 'tofu');
  assert.equal(applyCall.args[0], 'apply');
  assert.match(applyCall.args.at(-1), /pr-12\/dev\.tfplan$/);
  assert.equal(
    readFileSync(
      join(stateDir, 'locks', 'infrastructure_dev_foundation'),
      'utf8',
    ),
    '12',
  );

  const prodPlan = cli('plan', '12', 'prod');
  assert.ok(prodPlan[0].includes('(profile my-prod)'));
  const prodInit = calls.findLast(
    (call) => call.command === 'tofu' && call.args[0] === 'init',
  );
  assert.equal(prodInit.options.env.AWS_PROFILE, 'my-prod');
  assert.ok(prodInit.args.includes('-backend-config=bucket=state-prod'));
  assert.equal(prodInit.options.env.TF_VAR_email_domain, 'prod.example.test');
  cli('apply', '12', 'prod', digest('prod'));

  const merged = cli('merge', '12');
  assert.deepEqual(merged, [
    'Merged PR #12 as "feat(infrastructure): change the foundation (#12)"',
  ]);
  const mergeCall = calls.findLast((call) => call.command === 'gh');
  assert.deepEqual(mergeCall.args, [
    'pr',
    'merge',
    '12',
    '--squash',
    '--subject',
    'feat(infrastructure): change the foundation (#12)',
    '--match-head-commit',
    world.head,
    '-R',
    'example/repo',
  ]);
  assert.ok(
    !existsSync(join(stateDir, 'locks', 'infrastructure_dev_foundation')),
  );
  assert.ok(
    !existsSync(join(stateDir, 'locks', 'infrastructure_prod_foundation')),
  );
  assert.ok(
    !calls.some((call) =>
      call.args.some((arg) => /bootstrap|data-platform/.test(arg)),
    ),
  );
});

test('a prod-only change applies prod without a dev layer', () => {
  const { cli, digest } = harness({
    files: ['infrastructure/prod/foundation/main.tf'],
  });
  assert.ok(
    cli('preflight', '12').includes('Roots:   infrastructure/prod/foundation'),
  );
  assert.throws(
    () => cli('plan', '12', 'dev'),
    /does not change the dev foundation/,
  );
  cli('plan', '12', 'prod');
  cli('apply', '12', 'prod', digest('prod'));
  cli('merge', '12');
});

test('a PR outside the foundation roots has nothing to plan', () => {
  for (const file of [
    'infrastructure/dev/bootstrap/main.tf',
    'infrastructure/prod/data-platform/main.tf',
    'infrastructure/modules/foundation/tests/a.tftest.hcl',
  ]) {
    const { cli } = harness({ files: [file] });
    assert.throws(() => cli('preflight', '12'), /nothing to plan/, file);
  }
});

test('preflight refuses failing CI and branches behind main', () => {
  assert.throws(
    () =>
      harness({
        rollup: [{ name: 'check', status: 'COMPLETED', conclusion: 'FAILURE' }],
      }).cli('preflight', '12'),
    /CI failed: check/,
  );
  assert.throws(
    () => harness({ rollup: [] }).cli('preflight', '12'),
    /no CI checks yet/,
  );
  assert.throws(
    () =>
      harness({ behind: 'infrastructure/modules/foundation/kms.tf\n' }).cli(
        'preflight',
        '12',
      ),
    /behind main on infrastructure files/,
  );
});

test('a wrong account stops the run before any OpenTofu command', () => {
  const { calls, cli } = harness({ callerAccount: () => ACCOUNTS.prod });
  cli('preflight', '12');
  assert.throws(
    () => cli('plan', '12', 'dev'),
    /mcc-dev-admin belongs to a different account than DEV_TERRATEAM_ROLE_ARN/,
  );
  assert.ok(!calls.some((call) => call.command === 'tofu'));
});

test('a new head voids earlier plans and approvals', () => {
  const { world, cli, digest } = harness();
  cli('preflight', '12');
  cli('plan', '12', 'dev');
  const reviewed = digest('dev');
  world.live = 'c'.repeat(40);
  assert.throws(() => cli('apply', '12', 'dev', reviewed), /head moved/);
  assert.throws(() => cli('plan', '12', 'dev'), /head moved/);
  const again = cli('preflight', '12');
  assert.ok(
    again.includes(
      'Head changed since the last preflight; discarding earlier plans',
    ),
  );
  assert.throws(() => cli('apply', '12', 'dev', reviewed), /No saved dev plan/);
});

test('a re-plan voids the digest the person reviewed', () => {
  const { cli, digest } = harness();
  cli('preflight', '12');
  cli('plan', '12', 'dev');
  const reviewed = digest('dev');
  cli('plan', '12', 'dev');
  assert.throws(() => cli('apply', '12', 'dev', reviewed), /does not match/);
});

test('a failed apply keeps the root locked to the PR', () => {
  const { world, cli, digest, stateDir } = harness();
  cli('preflight', '12');
  cli('plan', '12', 'dev');
  world.applyStatus = 1;
  assert.throws(
    () => cli('apply', '12', 'dev', digest('dev')),
    /stays locked to PR #12/,
  );
  assert.equal(
    readFileSync(
      join(stateDir, 'locks', 'infrastructure_dev_foundation'),
      'utf8',
    ),
    '12',
  );
  assert.throws(() => cli('merge', '12'), /dev has not applied/);
});

test('another PR that applied a root holds it until that PR merges', () => {
  const { world, cli, stateDir } = harness();
  mkdirSync(join(stateDir, 'locks'), { recursive: true });
  writeFileSync(join(stateDir, 'locks', 'infrastructure_dev_foundation'), '7');
  assert.throws(() => cli('preflight', '12'), /locked by PR #7 \(OPEN\)/);
  world.prStates['7'] = 'MERGED';
  cli('preflight', '12');
  assert.ok(
    !existsSync(join(stateDir, 'locks', 'infrastructure_dev_foundation')),
  );
});

test('status, unlock, and cleanup manage only local state', () => {
  const { cli, digest, stateDir } = harness();
  assert.deepEqual(cli('status', '12'), ['PR #12: no local run']);
  cli('preflight', '12');
  cli('plan', '12', 'dev');
  cli('apply', '12', 'dev', digest('dev'));
  const status = cli('status', '12');
  assert.match(status[2], /^ {2}dev: applied /);
  assert.equal(status[3], '  prod: not planned');
  assert.equal(status[4], '  lock infrastructure/dev/foundation: PR #12');
  assert.deepEqual(cli('unlock', '12'), [
    'Unlocked infrastructure/dev/foundation',
  ]);
  cli('cleanup', '12');
  assert.ok(!existsSync(join(stateDir, 'pr-12')));
});

test('the CLI rejects unknown commands, PR numbers, and environments', () => {
  const { cli } = harness();
  assert.throws(() => cli('destroy', '12'), /usage:/);
  assert.throws(() => cli('toString', '12'), /usage:/);
  assert.throws(() => cli('plan', 'abc', 'dev'), /usage:/);
  assert.throws(() => cli('plan', '12', 'staging'), /dev or prod/);
});

test('envrc writes a managed block in each foundation root and verifies it', () => {
  const { cli, checkout, calls } = harness();
  const devFile = join(checkout, 'infrastructure/dev/foundation/.envrc');
  writeFileSync(
    devFile,
    '#!/usr/bin/env bash\nsource_up\nexport MINE="kept"\n',
  );
  const lines = cli('envrc');
  assert.deepEqual(lines, [
    '  infrastructure/dev/foundation/.envrc  updated  profile=mcc-dev-admin  ok',
    '  infrastructure/prod/foundation/.envrc  created  profile=my-prod  ok',
  ]);
  const dev = readFileSync(devFile, 'utf8');
  assert.match(dev, /export MINE="kept"/);
  assert.match(dev, /^export AWS_PROFILE="mcc-dev-admin"$/m);
  assert.match(dev, /^export TF_VAR_email_domain="dev.example.test"$/m);
  assert.match(dev, /^export TF_VAR_aws_region="us-east-2"$/m);
  assert.equal(statSync(devFile).mode & 0o777, 0o600);
  const prod = readFileSync(
    join(checkout, 'infrastructure/prod/foundation/.envrc'),
    'utf8',
  );
  assert.match(prod, /^source_up$/m);
  assert.match(prod, /^export AWS_PROFILE="my-prod"$/m);
  assert.deepEqual(cli('envrc'), [
    '  infrastructure/dev/foundation/.envrc  unchanged  profile=mcc-dev-admin  ok',
    '  infrastructure/prod/foundation/.envrc  unchanged  profile=my-prod  ok',
  ]);
  assert.ok(!existsSync(join(checkout, 'infrastructure/dev/bootstrap/.envrc')));
  assert.ok(
    !calls.some((call) =>
      call.args.some((arg) => /bootstrap|data-platform/.test(arg)),
    ),
  );
});

test('envrc reports a root whose shell resolves the wrong profile', () => {
  const { cli } = harness({ resolved: { AWS_PROFILE: 'mcc-dev-admin' } });
  assert.throws(() => cli('envrc'), /1 \.envrc check\(s\) failed/);
});
