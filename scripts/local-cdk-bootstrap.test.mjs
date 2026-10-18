import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
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
  LOCAL_TOOLKIT_STACK_NAME,
  cdkArguments,
  ephemeralNameError,
  localDeployArguments,
} from './cdk-targets.mjs';
import {
  INLINE_TEMPLATE_BODY_LIMIT,
  LOCAL_POLICY_RESOURCES,
  LOCAL_TEMPLATE_FILE,
  localBootstrap,
  pinnedBootstrapTemplate,
  renderLocalBootstrap,
} from './local-cdk-bootstrap.mjs';

const upstream = pinnedBootstrapTemplate();
const template = localBootstrap(upstream);
const LOCAL_ROOT = 'infrastructure/dev/local-cdk';
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
          stack(`${app}-e-alice`),
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
      allowed(deployment, `cloudformation:${action}`, stack('admin-e-alice')),
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

test('local policies contain no shared-name deny lists', () => {
  for (const resource of Object.values(resources)) {
    const documents = [
      resource.Properties?.PolicyDocument,
      ...(resource.Properties?.Policies ?? []).map(
        (policy) => policy.PolicyDocument,
      ),
    ];
    for (const document of documents.filter(Boolean)) {
      for (const entry of document.Statement.filter(
        (entry) => entry.Effect === 'Deny',
      )) {
        assert.ok(!JSON.stringify(entry).includes('-dev'), entry.Sid);
      }
    }
  }
});

test('every application allows ephemeral roles and compute and excludes shared names', () => {
  for (const app of APPLICATIONS) {
    for (const suffix of ['e-alice', 'e-devin', 'dev', 'prod', 'alice']) {
      const expected = suffix.startsWith('e-');
      assert.equal(
        executes('iam:CreateRole', localRole(`${app}-${suffix}-Role`), bounded),
        expected,
      );
      assert.equal(
        executes('lambda:CreateFunction', fn(`${app}-${suffix}-Function`)),
        expected,
      );
      assert.equal(
        executes('states:CreateStateMachine', machine(`${app}-${suffix}`)),
        expected,
      );
      assert.equal(
        executes('sqs:CreateQueue', queue(`${app}-${suffix}-Queue`)),
        expected,
      );
      assert.equal(
        executes('events:PutRule', rule(`${app}-${suffix}-Rule`), {
          'events:source': ['aws.s3'],
        }),
        expected,
      );
    }
  }
});

test('shared stacks and names without the -e- prefix are outside the ephemeral namespace', () => {
  for (const name of [
    'admin-dev',
    'match-to-csv-dev-replay',
    'admin-alice',
    'admin-prod',
  ]) {
    assert.equal(
      allowed(deployment, 'cloudformation:DeleteStack', stack(name)),
      false,
      name,
    );
  }
});

test('deployment deletes failed ephemeral stacks without a role', () => {
  assert.equal(
    allowed(deployment, 'cloudformation:DeleteStack', stack('admin-e-alice')),
    true,
  );
});

test('deployment executes the local change set by name or ARN only', () => {
  const execute = (changeSet) =>
    allowed(
      deployment,
      'cloudformation:ExecuteChangeSet',
      stack('admin-e-alice'),
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
    ...APPLICATIONS.map((app) => `mcc/dev/${app}/evidence-bucket-name`),
  ]) {
    for (const action of ['ssm:GetParameter', 'ssm:GetParameters']) {
      assert.equal(allowed(deployment, action, parameter(name)), true, name);
      assert.equal(executes(action, parameter(name)), true, name);
    }
  }
  for (const name of [
    'mcc-ci/dev/turbo-cache/bucket-name',
    'mcc-ci/dev/turbo-cache/data-key-arn',
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
  const ephemeral = localRole('match-to-csv-e-alice-ServiceRole-hash');
  // Roles outside the local path, such as roles made by hand, sit at path /.
  const rootPathRole = role('match-to-csv-e-alice-ServiceRole-hash');
  assert.equal(executes('iam:CreateRole', ephemeral), false);
  assert.equal(executes('iam:CreateRole', ephemeral, bounded), true);
  assert.equal(executes('iam:CreateRole', rootPathRole, bounded), false);
  for (const action of [
    'iam:PutRolePolicy',
    'iam:DeleteRolePolicy',
    'iam:AttachRolePolicy',
    'iam:DetachRolePolicy',
  ]) {
    assert.equal(executes(action, ephemeral, bounded), true, action);
    assert.equal(executes(action, ephemeral), false, `${action} unbounded`);
    assert.equal(
      executes(action, rootPathRole, bounded),
      false,
      `${action} root path`,
    );
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
    assert.equal(executes(action, rootPathRole), false, `${action} root path`);
    assert.equal(
      executes(action, localRole('match-to-csv-dev-ServiceRole-hash')),
      false,
      `${action} shared`,
    );
  }
  const toLambda = { 'iam:PassedToService': 'lambda.amazonaws.com' };
  assert.equal(executes('iam:PassRole', ephemeral, toLambda), true);
  assert.equal(executes('iam:PassRole', rootPathRole, toLambda), false);
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
  const ephemeral = localRole('match-to-csv-e-alice-ServiceRole-hash');
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
      executes(`cloudformation:${action}`, stack('admin-e-alice')),
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
    assert.equal(
      executes(action, fn('match-to-csv-e-alice-ProcessEmail')),
      true,
    );
    assert.equal(executes(action, fn('match-to-csv-dev-ProcessEmail')), false);
  }
  for (const [action, resource] of [
    ['sqs:CreateQueue', queue('match-to-csv-e-alice-events-dlq')],
    [
      'logs:CreateLogGroup',
      `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/vendedlogs/states/match-to-csv-e-alice`,
    ],
    ['states:CreateStateMachine', machine('match-to-csv-e-alice-replay')],
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
  const ephemeralRule = rule('match-to-csv-e-alice-RawEmailCreated');
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
  assert.equal(target([machine('match-to-csv-e-alice')]), true);
  assert.equal(
    target([fn('match-to-csv-e-alice-X'), queue('match-to-csv-e-alice-q')]),
    true,
  );
  assert.equal(target([machine('match-to-csv-dev')]), false);
  assert.equal(target([machine('match-to-csv-dev-replay')]), false);
  assert.equal(target([queue('player-dev-events')]), false);
  assert.equal(
    target([machine('match-to-csv-e-alice'), fn('other-function')]),
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
    ['lambda:UpdateFunctionCode', fn('match-to-csv-e-alice-Process')],
    ['lambda:CreateFunction', fn('match-to-csv-e-alice-New')],
    ['iam:PutRolePolicy', localRole('match-to-csv-e-alice-Role')],
    ['iam:PassRole', localRole('match-to-csv-e-alice-Role')],
    [
      'sts:AssumeRole',
      role('cdk-mcclocal1-deploy-role-000000000000-us-east-1'),
    ],
    ['cloudformation:UpdateStack', stack('match-to-csv-e-alice')],
    ['cloudformation:DeleteStack', stack('match-to-csv-dev')],
  ]) {
    assert.equal(allowed(runtime, action, resource), false, action);
    assert.equal(allowed(runtime, action, '*'), false, `${action} *`);
  }
  assert.equal(allowed(runtime, 'textract:AnalyzeDocument', '*'), true);
  assert.equal(
    allowed(
      runtime,
      'logs:PutLogEvents',
      `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:/aws/vendedlogs/states/match-to-csv-dev:log-stream:x`,
    ),
    false,
    'shared dev log groups',
  );
});

test('runtime reads only dev application parameters, one at a time', () => {
  for (const name of [
    'mcc/dev/match-to-csv/sender-allowlist',
    'mcc/dev/match-to-csv/email-alias',
    'mcc/dev/match-to-csv/email-domain',
    ...APPLICATIONS.map((app) => `mcc/dev/${app}/config`),
  ]) {
    assert.equal(
      allowed(runtime, 'ssm:GetParameter', parameter(name)),
      true,
      name,
    );
  }
  // The boundary is one ARN, so it stays the same size as applications are added.
  const parameterStatements = runtime.Statement.filter((entry) =>
    [entry.Action].flat().some((action) => action.startsWith('ssm:')),
  );
  assert.deepEqual(
    parameterStatements.map((entry) => [
      entry.Sid,
      entry.Effect,
      entry.Action,
      resolve(entry.Resource),
    ]),
    [
      [
        'ReadApplicationParameters',
        'Allow',
        'ssm:GetParameter',
        parameter('mcc/dev/*'),
      ],
    ],
  );
  for (const [action, name] of [
    ['ssm:GetParameter', 'mcc/prod/match-to-csv/email-alias'],
    ['ssm:GetParameter', 'mcc/prod/admin/config'],
    ['ssm:GetParameter', 'mcc-ci/dev/turbo-cache/bucket-name'],
    ['ssm:GetParameter', 'mcc-ci/dev/turbo-cache/data-key-arn'],
    ['ssm:GetParameter', 'mcc-ci/prod/turbo-cache/bucket-name'],
    ['ssm:GetParameter', 'cdk-bootstrap/mcclocal1/version'],
    ['ssm:GetParameter', 'cdk-bootstrap/hnb659fds/version'],
    ['ssm:GetParameters', 'mcc/dev/match-to-csv/email-alias'],
    ['ssm:GetParametersByPath', 'mcc/dev/match-to-csv'],
    ['ssm:PutParameter', 'mcc/dev/match-to-csv/email-alias'],
    ['ssm:DeleteParameter', 'mcc/dev/match-to-csv/email-alias'],
  ]) {
    assert.equal(
      allowed(runtime, action, parameter(name)),
      false,
      `${action} ${name}`,
    );
  }
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

test('runtime can read inbound email for names beginning with dev', () => {
  assert.equal(
    allowed(
      runtime,
      's3:GetObject',
      evidence('incoming/devin/message'),
      own('devin'),
    ),
    true,
  );
});

test('runtime denies shared inbound email and stable bootstrap assets even when allowed', () => {
  // Each case also matches an allow, so only the deny makes it false.
  assert.equal(
    allowed(
      runtime,
      's3:GetObject',
      evidence('incoming/dev/message'),
      own('dev'),
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
    allowed(
      runtime,
      'lambda:InvokeFunction',
      fn('match-to-csv-e-alice-Process'),
    ),
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
      allowed(runtime, `states:${action}`, machine('match-to-csv-e-alice')),
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
    readFileSync(`${LOCAL_ROOT}/stack-policy.json`, 'utf8'),
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

test('the committed local bootstrap template matches a fresh generation', () => {
  assert.ok(
    readFileSync(LOCAL_TEMPLATE_FILE, 'utf8') ===
      renderLocalBootstrap(upstream),
    `${LOCAL_ROOT}/bootstrap-template.yaml is stale; run npm run cdk:local-template and commit it`,
  );
});

test('the committed local bootstrap template fits an inline template body', () => {
  const { size } = statSync(LOCAL_TEMPLATE_FILE);
  assert.ok(
    size <= INLINE_TEMPLATE_BODY_LIMIT,
    `${LOCAL_ROOT}/bootstrap-template.yaml is ${size} bytes; CloudFormation accepts at most ${INLINE_TEMPLATE_BODY_LIMIT} bytes inline`,
  );
});

test('the local-cdk root deploys the committed template as the local toolkit stack', () => {
  const root = readFileSync(`${LOCAL_ROOT}/main.tf`, 'utf8');
  const stacks = [...root.matchAll(/^resource "([^"]+)"/gm)].map(
    ([, type]) => type,
  );
  assert.deepEqual(stacks, ['aws_cloudformation_stack']);
  const value = (name) =>
    root.match(new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`, 'm'))?.[1];
  assert.equal(value('name'), `"${LOCAL_TOOLKIT_STACK_NAME}"`);
  assert.equal(
    value('template_body'),
    'file("${path.module}/bootstrap-template.yaml")',
  );
  assert.equal(
    LOCAL_TEMPLATE_FILE,
    join(process.cwd(), LOCAL_ROOT, 'bootstrap-template.yaml'),
  );
  assert.equal(
    value('policy_body'),
    'file("${path.module}/stack-policy.json")',
  );
  assert.equal(value('capabilities'), '["CAPABILITY_NAMED_IAM"]');
  assert.equal(value('Qualifier'), `"${LOCAL_QUALIFIER}"`);
  // `cdk bootstrap` passes this value; the template's empty default would
  // create a customer-managed KMS key.
  assert.equal(value('FileAssetsBucketKmsKeyId'), '"AWS_MANAGED_KEY"');
  assert.equal(template.Parameters.FileAssetsBucketKmsKeyId.Default, '');
  assert.equal(value('prevent_destroy'), 'true');
  assert.ok(!existsSync('infrastructure/prod/local-cdk'), 'dev only');
});

test('Terrateam plans the local-cdk root, in dev only, when its template or stack policy changes', () => {
  const config = parse(readFileSync('.terrateam/config.yml', 'utf8'));
  const entry = config.dirs[LOCAL_ROOT];
  assert.ok(entry, `${LOCAL_ROOT} has a Terrateam entry`);
  assert.ok(entry.tags.includes('dev'));
  assert.ok(!entry.tags.includes('prod'));
  // Terrateam globs: * stays within one directory.
  const plans = (file) =>
    entry.when_modified.file_patterns.some((pattern) =>
      new RegExp(
        `^${pattern
          .replace('${DIR}', LOCAL_ROOT)
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replaceAll('*', '[^/]*')}$`,
      ).test(file),
    );
  for (const file of [
    'main.tf',
    'versions.tf',
    '.terraform.lock.hcl',
    'bootstrap-template.yaml',
    'stack-policy.json',
  ]) {
    assert.ok(plans(`${LOCAL_ROOT}/${file}`), file);
  }
  assert.ok(plans('.terrateam/config.yml'));
  assert.ok(!plans(`${LOCAL_ROOT}/.envrc.example`));
});

test('only the dev Terrateam role may manage the local toolkit stack and its IAM resources', () => {
  const grant = readFileSync(
    'infrastructure/modules/bootstrap/local-cdk-bootstrap-management.tf',
    'utf8',
  );
  const local = (name) => {
    const value = grant.match(
      new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, 'm'),
    )?.[1];
    assert.ok(value, `bootstrap must set ${name}`);
    return value;
  };
  assert.equal(local('local_cdk_toolkit_stack_name'), LOCAL_TOOLKIT_STACK_NAME);
  const prefix = (name) => {
    const pattern = local(name);
    assert.match(pattern, /^[a-z0-9-]+-\*$/, `${name} is a name prefix`);
    return pattern.slice(0, -1);
  };
  const rolePrefix = prefix('local_cdk_role_name_pattern');
  const policyPrefix = prefix('local_cdk_policy_name_pattern');

  const ofType = (type) =>
    Object.entries(resources).filter(([, resource]) => resource.Type === type);
  const roles = ofType('AWS::IAM::Role');
  assert.ok(roles.length >= 5, 'the template creates the bootstrap roles');
  for (const [name, resource] of roles) {
    const roleName = resource.Properties.RoleName['Fn::Sub'].replace(
      '${Qualifier}',
      LOCAL_QUALIFIER,
    );
    assert.ok(roleName.startsWith(rolePrefix), `${name} is ${roleName}`);
    // The grant matches role ARNs without a path.
    assert.equal(resource.Properties.Path, undefined, `${name} has no path`);
  }
  for (const [name, resource] of ofType('AWS::IAM::ManagedPolicy')) {
    if (resource.Condition) {
      // The example boundary exists only with --example-permissions-boundary,
      // which the local bootstrap never passes.
      assert.equal(name, 'CdkBoostrapPermissionsBoundaryPolicy');
      assert.equal(
        template.Parameters.UseExamplePermissionsBoundary.Default,
        'false',
      );
      continue;
    }
    assert.ok(
      resource.Properties.ManagedPolicyName.startsWith(policyPrefix),
      `${name} is ${resource.Properties.ManagedPolicyName}`,
    );
  }
  for (const name of LOCAL_POLICY_RESOURCES) {
    assert.ok(
      resources[name].Properties.ManagedPolicyName.startsWith(policyPrefix),
      name,
    );
  }

  assert.match(
    readFileSync('infrastructure/dev/bootstrap/main.tf', 'utf8'),
    /^\s*manage_local_cdk_bootstrap\s*=\s*true\s*$/m,
  );
  for (const file of ['main.tf', 'bootstrap.auto.tfvars.example']) {
    assert.doesNotMatch(
      readFileSync(`infrastructure/prod/bootstrap/${file}`, 'utf8'),
      /manage_local_cdk_bootstrap/,
    );
  }
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
    '@mcc/match-to-csv',
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
      ['deploy', 'admin', '--environment', 'dev', '--ephemeral', 'dev'],
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
if (!existsSync('packages/cdk-config/dist/index.js'))
  execFileSync('npm', ['run', 'build:shared', '--silent'], {
    stdio: 'inherit',
  });
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
    'prod',
    'devin',
    'admin-dev',
    'sam-devtest',
    'Sam',
    '-sam',
    'a'.repeat(20),
    'a'.repeat(21),
    'ephemeral',
    'incoming',
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
    ? `${app}-e-${context.ephemeral}`
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
const STACK_NAME_KEPT = 25;

test('every application prefix survives CloudFormation name truncation', () => {
  for (const app of APPLICATIONS) {
    assert.ok(
      `${app}-e-`.length <= STACK_NAME_KEPT,
      `${app}-e- would be cut from generated names; shorten the application name`,
    );
  }
});
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
    assert.match(stackName, /-e-aaaaaaaaaaaaaaaaaaaa$/);
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

test('ephemeral email and evidence routing retains the instance name', async () => {
  const templates = await synthesized;
  const { template } = templates[APPLICATIONS.indexOf('match-to-csv')];
  const values = Object.values(template.Resources);
  const receipt = values.find(
    (resource) => resource.Type === 'AWS::SES::ReceiptRule',
  ).Properties.Rule;
  assert.equal(receipt.Name, `match-to-csv-e-${longName}`);
  assert.ok(JSON.stringify(receipt.Recipients).includes(`"+${longName}@"`));
  const processEmail = values.find(
    (resource) =>
      resource.Properties?.FunctionName ===
      `match-to-csv-e-${longName}-ProcessEmail`,
  );
  assert.equal(
    processEmail.Properties.Environment.Variables.RECIPIENT_SUBADDRESS,
    longName,
  );
  assert.equal(
    receipt.Actions[0].S3Action.ObjectKeyPrefix,
    `incoming/${longName}/`,
  );
  const rule = values.find((resource) => resource.Type === 'AWS::Events::Rule');
  assert.deepEqual(rule.Properties.EventPattern.detail.object.key, [
    { prefix: `incoming/${longName}/` },
  ]);
  const functions = values.filter(
    (resource) => resource.Type === 'AWS::Lambda::Function',
  );
  assert.ok(
    functions.some(
      (resource) =>
        resource.Properties.Environment?.Variables?.OBJECT_PREFIX ===
        `ephemeral/${longName}`,
    ),
  );
});

test('every match-to-csv ephemeral resource falls under the local execution policy', async () => {
  const templates = await synthesized;
  const { stackName, template: synthesizedTemplate } =
    templates[APPLICATIONS.indexOf('match-to-csv')];
  // CloudFormation names unnamed resources <stack>-<logical id>-<suffix>, up to
  // 64 characters. Its truncation is undocumented, so assume the worst observed:
  // a long stack name keeps only its first STACK_NAME_KEPT characters.
  const generated = (logicalId) => {
    const full = `${stackName}-${logicalId}`;
    const kept =
      full.length <= 51
        ? full
        : `${stackName.slice(0, STACK_NAME_KEPT)}-${logicalId}`.slice(0, 51);
    return `${kept}-ABCDEFGHIJKL`;
  };
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
  let logGroupsChecked = 0;
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
        for (const action of [
          'logs:CreateLogGroup',
          'logs:PutRetentionPolicy',
          'logs:DeleteLogGroup',
        ]) {
          check(
            action,
            `arn:aws:logs:us-east-1:${ACCOUNT}:log-group:${properties.LogGroupName}`,
          );
        }
        logGroupsChecked += 1;
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
  assert.equal(logGroupsChecked, 6);
  assert.ok(checked > 10, `checked ${checked} resources`);
});
