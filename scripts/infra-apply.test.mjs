import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  accountFromRoleArn,
  checkLock,
  cleanEnvironment,
  globToRegExp,
  initArguments,
  lockOwner,
  matchesPatterns,
  mergeEnvrc,
  openRoot,
  profileFor,
  releaseLocks,
  repositoryInfo,
  shellExport,
  summarizePlan,
  takeLock,
  verifyAccount,
} from './infra-apply.mjs';

// Fake account IDs; tests never call AWS.
const ACCOUNT = '000000000000';
const OTHER = '999999999999';

function recorder(respond) {
  const calls = [];
  const run = (command, args, options = {}) => {
    calls.push({ command, args, options });
    return {
      status: 0,
      stdout: '',
      stderr: '',
      ...respond(command, args, options),
    };
  };
  return { run, calls };
}

const ambient = {
  PATH: '/usr/bin',
  HOME: '/home/someone',
  AWS_ACCESS_KEY_ID: 'ambient-key',
  AWS_SECRET_ACCESS_KEY: 'ambient-secret',
  AWS_SESSION_TOKEN: 'ambient-token',
  AWS_PROFILE: 'ambient-profile',
  AWS_DEFAULT_PROFILE: 'ambient-profile',
  AWS_ROLE_ARN: 'ambient-role',
  AWS_CONFIG_FILE: '/config',
  TF_VAR_email_domain: 'ambient.example',
  TF_CLI_ARGS: '-auto-approve',
  TF_CLI_ARGS_apply: '-auto-approve',
  TF_WORKSPACE: 'other',
  TF_DATA_DIR: '/elsewhere',
  TF_PLUGIN_CACHE_DIR: '/cache',
  TOFU_ENABLE_SOMETHING: '1',
};

test('the clean environment drops ambient credentials, profiles, and OpenTofu inputs', () => {
  assert.deepEqual(cleanEnvironment(ambient), {
    PATH: '/usr/bin',
    HOME: '/home/someone',
    AWS_CONFIG_FILE: '/config',
    TF_PLUGIN_CACHE_DIR: '/cache',
  });
});

test('profiles default per environment and are overridable', () => {
  assert.equal(profileFor('dev', {}), 'mcc-dev-admin');
  assert.equal(profileFor('prod', {}), 'mcc-prod-admin');
  assert.equal(
    profileFor('prod', { MCC_PROD_INFRA_PROFILE: 'mine-prod' }),
    'mine-prod',
  );
  assert.equal(
    profileFor('dev', { MCC_PROD_INFRA_PROFILE: 'mine-prod' }),
    'mcc-dev-admin',
  );
  assert.throws(() => profileFor('staging', {}), /dev or prod/);
});

test('the expected account comes from the Terrateam role ARN', () => {
  assert.equal(
    accountFromRoleArn(`arn:aws:iam::${ACCOUNT}:role/path/terrateam`),
    ACCOUNT,
  );
  assert.throws(
    () => accountFromRoleArn('arn:aws:s3:::bucket', 'DEV_TERRATEAM_ROLE_ARN'),
    /DEV_TERRATEAM_ROLE_ARN is not an IAM role ARN/,
  );
  assert.throws(() => accountFromRoleArn(undefined), /not an IAM role ARN/);
});

test('the account check uses only the named profile and never prints account IDs', () => {
  const { run, calls } = recorder(() => ({ stdout: `${ACCOUNT}\n` }));
  verifyAccount({
    run,
    env: ambient,
    profile: 'mcc-dev-admin',
    expectedAccount: ACCOUNT,
    source: 'DEV_TERRATEAM_ROLE_ARN',
  });
  assert.equal(calls[0].command, 'aws');
  assert.deepEqual(calls[0].args.slice(0, 2), ['sts', 'get-caller-identity']);
  assert.equal(calls[0].options.env.AWS_PROFILE, 'mcc-dev-admin');
  assert.equal(calls[0].options.env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(calls[0].options.env.AWS_SESSION_TOKEN, undefined);

  const wrong = recorder(() => ({ stdout: `${OTHER}\n` }));
  assert.throws(
    () =>
      verifyAccount({
        run: wrong.run,
        env: ambient,
        profile: 'mcc-dev-admin',
        expectedAccount: ACCOUNT,
        source: 'DEV_TERRATEAM_ROLE_ARN',
      }),
    (error) =>
      /different account than DEV_TERRATEAM_ROLE_ARN/.test(error.message) &&
      !error.message.includes(ACCOUNT) &&
      !error.message.includes(OTHER),
  );
  const expired = recorder(() => ({ status: 255, stderr: 'expired' }));
  assert.throws(
    () =>
      verifyAccount({
        run: expired.run,
        env: ambient,
        profile: 'mcc-dev-admin',
        expectedAccount: ACCOUNT,
        source: 'x',
      }),
    /no valid credentials; refresh them/,
  );
});

test('a root opens only after the account check, with the lock file and the given inputs', () => {
  const { run, calls } = recorder((command) =>
    command === 'aws' ? { stdout: ACCOUNT } : {},
  );
  const tofu = openRoot({
    run,
    env: ambient,
    cwd: '/src/root',
    profile: 'mcc-dev-admin',
    expectedAccount: ACCOUNT,
    accountSource: 'DEV_TERRATEAM_ROLE_ARN',
    region: 'us-east-2',
    backend: { bucket: 'state', region: 'us-east-2' },
    inputs: { TF_VAR_aws_region: 'us-east-2' },
  });
  assert.deepEqual(
    calls.map((call) => call.command),
    ['aws', 'tofu'],
  );
  const init = calls[1];
  assert.deepEqual(
    init.args,
    initArguments({ bucket: 'state', region: 'us-east-2' }),
  );
  assert.ok(init.args.includes('-lockfile=readonly'));
  assert.equal(init.options.cwd, '/src/root');
  const env = init.options.env;
  assert.equal(env.AWS_PROFILE, 'mcc-dev-admin');
  assert.equal(env.AWS_REGION, 'us-east-2');
  assert.equal(env.TF_VAR_aws_region, 'us-east-2');
  assert.equal(env.TF_INPUT, '0');
  for (const name of [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_ROLE_ARN',
    'TF_VAR_email_domain',
    'TF_CLI_ARGS',
    'TF_CLI_ARGS_apply',
    'TF_WORKSPACE',
    'TF_DATA_DIR',
  ])
    assert.equal(env[name], undefined, name);
  tofu(['plan']);
  assert.equal(calls[2].options.env, env);

  const mismatch = recorder((command) =>
    command === 'aws' ? { stdout: OTHER } : {},
  );
  assert.throws(() =>
    openRoot({
      run: mismatch.run,
      env: ambient,
      cwd: '/src/root',
      profile: 'mcc-dev-admin',
      expectedAccount: ACCOUNT,
      accountSource: 'x',
      region: 'us-east-2',
      backend: { bucket: 'state', region: 'us-east-2' },
    }),
  );
  assert.deepEqual(
    mismatch.calls.map((call) => call.command),
    ['aws'],
    'no OpenTofu command runs after a failed account check',
  );
  assert.throws(
    () =>
      openRoot({
        run,
        env: ambient,
        cwd: '/',
        profile: 'p',
        expectedAccount: ACCOUNT,
        region: 'r',
        backend: {},
        inputs: { AWS_PROFILE: 'other' },
      }),
    /Unexpected OpenTofu input AWS_PROFILE/,
  );
  const failingInit = recorder((command) =>
    command === 'aws'
      ? { stdout: ACCOUNT }
      : { status: 1, stderr: 'lock file' },
  );
  assert.throws(
    () =>
      openRoot({
        run: failingInit.run,
        env: {},
        cwd: '/',
        profile: 'p',
        expectedAccount: ACCOUNT,
        region: 'r',
        backend: { bucket: 'b', region: 'r' },
      }),
    (error) =>
      /tofu init failed/.test(error.message) && error.output === 'lock file',
  );
});

test('file patterns follow Terrateam glob rules', () => {
  assert.ok(
    globToRegExp('infrastructure/modules/foundation/*.tf').test(
      'infrastructure/modules/foundation/main.tf',
    ),
  );
  assert.ok(
    !globToRegExp('infrastructure/modules/foundation/*.tf').test(
      'infrastructure/modules/foundation/tests/a.tf',
    ),
  );
  assert.ok(globToRegExp('**/*').test('a/b/c.tf'));
  assert.ok(globToRegExp('a/**/c.tf').test('a/c.tf'));
  assert.ok(globToRegExp('a/**/c.tf').test('a/b/x/c.tf'));
  assert.ok(
    !globToRegExp('.terrateam/config.yml').test('.terrateam/configxyml'),
  );
  assert.ok(matchesPatterns(['a/*.tf'], 'a/main.tf'));
  assert.ok(!matchesPatterns(['a/*.tf', '!a/skip.tf'], 'a/skip.tf'));
  assert.ok(!matchesPatterns(['!**/*'], 'a/main.tf'));
});

test('strict locks hold until the owning PR merges or closes', () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'infra-apply-'));
  const states = { 7: 'OPEN', 8: 'MERGED' };
  const prState = (owner) => states[owner];
  checkLock({ stateDir, key: 'dev', pr: 5, prState });
  takeLock(stateDir, 'dev', 7);
  checkLock({ stateDir, key: 'dev', pr: 7, prState });
  assert.throws(
    () => checkLock({ stateDir, key: 'dev', pr: 5, prState }),
    /dev is locked by PR #7 \(OPEN\)/,
  );
  takeLock(stateDir, 'dev', 8);
  checkLock({ stateDir, key: 'dev', pr: 5, prState });
  assert.equal(lockOwner(stateDir, 'dev'), undefined);
  takeLock(stateDir, 'dev', 5);
  takeLock(stateDir, 'prod', 6);
  assert.deepEqual(releaseLocks(stateDir, ['dev', 'prod'], 5), ['dev']);
  assert.equal(lockOwner(stateDir, 'prod'), '6');
});

test('the managed .envrc block replaces itself and keeps every other line', () => {
  const block = {
    begin: '# >>> begin',
    end: '# <<< end',
    lines: ['export A="1"'],
  };
  const created = mergeEnvrc(undefined, block);
  assert.equal(
    created,
    '#!/usr/bin/env bash\n# Requires the repository-root .envrc.\nsource_up\n\n# >>> begin\nexport A="1"\n# <<< end\n',
  );
  const edited = created.replace('source_up', 'source_up\nexport MINE="kept"');
  const updated = mergeEnvrc(edited, { ...block, lines: ['export A="2"'] });
  assert.match(updated, /export MINE="kept"/);
  assert.match(updated, /export A="2"/);
  assert.doesNotMatch(updated, /export A="1"/);
  assert.equal(
    mergeEnvrc(updated, { ...block, lines: ['export A="2"'] }),
    updated,
  );
  assert.throws(() => mergeEnvrc('export X=1\n', block), /without source_up/);
  assert.equal(
    shellExport('AWS_PROFILE', 'mcc-dev-admin'),
    'export AWS_PROFILE="mcc-dev-admin"',
  );
  assert.throws(
    () => shellExport('X', 'a"; rm -rf /'),
    /unexpected characters/,
  );
});

test('plan summaries count actions and list every change and import', () => {
  const lines = summarizePlan({
    resource_changes: [
      { address: 'a.create', change: { actions: ['create'] } },
      { address: 'a.update', change: { actions: ['update'] } },
      { address: 'a.replace', change: { actions: ['delete', 'create'] } },
      { address: 'a.delete', change: { actions: ['delete'] } },
      { address: 'a.same', change: { actions: ['no-op'] } },
      { address: 'a.read', change: { actions: ['read'] } },
      {
        address: 'a.import',
        change: { actions: ['no-op'], importing: { id: 'x' } },
      },
    ],
  });
  assert.deepEqual(lines, [
    'Summary: 1 to add, 1 to change, 2 to destroy (1 replacements)',
    '  create: a.create',
    '  update: a.update',
    '  delete/create: a.replace',
    '  delete: a.delete',
    'Imports:',
    '  import: a.import',
  ]);
  assert.deepEqual(summarizePlan({}), [
    'Summary: 0 to add, 0 to change, 0 to destroy (0 replacements)',
  ]);
});

test('the repository is the main checkout and its GitHub origin', () => {
  for (const url of [
    'git@github.com:example/repo.git',
    'https://github.com/example/repo',
    'https://github.com/example/repo.git',
  ]) {
    const { run } = recorder((command, args) =>
      args.includes('--git-common-dir')
        ? { stdout: '/work/repo/.git\n' }
        : { stdout: `${url}\n` },
    );
    assert.deepEqual(repositoryInfo(run, '/work/repo/.claude/worktrees/x'), {
      checkout: '/work/repo',
      repository: 'example/repo',
    });
  }
  const { run } = recorder(() => ({ status: 128 }));
  assert.throws(() => repositoryInfo(run, '/'), /inside a checkout/);
});
