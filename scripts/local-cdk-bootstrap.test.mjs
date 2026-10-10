import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';
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
        }),
        true,
        `${app} ${action} ephemeral`,
      );
      assert.equal(
        allowed(deployment, `cloudformation:${action}`, stack(`${app}-dev`), {
          'cloudformation:RoleArn': 'local-execution',
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
