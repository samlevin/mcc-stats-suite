import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountGuardError,
  environmentFromProfile,
  profileSsoAccount,
  resolveEnvironment,
  resolveExpectedAccount,
  verifyCallerAccount,
} from './account-guard.mjs';

const DEV = '111111111111';
const OTHER = '222222222222';

test('a profile name implies its environment', () => {
  for (const [profile, environment] of [
    ['mcc-dev-admin', 'dev'],
    ['mcc_development', 'dev'],
    ['mcc-prod-admin', 'prod'],
    ['PRODUCTION', 'prod'],
    ['mcc-devin', undefined],
    ['sandbox', undefined],
    [undefined, undefined],
  ]) {
    assert.equal(environmentFromProfile(profile), environment, profile);
  }
});

test('the environment comes from the request, then the profile, then dev', () => {
  assert.equal(resolveEnvironment(undefined, undefined), 'dev');
  assert.equal(resolveEnvironment(undefined, 'mcc-prod-admin'), 'prod');
  assert.equal(resolveEnvironment('prod', 'sandbox'), 'prod');
  assert.equal(resolveEnvironment('dev', 'mcc-dev-admin'), 'dev');
  assert.throws(
    () => resolveEnvironment('staging', undefined),
    /^AccountGuardError: --environment must be dev or prod$/,
  );
  assert.throws(
    () => resolveEnvironment('dev', 'mcc-prod-admin'),
    /AWS_PROFILE=mcc-prod-admin looks like prod, not dev/,
  );
});

test('the expected account comes from the variable, then sso_account_id', () => {
  const unused = () => assert.fail('sso_account_id is not read');
  assert.deepEqual(
    resolveExpectedAccount({
      environment: 'dev',
      profile: 'mcc-dev-admin',
      needsAws: true,
      env: { MCC_DEV_ACCOUNT_ID: DEV },
      readSsoAccount: unused,
    }),
    { account: DEV, source: 'MCC_DEV_ACCOUNT_ID' },
  );
  assert.deepEqual(
    resolveExpectedAccount({
      environment: 'prod',
      profile: 'mcc-prod-admin',
      needsAws: true,
      env: { MCC_DEV_ACCOUNT_ID: DEV },
      readSsoAccount: () => OTHER,
    }),
    { account: OTHER, source: 'AWS_PROFILE=mcc-prod-admin sso_account_id' },
  );
});

test('the expected account check refuses before any AWS call', () => {
  const base = {
    environment: 'dev',
    profile: 'mcc-dev-admin',
    needsAws: true,
    env: {},
    readSsoAccount: () => undefined,
  };
  for (const [overrides, message] of [
    [
      { profile: undefined },
      /^Export AWS_PROFILE or pass --profile before using AWS$/,
    ],
    [
      {},
      /^AWS profile mcc-dev-admin has no sso_account_id; configure it or export MCC_DEV_ACCOUNT_ID$/,
    ],
    [
      { env: { MCC_DEV_ACCOUNT_ID: '1234' } },
      /^MCC_DEV_ACCOUNT_ID must contain a 12-digit AWS account ID$/,
    ],
    [
      { readSsoAccount: () => 'not-an-account' },
      /^MCC_DEV_ACCOUNT_ID must contain a 12-digit AWS account ID$/,
    ],
  ]) {
    assert.throws(
      () => resolveExpectedAccount({ ...base, ...overrides }),
      (error) =>
        error instanceof AccountGuardError && message.test(error.message),
    );
  }
  // GitHub Actions uses ambient credentials, and synth needs no account.
  assert.throws(
    () =>
      resolveExpectedAccount({
        ...base,
        profile: undefined,
        env: { GITHUB_ACTIONS: 'true' },
      }),
    /AWS profile \(ambient credentials\) has no sso_account_id/,
  );
  assert.deepEqual(
    resolveExpectedAccount({
      ...base,
      profile: undefined,
      needsAws: false,
      readSsoAccount: () => assert.fail('synth reads no profile'),
    }),
    { account: undefined, source: 'MCC_DEV_ACCOUNT_ID' },
  );
  assert.throws(
    () =>
      resolveExpectedAccount({
        ...base,
        needsAws: false,
        env: { MCC_DEV_ACCOUNT_ID: 'abc' },
      }),
    /must contain a 12-digit AWS account ID/,
  );
});

test('the caller account must equal the expected account', () => {
  const calls = [];
  const run = (identity) => (args) => {
    calls.push(args);
    return identity;
  };
  const accepted = verifyCallerAccount({
    run: run({
      status: 0,
      stdout: JSON.stringify({
        Account: DEV,
        Arn: `arn:aws:sts::${DEV}:assumed-role/Admin/operator`,
      }),
    }),
    expected: DEV,
    source: 'MCC_DEV_ACCOUNT_ID',
    action: 'deploy',
  });
  assert.deepEqual(accepted, {
    account: DEV,
    arn: `arn:aws:sts::${DEV}:assumed-role/Admin/operator`,
  });
  assert.deepEqual(calls, [['sts', 'get-caller-identity', '--output', 'json']]);

  assert.throws(
    () =>
      verifyCallerAccount({
        run: run({ status: 0, stdout: JSON.stringify({ Account: OTHER }) }),
        expected: DEV,
        source: 'MCC_DEV_ACCOUNT_ID',
        action: 'roster add',
      }),
    new RegExp(
      `^AccountGuardError: Refusing roster add: active account ${OTHER} does not match MCC_DEV_ACCOUNT_ID \\(${DEV}\\)$`,
    ),
  );
  for (const identity of [
    { status: 255, stdout: '', stderr: 'The SSO session has expired\n' },
    { status: 0, stdout: 'not json', stderr: '' },
  ]) {
    assert.throws(
      () =>
        verifyCallerAccount({
          run: run(identity),
          expected: DEV,
          source: 'MCC_DEV_ACCOUNT_ID',
          action: 'diff',
        }),
      (error) =>
        error instanceof AccountGuardError &&
        error.message === 'Unable to resolve the active AWS account' &&
        error.detail === identity.stderr,
    );
  }
});

test('sso_account_id is read from the profile configuration', () => {
  const calls = [];
  assert.equal(
    profileSsoAccount((args) => {
      calls.push(args);
      return { status: 0, stdout: `${DEV}\n` };
    }),
    DEV,
  );
  assert.deepEqual(calls, [['configure', 'get', 'sso_account_id']]);
  assert.equal(
    profileSsoAccount(() => ({ status: 1, stdout: '' })),
    undefined,
  );
});
