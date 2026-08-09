const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveDeployment } = require('../dist');

function context(values) {
  return { tryGetContext: (key) => values[key] };
}

test('creates an isolated developer deployment', () => {
  const deployment = resolveDeployment(
    context({ environment: 'dev', instance: 'sam' }),
    'match-to-csv',
    {
      CDK_DEFAULT_ACCOUNT: '111111111111',
      MCC_DEV_ACCOUNT_ID: '111111111111',
      CDK_DEFAULT_REGION: 'us-east-1',
    },
  );

  assert.equal(deployment.stackName, 'match-to-csv-sam');
  assert.equal(deployment.objectPrefix, 'instances/sam');
  assert.equal(deployment.ingressEnabled, false);
});

test('marks the shared dev instance as the integration deployment', () => {
  const deployment = resolveDeployment(
    context({ environment: 'dev', instance: 'shared' }),
    'admin',
    {},
  );

  assert.equal(deployment.stackName, 'admin-dev');
  assert.equal(deployment.isShared, true);
  assert.equal(deployment.ingressEnabled, true);
});

test('uses one production-qualified deployment', () => {
  const deployment = resolveDeployment(
    context({ environment: 'prod' }),
    'player',
    {},
  );

  assert.equal(deployment.stackName, 'player-prod');
  assert.equal(deployment.instance, undefined);
  assert.equal(deployment.ingressEnabled, true);
});

test('rejects missing dev instances and production instances', () => {
  assert.throws(
    () => resolveDeployment(context({ environment: 'dev' }), 'admin', {}),
    /requires -c instance/,
  );
  assert.throws(
    () =>
      resolveDeployment(
        context({ environment: 'prod', instance: 'sam' }),
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
          instance: 'sam',
          expectedAccount: '111111111111',
        }),
        'admin',
        { CDK_DEFAULT_ACCOUNT: '222222222222' },
      ),
    /does not match expected account/,
  );
});
