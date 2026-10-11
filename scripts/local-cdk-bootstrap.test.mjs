import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parse } from 'yaml';
import {
  APPLICATIONS,
  LOCAL_CHANGE_SET_NAME,
  LOCAL_QUALIFIER,
  LOCAL_ROLE_PATH,
  cdkArguments,
  ephemeralNameError,
  localDeployArguments,
} from './cdk-targets.mjs';
import {
  LOCAL_POLICY_RESOURCES,
  localBootstrap,
} from './local-cdk-bootstrap.mjs';

// The CLI renders the pinned bootstrap template offline; telemetry and notices stay off.
const quietCdk = { ...process.env, CDK_DISABLE_CLI_TELEMETRY: '1' };
const upstream = parse(
  execFileSync(
    'node',
    [
      'node_modules/aws-cdk/bin/cdk',
      'bootstrap',
      '--show-template',
      '--no-notices',
    ],
    { encoding: 'utf8', env: quietCdk },
  ),
);
const template = localBootstrap(upstream);
const resources = template.Resources;
const policyOf = (name) => resources[name].Properties.PolicyDocument;
const deployment =
  resources.DeploymentActionRole.Properties.Policies[0].PolicyDocument;
const execution = {
  Statement: [
    ...policyOf('LocalExecutionPolicy').Statement,
    ...policyOf('LocalExecutionComputePolicy').Statement,
    ...policyOf('LocalExecutionEventsPolicy').Statement,
  ],
};
const executionBoundary = policyOf('LocalExecutionBoundary');
const runtime = policyOf('LocalWorkloadBoundary');

const ACCOUNT = '000000000000';
const replacements = {
  'AWS::Partition': 'aws',
  'AWS::AccountId': ACCOUNT,
  'AWS::Region': 'us-east-1',
  'StagingBucket.Arn': 'arn:aws:s3:::local-assets',
  '!aws:PrincipalTag/Ephemeral': '${aws:PrincipalTag/Ephemeral}',
};
function resolve(value) {
  if (typeof value === 'string') return value;
  if (value.Ref === 'LocalWorkloadBoundary') return 'local-boundary';
  if (value['Fn::GetAtt']?.[0] === 'StagingBucket')
    return 'arn:aws:s3:::local-assets';
  if (value['Fn::GetAtt']?.[0] === 'CloudFormationExecutionRole')
    return 'local-execution';
  if (value['Fn::Sub'])
    return value['Fn::Sub'].replace(/\$\{([^}]+)\}/g, (_, key) => {
      if (!(key in replacements)) throw new Error(`Unknown Fn::Sub key ${key}`);
      return replacements[key];
    });
  throw new Error(`Unhandled test value: ${JSON.stringify(value)}`);
}
// IAM matches actions case-insensitively but ARNs and condition values exactly.
const wildcard = (pattern, flags) =>
  new RegExp(
    `^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*')}$`,
    flags,
  );
const matches = (pattern, value) => wildcard(pattern, '').test(value);
const matchesAction = (pattern, value) => wildcard(pattern, 'i').test(value);
// Unset tags make a policy variable match nothing, as in IAM.
const withVariables = (pattern, context) =>
  pattern
    .replaceAll(
      '${aws:PrincipalTag/Ephemeral}',
      context['aws:PrincipalTag/Ephemeral'] ?? '\u0000',
    )
    .replaceAll('${aws:PrincipalAccount}', ACCOUNT);
const like = (actual, expected) =>
  actual !== undefined &&
  [actual].flat().some((value) => expected.some((p) => matches(p, value)));
// Only the operators the template emits; anything else fails loudly.
const operators = {
  StringEquals: (actual, expected) =>
    actual !== undefined &&
    [actual].flat().some((value) => expected.includes(value)),
  StringNotEquals: (actual, expected) =>
    actual === undefined ||
    [actual].flat().every((value) => !expected.includes(value)),
  StringLike: like,
  ArnLike: like,
  Null: (actual, [expected]) =>
    expected === 'true' ? actual === undefined : actual !== undefined,
  'ForAllValues:StringEquals': (actual, expected) =>
    [actual ?? []].flat().every((value) => expected.includes(value)),
  'ForAnyValue:ArnLike': (actual, expected) =>
    [actual ?? []]
      .flat()
      .some((value) => expected.some((p) => matches(p, value))),
  'ForAllValues:ArnLike': (actual, expected) =>
    [actual ?? []]
      .flat()
      .every((value) => expected.some((p) => matches(p, value))),
};
function conditionsHold(condition = {}, context) {
  return Object.entries(condition).every(([operator, keys]) => {
    const holds = operators[operator];
    if (!holds) throw new Error(`Unsupported condition operator ${operator}`);
    return Object.entries(keys).every(([key, expected]) =>
      holds(
        context[key],
        [expected].flat().map((item) => withVariables(resolve(item), context)),
      ),
    );
  });
}
// Evaluate the statement forms this template emits. AWS simulation remains an operator gate.
function allowed(policy, action, resource, context = {}) {
  const relevant = policy.Statement.filter((entry) => {
    if (entry.NotAction || entry.NotResource)
      throw new Error(`Unsupported statement ${entry.Sid}`);
    return (
      [entry.Action].flat().some((item) => matchesAction(item, action)) &&
      [entry.Resource]
        .flat()
        .some((item) =>
          matches(withVariables(resolve(item), context), resource),
        ) &&
      conditionsHold(entry.Condition, context)
    );
  });
  return (
    relevant.some((entry) => entry.Effect === 'Allow') &&
    !relevant.some((entry) => entry.Effect === 'Deny')
  );
}
// The execution role's effective permissions: identity policies within its boundary.
const executes = (action, resource, context) =>
  allowed(execution, action, resource, context) &&
  allowed(executionBoundary, action, resource, context);

const stack = (name) =>
  `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/${name}/id`;
const role = (name) => `arn:aws:iam::${ACCOUNT}:role/${name}`;
const localRole = (name) => role(`${LOCAL_ROLE_PATH.slice(1)}${name}`);
const evidence = (key) => `arn:aws:s3:::evidence/${key}`;
const fn = (name) => `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${name}`;
const machine = (name) =>
  `arn:aws:states:us-east-1:${ACCOUNT}:stateMachine:${name}`;
const queue = (name) => `arn:aws:sqs:us-east-1:${ACCOUNT}:${name}`;
const rule = (name) => `arn:aws:events:us-east-1:${ACCOUNT}:rule/${name}`;
const parameter = (name) =>
  `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/${name}`;
const own = (tag) => ({
  'aws:PrincipalTag/Ephemeral': tag,
  's3:ResourceAccount': ACCOUNT,
});
const bounded = { 'iam:PermissionsBoundary': 'local-boundary' };

test('local deployment allows ephemeral writes and denies all shared stack writes', () => {
  for (const app of APPLICATIONS) {
    for (const action of [
      'CreateStack',
      'UpdateStack',
      'DeleteStack',
      'CreateChangeSet',
      'ExecuteChangeSet',
      'DeleteChangeSet',
      'UpdateTerminationProtection',
      'ContinueUpdateRollback',
      'RollbackStack',
      'TagResource',
      'UntagResource',
    ]) {
      const context = {
        'cloudformation:RoleArn': 'local-execution',
        'cloudformation:ChangeSetName': LOCAL_CHANGE_SET_NAME,
      };
      assert.equal(
        allowed(
          deployment,
          `cloudformation:${action}`,
          stack(`${app}-alice`),
          context,
        ),
        true,
        `${app} ${action} ephemeral`,
      );
      assert.equal(
        allowed(
          deployment,
          `cloudformation:${action}`,
          stack(`${app}-dev`),
          context,
        ),
        false,
        `${app} ${action} shared`,
      );
    }
  }
  for (const action of [
    'UpdateStack',
    'CreateChangeSet',
    'ContinueUpdateRollback',
    'RollbackStack',
  ]) {
    assert.equal(
      allowed(deployment, `cloudformation:${action}`, stack('admin-alice')),
      false,
      `${action} without the local execution role`,
    );
  }
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

test('shared stack protection covers every reserved dev name', () => {
  for (const name of ['admin-dev', 'match-to-csv-dev-replay']) {
    assert.equal(
      allowed(deployment, 'cloudformation:DeleteStack', stack(name)),
      false,
      name,
    );
  }
});

test('deployment deletes failed ephemeral stacks without a role', () => {
  assert.equal(
    allowed(deployment, 'cloudformation:DeleteStack', stack('admin-alice')),
    true,
  );
});

test('deployment executes the local change set by name or ARN only', () => {
  const execute = (changeSet) =>
    allowed(
      deployment,
      'cloudformation:ExecuteChangeSet',
      stack('admin-alice'),
      { 'cloudformation:ChangeSetName': changeSet },
    );
  const changeSetArn = (name) =>
    `arn:aws:cloudformation:us-east-1:${ACCOUNT}:changeSet/${name}/0f2c`;
  assert.equal(execute(LOCAL_CHANGE_SET_NAME), true);
  assert.equal(execute(changeSetArn(LOCAL_CHANGE_SET_NAME)), true);
  assert.equal(execute('cdk-deploy-change-set'), false);
  assert.equal(execute(changeSetArn('cdk-deploy-change-set')), false);
});

test('deployment and execution read only bootstrap and application parameters', () => {
  for (const name of [
    'cdk-bootstrap/mcclocal1/version',
    'mcc/dev/match-to-csv/evidence-bucket-name',
  ]) {
    for (const action of ['ssm:GetParameter', 'ssm:GetParameters']) {
      assert.equal(allowed(deployment, action, parameter(name)), true, name);
      assert.equal(executes(action, parameter(name)), true, name);
    }
  }
  for (const name of [
    'mcc/dev/turbo-cache/bucket-name',
    'mcc/prod/match-to-csv/evidence-bucket-name',
    'cdk-bootstrap/hnb659fds/version',
  ]) {
    assert.equal(
      allowed(deployment, 'ssm:GetParameters', parameter(name)),
      false,
      name,
    );
    assert.equal(executes('ssm:GetParameter', parameter(name)), false, name);
  }
});

test('execution creates and changes only bounded roles under the local path', () => {
  const ephemeral = localRole('match-to-csv-alice-ServiceRole-hash');
  // Roles from before the local bootstrap, or made by hand, sit at path /.
  const legacy = role('match-to-csv-alice-ServiceRole-hash');
  assert.equal(executes('iam:CreateRole', ephemeral), false);
  assert.equal(executes('iam:CreateRole', ephemeral, bounded), true);
  assert.equal(executes('iam:CreateRole', legacy, bounded), false);
  for (const action of [
    'iam:PutRolePolicy',
    'iam:DeleteRolePolicy',
    'iam:AttachRolePolicy',
    'iam:DetachRolePolicy',
  ]) {
    assert.equal(executes(action, ephemeral, bounded), true, action);
    assert.equal(executes(action, ephemeral), false, `${action} unbounded`);
    assert.equal(executes(action, legacy, bounded), false, `${action} legacy`);
  }
  for (const action of [
    'iam:GetRole',
    'iam:DeleteRole',
    'iam:UpdateAssumeRolePolicy',
    'iam:TagRole',
    'iam:UntagRole',
    'iam:ListRoleTags',
    'iam:UpdateRole',
    'iam:UpdateRoleDescription',
  ]) {
    assert.equal(executes(action, ephemeral), true, action);
    assert.equal(executes(action, legacy), false, `${action} legacy`);
    assert.equal(
      executes(action, localRole('match-to-csv-dev-ServiceRole-hash')),
      false,
      `${action} shared`,
    );
  }
  const toLambda = { 'iam:PassedToService': 'lambda.amazonaws.com' };
  assert.equal(executes('iam:PassRole', ephemeral, toLambda), true);
  assert.equal(executes('iam:PassRole', legacy, toLambda), false);
  assert.equal(
    executes(
      'iam:PassRole',
      role('match-to-csv-dev-ServiceRole-hash'),
      toLambda,
    ),
    false,
  );
});

test('execution cannot escalate or reach deployment through a template', () => {
  const ephemeral = localRole('match-to-csv-alice-ServiceRole-hash');
  for (const action of [
    'iam:DeleteRolePermissionsBoundary',
    'iam:CreatePolicy',
    'iam:CreatePolicyVersion',
    'iam:SetDefaultPolicyVersion',
    'iam:CreateUser',
    'iam:CreateAccessKey',
    'sts:AssumeRole',
  ]) {
    for (const resource of [
      '*',
      ephemeral,
      role('cdk-hnb659fds-deploy-role-000000000000-us-east-1'),
    ]) {
      assert.equal(
        executes(action, resource, bounded),
        false,
        `${action} ${resource}`,
      );
    }
  }
  for (const action of ['UpdateStack', 'CreateStack', 'DeleteStack']) {
    assert.equal(
      executes(`cloudformation:${action}`, stack('admin-alice')),
      false,
      action,
    );
  }
});

test('execution manages only ephemeral compute, by name', () => {
  for (const action of [
    'lambda:CreateFunction',
    'lambda:UpdateFunctionCode',
    'lambda:DeleteFunction',
  ]) {
    assert.equal(executes(action, fn('match-to-csv-alice-ProcessEmail')), true);
    assert.equal(executes(action, fn('match-to-csv-dev-ProcessEmail')), false);
  }
  for (const [action, resource] of [
    ['sqs:CreateQueue', queue('match-to-csv-alice-events-dlq')],
    [
      'logs:CreateLogGroup',
      `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/vendedlogs/states/match-to-csv-alice`,
    ],
    ['states:CreateStateMachine', machine('match-to-csv-alice-replay')],
    ['logs:DescribeLogGroups', '*'],
  ]) {
    assert.equal(executes(action, resource), true, resource);
  }
  // Names that merely contain an application, and aliases, executions, and streams of
  // other resources, do not match.
  for (const [action, resource] of [
    ['lambda:DeleteFunction', fn('sysadmin-rotate')],
    ['sqs:DeleteQueue', queue('team-player-events')],
    [
      'logs:DeleteLogGroup',
      `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/lambda/sysadmin-rotate`,
    ],
    ['lambda:UpdateAlias', `${fn('other-function')}:admin-x`],
    [
      'states:StopExecution',
      `arn:aws:states:us-east-1:${ACCOUNT}:execution:other-machine:admin-x`,
    ],
    [
      'logs:DeleteLogStream',
      `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:other:log-stream:admin-x`,
    ],
    ['lambda:DeleteFunction', fn('Match-To-Csv-alice-ProcessEmail')],
  ]) {
    assert.equal(executes(action, resource), false, resource);
  }
});

test('execution rules match only S3 events and deliver only to ephemeral compute', () => {
  const ephemeralRule = rule('match-to-csv-alice-RawEmailCreated');
  assert.equal(
    executes('events:PutRule', ephemeralRule, { 'events:source': ['aws.s3'] }),
    true,
  );
  for (const source of [['aws.states'], ['aws.s3', 'aws.states'], undefined]) {
    assert.equal(
      executes('events:PutRule', ephemeralRule, { 'events:source': source }),
      false,
      String(source),
    );
  }
  const target = (targets) =>
    executes('events:PutTargets', ephemeralRule, {
      'events:TargetArn': targets,
    });
  assert.equal(target([machine('match-to-csv-alice')]), true);
  assert.equal(
    target([fn('match-to-csv-alice-X'), queue('match-to-csv-alice-q')]),
    true,
  );
  assert.equal(target([machine('match-to-csv-dev')]), false);
  assert.equal(target([machine('match-to-csv-dev-replay')]), false);
  assert.equal(target([queue('player-dev-events')]), false);
  assert.equal(
    target([machine('match-to-csv-alice'), fn('other-function')]),
    false,
  );
  assert.equal(target(undefined), false);
  assert.equal(
    executes('events:PutRule', rule('match-to-csv-dev-Rule'), {
      'events:source': ['aws.s3'],
    }),
    false,
  );
  assert.equal(executes('events:DeleteRule', ephemeralRule), true);
});

test('execution manages receipt rules, reads only local assets, and decrypts only through S3', () => {
  for (const action of [
    'ses:CreateReceiptRule',
    'ses:UpdateReceiptRule',
    'ses:DeleteReceiptRule',
    'ses:DescribeReceiptRule',
    'ses:DescribeReceiptRuleSet',
  ]) {
    assert.equal(executes(action, '*'), true, action);
  }
  for (const action of [
    'ses:SetActiveReceiptRuleSet',
    'ses:DeleteReceiptRuleSet',
    'ses:CreateReceiptRuleSet',
  ]) {
    assert.equal(executes(action, '*'), false, action);
  }
  assert.equal(
    executes('s3:GetObject', 'arn:aws:s3:::local-assets/lambda.zip'),
    true,
  );
  assert.equal(
    executes('s3:GetObject', 'arn:aws:s3:::cdk-hnb659fds-assets/lambda.zip'),
    false,
  );
  assert.equal(
    executes('kms:Decrypt', '*', {
      'kms:ViaService': 's3.us-east-1.amazonaws.com',
    }),
    true,
  );
  assert.equal(executes('kms:Decrypt', '*'), false);
});

test('execution boundary allows every identity grant and denies deployment', () => {
  for (const entry of execution.Statement.filter(
    (item) => item.Effect === 'Allow',
  )) {
    for (const action of [entry.Action].flat()) {
      assert.equal(
        allowed(executionBoundary, action, '*'),
        true,
        `${entry.Sid} ${action}`,
      );
    }
  }
  for (const action of [
    'cloudformation:CreateStack',
    'sts:AssumeRole',
    'iam:DeleteRolePermissionsBoundary',
    'organizations:LeaveOrganization',
  ]) {
    assert.equal(allowed(executionBoundary, action, '*'), false, action);
  }
});

test('runtime roles cannot mutate compute, deploy stacks, or assume another role', () => {
  for (const [action, resource] of [
    ['lambda:UpdateFunctionCode', fn('match-to-csv-alice-Process')],
    ['lambda:CreateFunction', fn('match-to-csv-alice-New')],
    ['iam:PutRolePolicy', localRole('match-to-csv-alice-Role')],
    ['iam:PassRole', localRole('match-to-csv-alice-Role')],
    [
      'sts:AssumeRole',
      role('cdk-mcclocal1-deploy-role-000000000000-us-east-1'),
    ],
    ['cloudformation:UpdateStack', stack('match-to-csv-alice')],
    ['cloudformation:DeleteStack', stack('match-to-csv-dev')],
  ]) {
    assert.equal(allowed(runtime, action, resource), false, action);
    assert.equal(allowed(runtime, action, '*'), false, `${action} *`);
  }
  assert.equal(allowed(runtime, 'textract:AnalyzeDocument', '*'), true);
});

test('runtime uses its own ephemeral objects in this account only', () => {
  const alice = own('alice');
  assert.equal(
    allowed(runtime, 's3:PutObject', evidence('ephemeral/alice/run'), alice),
    true,
  );
  assert.equal(
    allowed(runtime, 's3:GetObject', evidence('incoming/alice/message'), alice),
    true,
  );
  for (const key of [
    'ephemeral/bob/run',
    'submissions/x/ingestion.json',
    'screenshots/a/source/original',
    // IAM's * spans /, so these would match without the key-root deny.
    'submissions/ephemeral/alice/x',
    'incoming/dev/ephemeral/alice/x',
  ]) {
    assert.equal(
      allowed(runtime, 's3:PutObject', evidence(key), alice),
      false,
      key,
    );
  }
  for (const key of [
    'incoming/bob/message',
    'submissions/incoming/alice/message',
  ]) {
    assert.equal(
      allowed(runtime, 's3:GetObject', evidence(key), alice),
      false,
      key,
    );
  }
  assert.equal(
    allowed(runtime, 's3:PutObject', evidence('ephemeral/alice/run'), {
      ...alice,
      's3:ResourceAccount': '111111111111',
    }),
    false,
    'another account',
  );
  assert.equal(
    allowed(runtime, 's3:PutObject', evidence('ephemeral/alice/run'), {
      's3:ResourceAccount': ACCOUNT,
    }),
    false,
    'untagged role',
  );
});

test('runtime denies shared inbound email and stable bootstrap assets even when allowed', () => {
  // Each case also matches an allow, so only the deny makes it false.
  assert.equal(
    allowed(
      runtime,
      's3:GetObject',
      evidence('incoming/devin/message'),
      own('devin'),
    ),
    false,
  );
  assert.equal(
    allowed(
      runtime,
      's3:PutObject',
      'arn:aws:s3:::cdk-hnb659fds-assets-000000000000-us-east-1/ephemeral/alice/x',
      own('alice'),
    ),
    false,
  );
  assert.equal(
    allowed(
      runtime,
      's3:PutObject',
      'arn:aws:s3:::local-evidence/ephemeral/alice/x',
      own('alice'),
    ),
    true,
    'control: the same key in another bucket is allowed',
  );
});

test('runtime lists only its own ephemeral prefix', () => {
  const list = (prefix) =>
    allowed(runtime, 's3:ListBucket', 'arn:aws:s3:::evidence', {
      ...own('alice'),
      's3:prefix': prefix,
    });
  assert.equal(list('ephemeral/alice/'), true);
  for (const prefix of [
    'ephemeral/bob/',
    'incoming/',
    'incoming/d',
    'incoming/dev/',
    'submissions/',
  ]) {
    assert.equal(list(prefix), false, prefix);
  }
  assert.equal(
    allowed(runtime, 's3:ListBucket', 'arn:aws:s3:::evidence', own('alice')),
    false,
    'listing the whole bucket',
  );
});

test('runtime uses keys only through S3 and invokes only ephemeral compute', () => {
  assert.equal(
    allowed(runtime, 'kms:Decrypt', '*', {
      'kms:ViaService': 's3.us-east-1.amazonaws.com',
    }),
    true,
  );
  for (const action of ['kms:Decrypt', 'kms:GenerateDataKey', 'kms:Encrypt']) {
    assert.equal(allowed(runtime, action, '*'), false, action);
  }
  assert.equal(
    allowed(runtime, 'lambda:InvokeFunction', fn('match-to-csv-alice-Process')),
    true,
  );
  for (const resource of [
    fn('match-to-csv-dev-Process'),
    `${fn('other-function')}:match-to-csv-x`,
  ]) {
    assert.equal(
      allowed(runtime, 'lambda:InvokeFunction', resource),
      false,
      resource,
    );
  }
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
      `arn:aws:states:us-east-1:${ACCOUNT}:execution:match-to-csv-dev:run`,
    ),
    false,
  );
  for (const action of [
    'logs:CreateLogDelivery',
    'logs:PutResourcePolicy',
    'logs:DescribeLogGroups',
    'xray:GetSamplingRules',
    'xray:GetSamplingTargets',
  ]) {
    assert.equal(allowed(runtime, action, '*'), true, action);
  }
});

test('lookup role reads only stack metadata and the bootstrap version', () => {
  const lookup = resources.LookupRole.Properties;
  const policy = lookup.Policies[0].PolicyDocument;
  assert.deepEqual(lookup.ManagedPolicyArns, []);
  assert.equal(lookup.Policies.length, 1);
  assert.equal(
    allowed(
      policy,
      'ssm:GetParameter',
      parameter('cdk-bootstrap/mcclocal1/version'),
    ),
    true,
  );
  assert.equal(allowed(policy, 'cloudformation:GetTemplate', '*'), true);
  for (const [action, resource] of [
    ['ssm:GetParameter', parameter('mcc/dev/match-to-csv/data-key-arn')],
    ['s3:GetObject', evidence('ephemeral/alice/run')],
    ['lambda:ListFunctions', '*'],
    ['logs:StartLiveTail', '*'],
    ['ecr:BatchGetImage', '*'],
  ]) {
    assert.equal(allowed(policy, action, resource), false, action);
  }
});

test('local roles trust only this account and the template keeps upstream shape', () => {
  assert.equal(upstream.Parameters.Qualifier.Default, 'hnb659fds');
  assert.deepEqual(template.Parameters.Qualifier.AllowedValues, [
    LOCAL_QUALIFIER,
  ]);
  for (const name of [
    'DeploymentActionRole',
    'FilePublishingRole',
    'ImagePublishingRole',
    'LookupRole',
  ]) {
    const trust = resources[name].Properties.AssumeRolePolicyDocument;
    assert.ok(!JSON.stringify(trust).includes('TrustedAccounts'), name);
    assert.ok(
      trust.Statement.some(
        (entry) =>
          entry.Action === 'sts:AssumeRole' &&
          entry.Principal?.AWS?.Ref === 'AWS::AccountId',
      ),
      name,
    );
  }
  const withoutTrust = (resource) => {
    const copy = structuredClone(resource);
    delete copy.Properties.AssumeRolePolicyDocument;
    return copy;
  };
  for (const name of ['FilePublishingRole', 'ImagePublishingRole']) {
    assert.deepEqual(
      withoutTrust(resources[name]),
      withoutTrust(upstream.Resources[name]),
      name,
    );
  }
  assert.deepEqual(
    resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns,
    [
      { Ref: 'LocalExecutionPolicy' },
      { Ref: 'LocalExecutionComputePolicy' },
      { Ref: 'LocalExecutionEventsPolicy' },
    ],
  );
  assert.deepEqual(
    resources.CloudFormationExecutionRole.Properties.PermissionsBoundary,
    { Ref: 'LocalExecutionBoundary' },
  );
  const missing = structuredClone(upstream);
  delete missing.Resources.DeploymentActionRole;
  assert.throws(
    () => localBootstrap(missing),
    /review the CDK template upgrade/,
  );
});

test('IAM managed policies remain below the 6144 character limit', () => {
  for (const name of LOCAL_POLICY_RESOURCES) {
    const size = JSON.stringify(policyOf(name)).length;
    assert.ok(size < 6144, `${name} is ${size} characters`);
  }
});

test('the local permission set assumes only the four local roles', () => {
  const permissionSet = JSON.parse(
    readFileSync(
      'docs/self-hosting/policies/local-cdk-deployer-dev.json.template',
      'utf8',
    ),
  );
  const roleName = (name) =>
    resources[name].Properties.RoleName['Fn::Sub']
      .replace('${Qualifier}', LOCAL_QUALIFIER)
      .replace('${AWS::AccountId}', 'DEV_ACCOUNT_ID')
      .replace('${AWS::Region}', 'AWS_REGION');
  const assume = (name) =>
    allowed(
      permissionSet,
      'sts:AssumeRole',
      `arn:aws:iam::DEV_ACCOUNT_ID:role/${name}`,
    );
  for (const name of [
    'DeploymentActionRole',
    'FilePublishingRole',
    'ImagePublishingRole',
    'LookupRole',
  ]) {
    assert.equal(assume(roleName(name)), true, name);
  }
  for (const name of [
    'cdk-hnb659fds-deploy-role-DEV_ACCOUNT_ID-AWS_REGION',
    'cdk-mcclocal1-cfn-exec-role-DEV_ACCOUNT_ID-AWS_REGION',
    'OrganizationAccountAccessRole',
  ]) {
    assert.equal(assume(name), false, name);
  }
  assert.equal(
    allowed(
      permissionSet,
      'ssm:GetParameter',
      'arn:aws:ssm:AWS_REGION:DEV_ACCOUNT_ID:parameter/cdk-bootstrap/mcclocal1/version',
    ),
    true,
  );
  assert.equal(
    allowed(
      permissionSet,
      'ssm:GetParameter',
      'arn:aws:ssm:AWS_REGION:DEV_ACCOUNT_ID:parameter/mcc/dev/match-to-csv/data-key-arn',
    ),
    false,
  );
});

test('the toolkit stack policy keeps the local policies from being deleted', () => {
  const stackPolicy = JSON.parse(
    readFileSync(
      'docs/self-hosting/policies/local-cdk-toolkit-stack-policy.json',
      'utf8',
    ),
  );
  for (const name of LOCAL_POLICY_RESOURCES) {
    assert.ok(resources[name], `${name} exists in the template`);
    const protectedResource = `LogicalResourceId/${name}`;
    assert.ok(
      stackPolicy.Statement.some(
        (entry) =>
          entry.Effect === 'Deny' &&
          [entry.Action].flat().includes('Update:Delete') &&
          [entry.Action].flat().includes('Update:Replace') &&
          [entry.Resource].flat().includes(protectedResource),
      ),
      name,
    );
  }
  assert.ok(
    stackPolicy.Statement.some(
      (entry) => entry.Effect === 'Allow' && entry.Resource === '*',
    ),
  );
});

test('ephemeral deploys name the local change set unless deploying directly', () => {
  const named = ['--change-set-name', LOCAL_CHANGE_SET_NAME];
  assert.deepEqual(localDeployArguments([]), named);
  assert.deepEqual(
    localDeployArguments(['--require-approval', 'never']),
    named,
  );
  assert.deepEqual(localDeployArguments(['-R', '-f']), named);
  assert.deepEqual(localDeployArguments(['--method=direct']), []);
  assert.deepEqual(localDeployArguments(['--method', 'direct']), []);
});

test('ephemeral deploys reject options the local bootstrap cannot run', () => {
  for (const [options, message] of [
    [['--hotswap'], /cannot hotswap/],
    [['--hotswap-fallback'], /cannot hotswap/],
    [['--hotswapFallback'], /cannot hotswap/],
    [['--watch'], /cannot hotswap/],
    [['--role-arn', 'other'], /role ARN/],
    [['--role-arn=other'], /role ARN/],
    [['--roleArn', 'other'], /role ARN/],
    [['--toolkit-stack-name', 'CDKToolkit'], /toolkit stack/],
    [['--toolkitStackName=CDKToolkit'], /toolkit stack/],
    [['--change-set-name', 'mine'], /change-set name/],
    [['--change-set-name=mine'], /change-set name/],
    [['--changeSetName', 'mine'], /change-set name/],
    [['-r', 'other'], /short -r or -m/],
    [['-vr', 'other'], /short -r or -m/],
    [['-m', 'direct'], /short -r or -m/],
    [['-mdirect'], /short -r or -m/],
    [['-fm', 'direct'], /short -r or -m/],
    [['--method=change-set'], /only --method=direct/],
    [['--method', 'prepare-change-set'], /only --method=direct/],
    [['--METHOD=direct'], /only --method=direct/],
    [['--method'], /only --method=direct/],
    [['--method=direct', '--method=change-set'], /only --method=direct/],
  ]) {
    assert.throws(
      () => localDeployArguments(options),
      message,
      options.join(' '),
    );
  }
});

test('the wrapper adds local bootstrap options only to ephemeral deploys', () => {
  const base = {
    application: 'match-to-csv',
    environment: 'dev',
    expectedAccount: ACCOUNT,
    profile: 'mcc-dev',
    emailDomain: 'example.invalid',
    passthrough: [],
  };
  const local = (args) =>
    args.includes('--toolkit-stack-name') || args.includes('--change-set-name');
  const stable = cdkArguments({ ...base, action: 'deploy' });
  assert.equal(local(stable), false);
  assert.ok(!stable.some((argument) => argument.startsWith('ephemeral=')));
  for (const action of ['synth', 'diff', 'destroy']) {
    assert.equal(
      local(cdkArguments({ ...base, action, ephemeral: 'alice' })),
      false,
      action,
    );
  }
  const ephemeral = cdkArguments({
    ...base,
    action: 'deploy',
    ephemeral: 'alice',
    passthrough: ['--require-approval', 'never'],
  });
  assert.deepEqual(ephemeral, [
    'run',
    'cdk:deploy',
    '--workspace',
    '@samlevin/match-to-csv',
    '--',
    '-c',
    'environment=dev',
    '-c',
    'ephemeral=alice',
    '-c',
    `expectedAccount=${ACCOUNT}`,
    '--profile',
    'mcc-dev',
    '--toolkit-stack-name',
    'CDKToolkitLocal',
    '--change-set-name',
    LOCAL_CHANGE_SET_NAME,
    '--parameters',
    'EmailDomain=example.invalid',
    '--require-approval',
    'never',
  ]);
});

test('the wrapper rejects reserved names and unsupported options before any AWS call', () => {
  // No PATH: reaching aws, git, or npm would fail differently.
  const run = (args) =>
    spawnSync(process.execPath, ['scripts/cdk-app.mjs', ...args], {
      encoding: 'utf8',
      env: { PATH: '/nonexistent', AWS_PROFILE: 'mcc-dev' },
    });
  for (const [args, message] of [
    [
      ['deploy', 'admin', '--environment', 'dev', '--ephemeral', 'devin'],
      /reserved/,
    ],
    [
      ['diff', 'admin', '--environment', 'dev', '--ephemeral', 'Sam'],
      /Ephemeral names must/,
    ],
    [
      [
        'deploy',
        'admin',
        '--environment',
        'dev',
        '--ephemeral',
        'alice',
        '--hotswap',
      ],
      /cannot hotswap/,
    ],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, args.join(' '));
    assert.match(result.stderr, message, args.join(' '));
  }
});

// Synthesis needs the compiled cdk-config package.
execFileSync('npm', ['run', 'build:shared', '--silent'], { stdio: 'ignore' });
const require = createRequire(import.meta.url);
const { resolveDeployment } = require('../packages/cdk-config/dist/index.js');

test('the wrapper and cdk-config apply the same ephemeral name rule', () => {
  const context = (ephemeral) => ({
    tryGetContext: (key) => ({ environment: 'dev', ephemeral })[key],
  });
  for (const ephemeral of [
    'sam',
    'kevin',
    'adev',
    'sam-2',
    'dev',
    'devin',
    'admin-dev',
    'sam-devtest',
    'Sam',
    '-sam',
    'a'.repeat(20),
    'a'.repeat(21),
  ]) {
    let error;
    try {
      resolveDeployment(context(ephemeral), 'admin', {});
    } catch (caught) {
      error = caught.message;
    }
    assert.equal(ephemeralNameError(ephemeral), error, ephemeral);
  }
});

// Run each application's bin entry the way the CDK CLI does, without the CLI.
const run = promisify(execFile);
async function synthesize(app, context) {
  const outdir = mkdtempSync(join(tmpdir(), `mcc-${app}-`));
  await run(
    process.execPath,
    [
      join(process.cwd(), 'node_modules/ts-node/dist/bin.js'),
      '--prefer-ts-exts',
      `cdk/bin/${app}.ts`,
    ],
    {
      cwd: join(process.cwd(), 'applications', app),
      env: {
        ...process.env,
        CDK_OUTDIR: outdir,
        CDK_DEFAULT_REGION: 'us-east-1',
        CDK_CONTEXT_JSON: JSON.stringify({
          'aws:cdk:bundling-stacks': [],
          ...context,
        }),
      },
    },
  );
  const stackName = context.ephemeral
    ? `${app}-${context.ephemeral}`
    : `${app}-${context.environment}`;
  return {
    stackName,
    template: JSON.parse(
      readFileSync(join(outdir, `${stackName}.template.json`), 'utf8'),
    ),
  };
}
// The longest allowed name checks that generated names keep the application prefix.
const longName = 'a'.repeat(20);
const synthesized = Promise.all([
  ...APPLICATIONS.map((app) =>
    synthesize(app, { environment: 'dev', ephemeral: longName }),
  ),
  synthesize('admin', { environment: 'dev' }),
]);

test('every ephemeral application uses the local bootstrap and role path', async () => {
  const templates = await synthesized;
  const boundaryName =
    resources.LocalWorkloadBoundary.Properties.ManagedPolicyName;
  for (const { stackName, template: synthesizedTemplate } of templates.slice(
    0,
    -1,
  )) {
    assert.equal(
      synthesizedTemplate.Parameters.BootstrapVersion.Default,
      `/cdk-bootstrap/${LOCAL_QUALIFIER}/version`,
      stackName,
    );
    const roles = Object.values(synthesizedTemplate.Resources ?? {}).filter(
      (resource) => resource.Type === 'AWS::IAM::Role',
    );
    for (const resource of roles) {
      assert.equal(resource.Properties.Path, LOCAL_ROLE_PATH, stackName);
      assert.ok(
        JSON.stringify(resource.Properties.PermissionsBoundary).includes(
          `:policy/${boundaryName}`,
        ),
        stackName,
      );
    }
  }
  const [{ template: stable }] = templates.slice(-1);
  assert.equal(
    stable.Parameters.BootstrapVersion.Default,
    '/cdk-bootstrap/hnb659fds/version',
  );
  for (const resource of Object.values(stable.Resources ?? {})) {
    if (resource.Type === 'AWS::IAM::Role')
      assert.equal(resource.Properties.Path, undefined, 'shared roles keep /');
  }
});

test('every match-to-csv ephemeral resource falls under the local execution policy', async () => {
  const templates = await synthesized;
  const { stackName, template: synthesizedTemplate } =
    templates[APPLICATIONS.indexOf('match-to-csv')];
  // CloudFormation names unnamed resources <stack>-<logical id>-<suffix>, up to 64 characters.
  const generated = (logicalId) =>
    `${stackName}-${logicalId}`.slice(0, 51) + '-ABCDEFGHIJKL';
  const names = new Map(
    Object.entries(synthesizedTemplate.Resources)
      .filter(
        ([, resource]) => resource.Type === 'AWS::StepFunctions::StateMachine',
      )
      .map(([logicalId, resource]) => [
        logicalId,
        machine(resource.Properties.StateMachineName ?? generated(logicalId)),
      ]),
  );
  let checked = 0;
  for (const [logicalId, resource] of Object.entries(
    synthesizedTemplate.Resources,
  )) {
    const properties = resource.Properties ?? {};
    const check = (action, resourceArn, context) => {
      assert.equal(
        executes(action, resourceArn, context),
        true,
        `${logicalId} ${action}`,
      );
      checked += 1;
    };
    switch (resource.Type) {
      case 'AWS::Lambda::Function':
        check(
          'lambda:CreateFunction',
          fn(properties.FunctionName ?? generated(logicalId)),
        );
        break;
      case 'AWS::StepFunctions::StateMachine':
        check('states:CreateStateMachine', names.get(logicalId));
        break;
      case 'AWS::SQS::Queue':
        check(
          'sqs:CreateQueue',
          queue(properties.QueueName ?? generated(logicalId)),
        );
        break;
      case 'AWS::Logs::LogGroup':
        check(
          'logs:CreateLogGroup',
          `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:${properties.LogGroupName}`,
        );
        break;
      case 'AWS::IAM::Role':
        check(
          'iam:CreateRole',
          localRole(properties.RoleName ?? generated(logicalId)),
          bounded,
        );
        break;
      case 'AWS::Events::Rule':
        check('events:PutRule', rule(properties.Name ?? generated(logicalId)), {
          'events:source': properties.EventPattern.source,
        });
        check(
          'events:PutTargets',
          rule(properties.Name ?? generated(logicalId)),
          {
            'events:TargetArn': properties.Targets.map(
              (target) =>
                names.get(target.Arn.Ref) ?? fn(generated(target.Arn.Ref)),
            ),
          },
        );
        break;
      default:
    }
  }
  assert.ok(checked > 10, `checked ${checked} resources`);
});
