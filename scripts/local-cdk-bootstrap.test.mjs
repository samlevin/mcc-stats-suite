import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
import { LOCAL_CHANGE_SET_NAME, localDeployArguments } from './cdk-targets.mjs';
import { localBootstrap } from './local-cdk-bootstrap.mjs';

const upstream = parse(
  execFileSync(
    'node',
    ['node_modules/aws-cdk/bin/cdk', 'bootstrap', '--show-template'],
    { encoding: 'utf8' },
  ),
);
const template = localBootstrap(upstream);
const resources = template.Resources;
const deployment =
  resources.DeploymentActionRole.Properties.Policies[0].PolicyDocument;
const execution = resources.LocalExecutionPolicy.Properties.PolicyDocument;
const runtime = resources.LocalWorkloadBoundary.Properties.PolicyDocument;
const replacements = {
  'AWS::Partition': 'aws',
  'AWS::AccountId': '000000000000',
  'AWS::Region': 'us-east-1',
  'StagingBucket.Arn': 'arn:aws:s3:::local-assets',
};
function resolve(value) {
  if (typeof value === 'string') return value;
  if (value.Ref === 'LocalWorkloadBoundary') return 'local-boundary';
  if (value['Fn::GetAtt']?.[0] === 'StagingBucket')
    return 'arn:aws:s3:::local-assets';
  if (value['Fn::GetAtt']?.[0] === 'CloudFormationExecutionRole')
    return 'local-execution';
  if (value['Fn::Sub'])
    return value['Fn::Sub'].replace(
      /\$\{([^}]+)\}/g,
      (_, key) => replacements[key] ?? key,
    );
  throw new Error(`Unhandled test value: ${JSON.stringify(value)}`);
}
const matches = (pattern, value) =>
  new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`,
    'i',
  ).test(value);
// Evaluate the statement forms this template emits. AWS simulation remains an operator gate.
function allowed(policy, action, resource, context = {}) {
  const relevant = policy.Statement.filter(
    (entry) =>
      [entry.Action].flat().some((item) => matches(item, action)) &&
      [entry.Resource]
        .flat()
        .some((item) => matches(resolve(item), resource)) &&
      Object.entries(entry.Condition?.StringEquals ?? {}).every(
        ([key, expected]) =>
          [expected].flat().map(resolve).includes(context[key]),
      ),
  );
  return (
    relevant.some((entry) => entry.Effect === 'Allow') &&
    !relevant.some((entry) => entry.Effect === 'Deny')
  );
}
const stack = (name) =>
  `arn:aws:cloudformation:us-east-1:000000000000:stack/${name}/id`;
const role = (name) => `arn:aws:iam::000000000000:role/${name}`;

test('local deployment allows ephemeral writes and denies all shared stack writes', () => {
  for (const app of [
    'admin',
    'data-pipeline',
    'match-to-csv',
    'ocr-quality',
    'player',
  ]) {
    for (const action of [
      'CreateStack',
      'UpdateStack',
      'DeleteStack',
      'CreateChangeSet',
      'ExecuteChangeSet',
      'DeleteChangeSet',
      'UpdateTerminationProtection',
    ]) {
      assert.equal(
        allowed(deployment, `cloudformation:${action}`, stack(`${app}-alice`), {
          'cloudformation:RoleArn': 'local-execution',
          'cloudformation:ChangeSetName': LOCAL_CHANGE_SET_NAME,
        }),
        true,
        `${app} ${action} ephemeral`,
      );
      assert.equal(
        allowed(deployment, `cloudformation:${action}`, stack(`${app}-dev`), {
          'cloudformation:RoleArn': 'local-execution',
          'cloudformation:ChangeSetName': LOCAL_CHANGE_SET_NAME,
        }),
        false,
        `${app} ${action} shared`,
      );
    }
  }
  assert.equal(
    allowed(deployment, 'cloudformation:UpdateStack', stack('admin-alice')),
    false,
  );
  assert.equal(
    allowed(
      deployment,
      'cloudformation:ExecuteChangeSet',
      stack('admin-alice'),
      {
        'cloudformation:ChangeSetName': 'cdk-deploy-change-set',
      },
    ),
    false,
    'change sets from the administrator bootstrap',
  );
  assert.equal(
    allowed(deployment, 'cloudformation:UpdateStack', stack('CDKToolkit')),
    false,
  );
  assert.equal(
    allowed(deployment, 'cloudformation:DeleteStack', stack('unrelated')),
    false,
  );
  assert.equal(
    allowed(deployment, 'iam:PassRole', 'stable-execution', {
      'iam:PassedToService': 'cloudformation.amazonaws.com',
    }),
    false,
  );
  assert.equal(
    allowed(deployment, 'iam:PassRole', 'local-execution', {
      'iam:PassedToService': 'cloudformation.amazonaws.com',
    }),
    true,
  );
});

test('execution cannot escalate or alter shared resources through a template', () => {
  const ephemeral = role('match-to-csv-alice-ServiceRole-hash');
  const stable = role('match-to-csv-dev-ServiceRole-hash');
  assert.equal(allowed(execution, 'iam:CreateRole', ephemeral), false);
  assert.equal(
    allowed(execution, 'iam:CreateRole', ephemeral, {
      'iam:PermissionsBoundary': 'local-boundary',
    }),
    true,
  );
  assert.equal(
    allowed(execution, 'iam:CreateRole', stable, {
      'iam:PermissionsBoundary': 'local-boundary',
    }),
    false,
  );
  for (const action of [
    'iam:DeleteRolePermissionsBoundary',
    'iam:CreatePolicy',
    'iam:CreateUser',
    'sts:AssumeRole',
    'cloudformation:UpdateStack',
    'cloudformation:CreateStack',
  ]) {
    assert.equal(allowed(execution, action, '*'), false, action);
  }
  assert.equal(
    allowed(execution, 'iam:PutRolePolicy', role('cdk-hnb659fds-deploy-role')),
    false,
  );
  assert.equal(
    allowed(execution, 'iam:PassRole', stable, {
      'iam:PassedToService': 'lambda.amazonaws.com',
    }),
    false,
  );
  assert.equal(
    allowed(execution, 'iam:PassRole', ephemeral, {
      'iam:PassedToService': 'lambda.amazonaws.com',
    }),
    true,
  );
  for (const action of [
    'lambda:CreateFunction',
    'lambda:UpdateFunctionCode',
    'lambda:DeleteFunction',
  ]) {
    assert.equal(
      allowed(
        execution,
        action,
        'arn:aws:lambda:us-east-1:000000000000:function:match-to-csv-alice-ProcessEmail',
      ),
      true,
    );
    assert.equal(
      allowed(
        execution,
        action,
        'arn:aws:lambda:us-east-1:000000000000:function:match-to-csv-dev-ProcessEmail',
      ),
      false,
    );
  }
});

test('runtime roles cannot mutate compute, deploy stacks, or assume another role', () => {
  for (const action of [
    'lambda:UpdateFunctionCode',
    'iam:PutRolePolicy',
    'sts:AssumeRole',
    'cloudformation:UpdateStack',
    'cloudformation:DeleteStack',
  ]) {
    assert.equal(allowed(runtime, action, '*'), false, action);
  }
  assert.equal(allowed(runtime, 'textract:AnalyzeDocument', '*'), true);
  assert.equal(
    allowed(
      runtime,
      's3:PutObject',
      'arn:aws:s3:::evidence/ephemeral/alice/result',
    ),
    true,
  );
  assert.equal(
    allowed(
      runtime,
      's3:PutObject',
      'arn:aws:s3:::cdk-hnb659fds-assets-000000000000-us-east-1/template',
    ),
    false,
  );
});

test('customizes current bootstrap without changing the stable template', () => {
  assert.equal(upstream.Parameters.Qualifier.Default, 'hnb659fds');
  assert.deepEqual(template.Parameters.Qualifier.AllowedValues, ['mcclocal1']);
  assert.deepEqual(
    resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns,
    [{ Ref: 'LocalExecutionPolicy' }],
  );
  assert.deepEqual(
    resources.CloudFormationExecutionRole.Properties.PermissionsBoundary,
    { Ref: 'LocalExecutionPolicy' },
  );
  assert.deepEqual(
    resources.FilePublishingRole,
    upstream.Resources.FilePublishingRole,
  );
  assert.deepEqual(
    resources.ImagePublishingRole,
    upstream.Resources.ImagePublishingRole,
  );
  const permissionSet = JSON.parse(
    readFileSync(
      'docs/self-hosting/policies/local-cdk-deployer-dev.json.template',
      'utf8',
    ),
  );
  const assume = permissionSet.Statement.find(
    (entry) => entry.Action === 'sts:AssumeRole',
  );
  assert.equal(assume.Resource.length, 4);
  assert.ok(assume.Resource.every((item) => item.includes('cdk-mcclocal1-')));
  const missing = structuredClone(upstream);
  delete missing.Resources.DeploymentActionRole;
  assert.throws(
    () => localBootstrap(missing),
    /review the CDK template upgrade/,
  );
});

test('IAM managed policies remain below the 6144 character limit', () => {
  for (const policy of [execution, runtime]) {
    assert.ok(JSON.stringify(policy).length < 6144);
  }
});

test('execution can manage receipt rules and read only local Lambda assets', () => {
  for (const action of [
    'ses:CreateReceiptRule',
    'ses:UpdateReceiptRule',
    'ses:DeleteReceiptRule',
    'ses:DescribeReceiptRule',
    'ses:DescribeReceiptRuleSet',
  ]) {
    assert.equal(allowed(execution, action, '*'), true, action);
  }
  for (const action of [
    'ses:SetActiveReceiptRuleSet',
    'ses:DeleteReceiptRuleSet',
    'ses:CreateReceiptRuleSet',
  ]) {
    assert.equal(allowed(execution, action, '*'), false, action);
  }
  assert.equal(
    allowed(execution, 's3:GetObject', 'arn:aws:s3:::local-assets/lambda.zip'),
    true,
  );
  assert.equal(
    allowed(
      execution,
      's3:GetObject',
      'arn:aws:s3:::cdk-hnb659fds-assets/lambda.zip',
    ),
    false,
  );
});

test('runtime boundary allows Step Functions logging delivery with unscoped IAM actions', () => {
  for (const action of [
    'CreateLogDelivery',
    'GetLogDelivery',
    'UpdateLogDelivery',
    'DeleteLogDelivery',
    'ListLogDeliveries',
    'PutResourcePolicy',
    'DescribeResourcePolicies',
    'DescribeLogGroups',
  ]) {
    assert.equal(allowed(runtime, `logs:${action}`, '*'), true, action);
  }
});

const evidence = (key) => `arn:aws:s3:::evidence/${key}`;
const fn = (name) => `arn:aws:lambda:us-east-1:000000000000:function:${name}`;
const machine = (name) =>
  `arn:aws:states:us-east-1:000000000000:stateMachine:${name}`;

test('runtime boundary confines data and compute to ephemeral resources', () => {
  assert.equal(
    allowed(runtime, 's3:PutObject', evidence('screenshots/a/source/original')),
    false,
    'shared evidence',
  );
  assert.equal(
    allowed(runtime, 's3:GetObject', evidence('incoming/alice/message')),
    true,
  );
  for (const key of ['incoming/dev/message', 'incoming/devin/message']) {
    assert.equal(allowed(runtime, 's3:GetObject', evidence(key)), false, key);
  }
  assert.equal(
    allowed(runtime, 'lambda:InvokeFunction', fn('match-to-csv-alice-Process')),
    true,
  );
  assert.equal(
    allowed(runtime, 'lambda:InvokeFunction', fn('match-to-csv-dev-Process')),
    false,
  );
  for (const action of ['StartExecution', 'StopExecution']) {
    assert.equal(
      allowed(runtime, `states:${action}`, machine('match-to-csv-alice')),
      true,
      action,
    );
    assert.equal(
      allowed(runtime, `states:${action}`, machine('match-to-csv-dev-replay')),
      false,
      action,
    );
  }
  assert.equal(
    allowed(
      runtime,
      'states:StopExecution',
      'arn:aws:states:us-east-1:000000000000:execution:match-to-csv-dev:run',
    ),
    false,
  );
});

test('execution compute patterns ignore names that merely contain an application', () => {
  for (const resource of [
    fn('sysadmin-rotate'),
    'arn:aws:sqs:us-east-1:000000000000:team-player-events',
    'arn:aws:logs:us-east-1:000000000000:log-group:/aws/lambda/sysadmin-rotate',
  ]) {
    assert.equal(allowed(execution, 'lambda:DeleteFunction', resource), false);
    assert.equal(allowed(execution, 'sqs:DeleteQueue', resource), false);
    assert.equal(allowed(execution, 'logs:DeleteLogGroup', resource), false);
  }
  for (const [action, resource] of [
    [
      'sqs:CreateQueue',
      'arn:aws:sqs:us-east-1:000000000000:match-to-csv-alice-events-dlq',
    ],
    [
      'events:PutRule',
      'arn:aws:events:us-east-1:000000000000:rule/match-to-csv-alice-RawEmailCreated',
    ],
    [
      'logs:CreateLogGroup',
      'arn:aws:logs:us-east-1:000000000000:log-group:/aws/vendedlogs/states/match-to-csv-alice',
    ],
    ['states:CreateStateMachine', machine('match-to-csv-alice-replay')],
  ]) {
    assert.equal(allowed(execution, action, resource), true, resource);
  }
});

test('execution decrypts staged Lambda assets only through S3', () => {
  assert.equal(
    allowed(execution, 'kms:Decrypt', '*', {
      'kms:ViaService': 's3.us-east-1.amazonaws.com',
    }),
    true,
  );
  assert.equal(allowed(execution, 'kms:Decrypt', '*'), false);
});

test('lookup role cannot read workload data', () => {
  const lookup =
    resources.LookupRole.Properties.Policies[0].PolicyDocument.Statement;
  const data = lookup.find((entry) => entry.Sid === 'DontReadWorkloadData');
  for (const action of [
    's3:GetObject',
    'lambda:GetFunction',
    'sqs:ReceiveMessage',
  ]) {
    assert.ok(
      data.Action.some((item) => matches(item, action)),
      action,
    );
  }
  const parameters = lookup.find(
    (entry) => entry.Sid === 'ReadOnlyBootstrapParameters',
  );
  assert.equal(parameters.Effect, 'Deny');
  assert.ok(
    matches(
      resolve(parameters.NotResource),
      'arn:aws:ssm:us-east-1:000000000000:parameter/cdk-bootstrap/mcclocal1/version',
    ),
  );
});

test('deployment deletes failed ephemeral stacks without a role but never shared ones', () => {
  assert.equal(
    allowed(deployment, 'cloudformation:DeleteStack', stack('admin-alice')),
    true,
  );
  assert.equal(
    allowed(deployment, 'cloudformation:DeleteStack', stack('admin-dev')),
    false,
  );
  assert.equal(
    allowed(deployment, 'cloudformation:UpdateStack', stack('admin-alice')),
    false,
    'updates still require the local execution role',
  );
});

test('deployment reads the local bootstrap version with either SSM call', () => {
  for (const action of ['ssm:GetParameter', 'ssm:GetParameters']) {
    assert.equal(
      allowed(
        deployment,
        action,
        'arn:aws:ssm:us-east-1:000000000000:parameter/cdk-bootstrap/mcclocal1/version',
      ),
      true,
      action,
    );
  }
});

test('runtime boundary allows X-Ray sampling lookups', () => {
  for (const action of ['xray:GetSamplingRules', 'xray:GetSamplingTargets']) {
    assert.equal(allowed(runtime, action, '*'), true, action);
  }
});

test('ephemeral deploys name the local change set unless deploying directly', () => {
  const named = ['--change-set-name', LOCAL_CHANGE_SET_NAME];
  assert.deepEqual(localDeployArguments([]), named);
  assert.deepEqual(localDeployArguments(['--method=change-set']), named);
  assert.deepEqual(
    localDeployArguments(['--method', 'prepare-change-set']),
    named,
  );
  assert.deepEqual(localDeployArguments(['--method=direct']), []);
  assert.deepEqual(localDeployArguments(['--method', 'direct']), []);
  assert.throws(
    () => localDeployArguments(['--change-set-name', 'mine']),
    /remove --change-set-name/,
  );
  assert.throws(() => localDeployArguments(['--change-set-name=mine']));
});
