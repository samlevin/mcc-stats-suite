const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveDeployment } = require('../dist');

function context(values) {
  return { tryGetContext: (key) => values[key] };
}

test('creates an isolated ephemeral deployment in dev', () => {
  const deployment = resolveDeployment(
    context({ environment: 'dev', ephemeral: 'sam' }),
    'match-to-csv',
    {
      CDK_DEFAULT_ACCOUNT: '111111111111',
      MCC_DEV_ACCOUNT_ID: '111111111111',
      CDK_DEFAULT_REGION: 'us-east-1',
    },
  );

  assert.equal(deployment.stackName, 'match-to-csv-e-sam');
  assert.equal(deployment.objectPrefix, 'ephemeral/sam');
  assert.equal(deployment.terminationProtection, false);
  assert.equal(deployment.bootstrapQualifier, 'mcclocal1');
  assert.equal(
    deployment.workloadBoundaryName,
    'mcc-stats-suite-local-workload-boundary',
  );
  assert.equal(deployment.rolePath, '/mcc-local/');
});

test('uses one dev-qualified deployment for integration and smoke tests', () => {
  const deployment = resolveDeployment(
    context({ environment: 'dev' }),
    'admin',
    {},
  );

  assert.equal(deployment.stackName, 'admin-dev');
  assert.equal(deployment.bootstrapQualifier, 'hnb659fds');
  assert.equal(
    deployment.workloadBoundaryName,
    'mcc-stats-suite-workload-boundary',
  );
  assert.equal(deployment.rolePath, undefined);
  assert.equal(deployment.isEphemeral, false);
  assert.equal(deployment.terminationProtection, true);
});

test('uses one production-qualified deployment', () => {
  const deployment = resolveDeployment(
    context({ environment: 'prod' }),
    'player',
    {},
  );

  assert.equal(deployment.stackName, 'player-prod');
  assert.equal(deployment.ephemeral, undefined);
});

test('rejects production ephemeral deployments', () => {
  assert.throws(
    () =>
      resolveDeployment(
        context({ environment: 'prod', ephemeral: 'sam' }),
        'admin',
        {},
      ),
    /does not support/,
  );
});

test('rejects prod as an ephemeral name', () => {
  assert.throws(
    () =>
      resolveDeployment(
        context({ environment: 'dev', ephemeral: 'prod' }),
        'match-to-csv',
        {},
      ),
    /would name a dev stack like the production stack/,
  );
});

test('rejects deployment to the wrong account', () => {
  assert.throws(
    () =>
      resolveDeployment(
        context({
          environment: 'dev',
          ephemeral: 'sam',
          expectedAccount: '111111111111',
        }),
        'admin',
        { CDK_DEFAULT_ACCOUNT: '222222222222' },
      ),
    /does not match expected account/,
  );
});

test('reserves the shared inbound email route', () => {
  assert.throws(
    () =>
      resolveDeployment(
        context({ environment: 'dev', ephemeral: 'dev' }),
        'admin',
        {},
      ),
    /shared inbound email/,
  );
});

test('accepts ephemeral names that only resemble reserved names', () => {
  for (const ephemeral of [
    'sam',
    'kevin',
    'sam-2',
    'adev',
    'devin',
    'dev-2',
    'admin-dev',
    'sam-devtest',
  ]) {
    assert.equal(
      resolveDeployment(context({ environment: 'dev', ephemeral }), 'admin', {})
        .ephemeral,
      ephemeral,
    );
  }
});

test('rejects malformed ephemeral names with usable guidance', () => {
  for (const ephemeral of ['Sam', '-sam', 'a'.repeat(21), 'sam_1']) {
    assert.throws(
      () =>
        resolveDeployment(
          context({ environment: 'dev', ephemeral }),
          'admin',
          {},
        ),
      /^Error: Ephemeral names must be 1-20 lowercase letters/,
      ephemeral,
    );
  }
});
