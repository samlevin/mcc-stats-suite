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

  assert.equal(deployment.stackName, 'match-to-csv-sam');
  assert.equal(deployment.objectPrefix, 'ephemeral/sam');
  assert.equal(deployment.ingressEnabled, false);
  assert.equal(deployment.bootstrapQualifier, 'mcclocal1');
  assert.equal(
    deployment.workloadBoundaryName,
    'mcc-stats-suite-local-workload-boundary',
  );
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
  assert.equal(deployment.isEphemeral, false);
  assert.equal(deployment.ingressEnabled, true);
});

test('uses one production-qualified deployment', () => {
  const deployment = resolveDeployment(
    context({ environment: 'prod' }),
    'player',
    {},
  );

  assert.equal(deployment.stackName, 'player-prod');
  assert.equal(deployment.ephemeral, undefined);
  assert.equal(deployment.ingressEnabled, true);
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

test('rejects ephemeral names reserved for shared dev resources', () => {
  for (const ephemeral of [
    'dev',
    'devin',
    'dev-2',
    'admin-dev',
    'sam-devtest',
  ]) {
    assert.throws(
      () =>
        resolveDeployment(
          context({ environment: 'dev', ephemeral }),
          'admin',
          {},
        ),
      /reserved for shared dev/,
      ephemeral,
    );
  }
});

test('accepts ephemeral names that only resemble reserved names', () => {
  for (const ephemeral of ['sam', 'kevin', 'sam-2', 'adev']) {
    assert.equal(
      resolveDeployment(context({ environment: 'dev', ephemeral }), 'admin', {})
        .ephemeral,
      ephemeral,
    );
  }
});
