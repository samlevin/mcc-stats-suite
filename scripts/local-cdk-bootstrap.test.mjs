import assert from 'node:assert/strict';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
  LOCAL_EXECUTION_BOUNDARY,
  LOCAL_EXECUTION_POLICIES,
  LOCAL_GUARD_RESOURCE,
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
const deployment =
  resources.DeploymentActionRole.Properties.Policies[0].PolicyDocument;

const ACCOUNT = '000000000000';
const replacements = {
  'AWS::Partition': 'aws',
  'AWS::AccountId': ACCOUNT,
  'AWS::Region': 'us-east-1',
  'StagingBucket.Arn': 'arn:aws:s3:::local-assets',
};
function resolve(value) {
  if (typeof value === 'string') return value;
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
// Only the operators the template's inline policies emit; anything else fails loudly.
// The local CDK permission policies are OpenTofu's, and
// infrastructure/modules/foundation/tests checks them.
const operators = {
  StringEquals: (actual, expected) =>
    actual !== undefined &&
    [actual].flat().some((value) => expected.includes(value)),
  StringLike: (actual, expected) =>
    actual !== undefined &&
    [actual].flat().some((value) => expected.some((p) => matches(p, value))),
};
function conditionsHold(condition = {}, context) {
  return Object.entries(condition).every(([operator, keys]) => {
    const holds = operators[operator];
    if (!holds) throw new Error(`Unsupported condition operator ${operator}`);
    return Object.entries(keys).every(([key, expected]) =>
      holds(context[key], [expected].flat().map(resolve)),
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
        .some((item) => matches(resolve(item), resource)) &&
      conditionsHold(entry.Condition, context)
    );
  });
  return (
    relevant.some((entry) => entry.Effect === 'Allow') &&
    !relevant.some((entry) => entry.Effect === 'Deny')
  );
}

const stack = (name) =>
  `arn:aws:cloudformation:us-east-1:${ACCOUNT}:stack/${name}/id`;
const evidence = (key) => `arn:aws:s3:::evidence/${key}`;
const parameter = (name) =>
  `arn:aws:ssm:us-east-1:${ACCOUNT}:parameter/${name}`;
const localPolicy = (name) => ({
  'Fn::Sub': `arn:${'${AWS::Partition}'}:iam::${'${AWS::AccountId}'}:policy/${name}`,
});

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

test('deployment reads only bootstrap and application parameters', () => {
  for (const name of [
    'cdk-bootstrap/mcclocal1/version',
    ...APPLICATIONS.map((app) => `mcc/dev/${app}/evidence-bucket-name`),
  ]) {
    for (const action of ['ssm:GetParameter', 'ssm:GetParameters']) {
      assert.equal(allowed(deployment, action, parameter(name)), true, name);
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
  // The dev foundation owns the local policies; the template only attaches them.
  assert.deepEqual(
    resources.CloudFormationExecutionRole.Properties.ManagedPolicyArns,
    LOCAL_EXECUTION_POLICIES.map(localPolicy),
  );
  assert.deepEqual(
    resources.CloudFormationExecutionRole.Properties.PermissionsBoundary,
    localPolicy(LOCAL_EXECUTION_BOUNDARY),
  );
  assert.deepEqual(LOCAL_EXECUTION_POLICIES, [
    'mcc-stats-suite-local-cdk-execution',
    'mcc-stats-suite-local-cdk-execution-compute',
    'mcc-stats-suite-local-cdk-execution-events',
  ]);
  assert.equal(
    LOCAL_EXECUTION_BOUNDARY,
    'mcc-stats-suite-local-cdk-execution-boundary',
  );
  assert.deepEqual(
    Object.keys(resources).filter(
      (name) => resources[name].Type === 'AWS::IAM::ManagedPolicy',
    ),
    Object.keys(upstream.Resources).filter(
      (name) => upstream.Resources[name].Type === 'AWS::IAM::ManagedPolicy',
    ),
    'the template adds no managed policies',
  );
  const missing = structuredClone(upstream);
  delete missing.Resources.DeploymentActionRole;
  assert.throws(
    () => localBootstrap(missing),
    /review the CDK template upgrade/,
  );
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

test('the toolkit stack policy keeps the guard from being deleted', () => {
  const stackPolicy = JSON.parse(
    readFileSync(
      'docs/self-hosting/policies/local-cdk-toolkit-stack-policy.json',
      'utf8',
    ),
  );
  // A default re-bootstrap removes the guard, so the stack policy rejects it.
  assert.equal(
    resources[LOCAL_GUARD_RESOURCE].Type,
    'AWS::CloudFormation::WaitConditionHandle',
  );
  assert.equal(upstream.Resources[LOCAL_GUARD_RESOURCE], undefined);
  assert.ok(
    stackPolicy.Statement.some(
      (entry) =>
        entry.Effect === 'Deny' &&
        [entry.Action].flat().includes('Update:Delete') &&
        [entry.Action].flat().includes('Update:Replace') &&
        [entry.Resource]
          .flat()
          .includes(`LogicalResourceId/${LOCAL_GUARD_RESOURCE}`),
    ),
  );
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
  const boundaryName = 'mcc-stats-suite-local-workload-boundary';
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

// infrastructure/modules/foundation/tests checks that the local CDK policies grant
// only names under <application>-e-. This checks that every resource the execution
// role creates for match-to-csv has such a name, including names CloudFormation
// generates.
test('every match-to-csv ephemeral resource is named for the local execution policy', async () => {
  const templates = await synthesized;
  const { stackName, template: synthesizedTemplate } =
    templates[APPLICATIONS.indexOf('match-to-csv')];
  const prefix = 'match-to-csv-e-';
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
  const resources = synthesizedTemplate.Resources;
  const nameOf = (logicalId) => {
    const properties = resources[logicalId].Properties ?? {};
    return (
      properties.FunctionName ??
      properties.StateMachineName ??
      properties.QueueName ??
      properties.RoleName ??
      properties.Name ??
      generated(logicalId)
    );
  };
  let checked = 0;
  let logGroupsChecked = 0;
  const check = (logicalId, name) => {
    assert.ok(name.startsWith(prefix), `${logicalId} ${name}`);
    checked += 1;
  };
  for (const [logicalId, resource] of Object.entries(resources)) {
    const properties = resource.Properties ?? {};
    switch (resource.Type) {
      case 'AWS::Lambda::Function':
      case 'AWS::StepFunctions::StateMachine':
      case 'AWS::SQS::Queue':
      case 'AWS::IAM::Role':
        check(logicalId, nameOf(logicalId));
        break;
      case 'AWS::Logs::LogGroup':
        assert.ok(
          matches(`/aws/*/${prefix}*`, properties.LogGroupName),
          `${logicalId} ${properties.LogGroupName}`,
        );
        logGroupsChecked += 1;
        break;
      case 'AWS::Events::Rule':
        check(logicalId, nameOf(logicalId));
        // Rules may match only S3 events and deliver only to ephemeral compute.
        assert.deepEqual(properties.EventPattern.source, ['aws.s3'], logicalId);
        for (const target of properties.Targets) {
          check(target.Arn.Ref, nameOf(target.Arn.Ref));
        }
        break;
      default:
    }
  }
  assert.equal(logGroupsChecked, 6);
  assert.ok(checked > 10, `checked ${checked} resources`);
});
