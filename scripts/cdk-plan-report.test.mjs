import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import {
  assemblyDirectory,
  diffChanges,
  planReport,
  readPlanAssembly,
  runDiff,
} from './cdk-plan-report.mjs';

const deployment = {
  application: 'match-to-csv',
  stackName: 'match-to-csv-e-test',
  environment: 'dev',
  ephemeral: 'test',
  objectPrefix: 'ephemeral/test',
  workloadBoundaryName: 'test-boundary',
};
const template = {
  Description: 'Email to CSV',
  Parameters: {
    Shared: {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/mcc/dev/match-to-csv/evidence-bucket-name',
    },
    BootstrapVersion: {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/cdk-bootstrap/version',
    },
  },
  Resources: {
    ProcessEmail123: {
      Type: 'AWS::Lambda::Function',
      Metadata: {
        'aws:cdk:path': 'stack/ProcessEmail/Resource',
        'mcc:nameOrigin': 'explicitly configured',
        'mcc:component': {
          group: 'Email intake',
          purpose: 'Validate sender and preserve attachments',
        },
      },
      Properties: {
        FunctionName: 'test-ProcessEmail',
        Environment: {
          Variables: {
            SENDER_ALLOWLIST_PARAMETER: '/mcc/dev/sender-allowlist',
          },
        },
      },
    },
    Role123: { Type: 'AWS::IAM::Role' },
    Policy123: {
      Type: 'AWS::IAM::Policy',
      Metadata: { 'mcc:nameOrigin': 'CDK-generated' },
      Properties: { PolicyName: 'DefaultPolicy123' },
    },
    Queue123: {
      Type: 'AWS::SQS::Queue',
      Properties: { QueueName: { Ref: 'QueueParameter' } },
    },
    Unknown123: { Type: 'Custom::Unknown' },
  },
};
const raw = `Stack match-to-csv-e-test
IAM Statement Changes
+ Allow s3:GetObject
Resources
[+] AWS::Lambda::Function ProcessEmail ProcessEmail123
[~] AWS::IAM::Role Role Role123 replace
 └─ [~] RoleName (requires replacement)
[-] AWS::Events::Rule OldRule Deleted123 destroy
[~] AWS::SQS::Queue Queue Queue123 may be replaced
[~] AWS::IAM::Policy Policy Policy123
Stack another-stack
[-] AWS::Lambda::Function Other Other123
`;

test('template resources, component purposes, names and shared references explain the checked target', () => {
  const report = planReport({
    deployment,
    gitSha: 'source-commit',
    template,
    awsEnvironment: 'aws://test-account/test-region',
    raw,
    status: 1,
  });
  for (const value of [
    'match-to-csv-e-test',
    'test-account',
    'test-region',
    'ephemeral/test',
    'source-commit',
    'Email intake',
    'ProcessEmail123 | AWS::Lambda::Function',
    'stack/ProcessEmail/Resource',
    'Validate sender',
    'explicitly configured: test-ProcessEmail',
    'CDK-generated: DefaultPolicy123',
    'generated name; unavailable before deployment',
    'unresolved until deployment',
    'name unavailable',
    'Shared: /mcc/dev/match-to-csv/evidence-bucket-name',
    'not created by this stack',
    'test-boundary',
    'Runtime SSM reference: /mcc/dev/sender-allowlist',
    'CDK exit status: 1',
  ])
    assert.ok(report.includes(value), value);
  assert.ok(!report.includes('/cdk-bootstrap/version'));
  assert.ok(!report.includes('Add Unknown123'));
});

test('actual CDK change lines preserve deletion paths, replacement uncertainty and permission evidence', () => {
  const report = planReport({
    deployment,
    template,
    raw: `\u001b[32m${raw}\u001b[0m`,
    status: 0,
  });
  assert.equal(diffChanges(raw, deployment.stackName).length, 5);
  assert.match(report, /Add ProcessEmail123/);
  assert.match(report, /Update Role123.*replacement required by CDK/);
  assert.match(report, /Changed fields: RoleName \(requires replacement\)/);
  assert.deepEqual(
    diffChanges('[~] Custom::Thing Thing123', deployment.stackName)[0],
    {
      type: 'Custom::Thing',
      path: 'path unavailable',
      logicalId: 'Thing123',
      action: 'Update',
      impact: undefined,
      fields: [],
    },
  );
  assert.match(
    report,
    /Delete Deleted123.*OldRule.*purpose unavailable.*destroy/,
  );
  assert.match(report, /Update Queue123.*replacement possible, not confirmed/);
  assert.match(report, /Update Policy123.*replacement status not established/);
  assert.match(report, /CDK reports permission changes/);
  assert.match(report, /does not infer whether access is broader/);
  assert.ok(!report.includes('Other123'));
});

test('missing optional context, unchanged resources, filtered or failed diffs do not invent certainty', () => {
  const report = planReport({
    deployment: {
      application: 'admin',
      stackName: 'admin-dev',
      environment: 'dev',
    },
    template,
    raw: 'There were no differences',
    status: 0,
  });
  assert.match(report, /Account: unavailable \| Region: unavailable/);
  assert.match(report, /Source commit: unavailable/);
  assert.match(report, /Ephemeral: \(none\)/);
  assert.match(report, /CDK reports no differences/);
  assert.match(report, /not proof of no changes/);
  assert.match(
    planReport({ deployment, raw: 'AccessDenied', status: 2 }),
    /No resource change lines recognized/,
  );
});

test('reads only a fresh assembly for the exact stack, with output passthrough left intact', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mcc-plan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'output'));
  const output = join(directory, 'output');
  const manifest = join(output, 'manifest.json');
  writeFileSync(
    manifest,
    JSON.stringify({
      artifacts: {
        DifferentId: {
          type: 'aws:cloudformation:stack',
          environment: 'aws://test/region',
          properties: {
            stackName: deployment.stackName,
            templateFile: 'stack.json',
          },
        },
      },
    }),
  );
  writeFileSync(join(output, 'stack.json'), JSON.stringify(template));
  assert.deepEqual(readPlanAssembly(output, deployment.stackName, 0), {
    template,
    awsEnvironment: 'aws://test/region',
  });
  assert.throws(
    () => readPlanAssembly(output, 'another-stack', 0),
    /No synthesized stack/,
  );
  writeFileSync(
    manifest,
    JSON.stringify({
      artifacts: {
        [deployment.stackName]: {
          type: 'aws:cloudformation:stack',
          environment: 'aws://test/region',
          properties: { templateFile: 'stack.json' },
        },
      },
    }),
  );
  assert.deepEqual(
    readPlanAssembly(output, deployment.stackName, 0).template,
    template,
  );
  utimesSync(manifest, 1, 1);
  assert.throws(
    () => readPlanAssembly(output, deployment.stackName, Date.now()),
    /fresh cloud assembly/,
  );
  for (const args of [
    ['--output', output],
    [`--output=${output}`],
    ['-o', output],
    [`-o=${output}`],
  ])
    assert.equal(assemblyDirectory('match-to-csv', args), output);
  assert.equal(
    assemblyDirectory('admin', ['--', '--output', output]),
    resolve('applications/admin/cdk.out'),
  );
});

test('raw stdout, stderr, exit status, options, and environment survive the diff subprocess', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mcc-plan-command-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, 'npm'),
    `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2))+'\\n'+process.env.TEST_VALUE+'\\n'); process.stderr.write('raw error\\n'); process.exitCode=7;`,
  );
  chmodSync(join(directory, 'npm'), 0o755);
  let stdout = '',
    stderr = '';
  const stream = (append) =>
    new Writable({
      write(chunk, encoding, done) {
        append(chunk.toString());
        done();
      },
    });
  const args = [
    'run',
    'cdk:diff',
    '--',
    '--fail',
    '--quiet',
    '--output=some path',
  ];
  const result = await runDiff(
    args,
    { PATH: directory, TEST_VALUE: 'kept' },
    stream((s) => (stdout += s)),
    stream((s) => (stderr += s)),
  );
  assert.equal(result.status, 7);
  assert.equal(stdout, `${JSON.stringify(args)}\nkept\n`);
  assert.equal(stderr, 'raw error\n');
  assert.ok(result.raw.includes(stdout));
  assert.ok(result.raw.includes(stderr));
});

test('wrapper reports the fresh synthesized target and retains a failing CDK status without AWS', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mcc-plan-wrapper-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tool = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const name = path.basename(process.argv[1]);
if(name === 'aws') console.log(JSON.stringify({Account:'111111111111',Arn:'test-caller'}));
if(name === 'git') console.log('source-commit');
if(name === 'npm' && process.argv[3] === 'cdk:diff') {
  if (!process.env.OMIT_ASSEMBLY) {
    fs.writeFileSync(path.join(process.env.TEST_OUTPUT,'manifest.json'),JSON.stringify({artifacts:{'match-to-csv-e-test':{type:'aws:cloudformation:stack',environment:'aws://111111111111/test-region',properties:{templateFile:'stack.json'}}}}));
    fs.writeFileSync(path.join(process.env.TEST_OUTPUT,'stack.json'),process.env.TEST_TEMPLATE);
  }
  fs.writeSync(1,'[+] AWS::Lambda::Function ProcessEmail ProcessEmail123\\n');
  fs.writeSync(2,'raw diagnostic\\n');
  process.exitCode=5;
}`;
  for (const name of ['aws', 'git', 'npm']) {
    writeFileSync(join(directory, name), tool);
    chmodSync(join(directory, name), 0o755);
  }
  const args = [
    'scripts/cdk-app.mjs',
    'diff',
    'match-to-csv',
    '--environment=dev',
    '--ephemeral=test',
    '--output',
    directory,
    '--fail',
  ];
  const env = {
    PATH: directory,
    AWS_PROFILE: 'mcc-dev',
    MCC_DEV_ACCOUNT_ID: '111111111111',
    TEST_OUTPUT: directory,
    TEST_TEMPLATE: JSON.stringify(template),
  };
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  assert.equal(result.status, 5, result.stderr);
  assert.match(
    result.stdout,
    /^.*\[\+\] AWS::Lambda::Function ProcessEmail ProcessEmail123/m,
  );
  assert.match(result.stderr, /raw diagnostic/);
  assert.match(result.stdout, /Stack: match-to-csv-e-test/);
  assert.match(result.stdout, /Region: test-region/);
  assert.match(result.stdout, /Source commit: source-commit/);
  assert.match(result.stdout, /stack\/ProcessEmail\/Resource/);
  assert.match(result.stdout, /Add ProcessEmail123/);
  utimesSync(join(directory, 'manifest.json'), 1, 1);
  const missing = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...env, OMIT_ASSEMBLY: '1' },
  });
  assert.equal(missing.status, 5, missing.stderr);
  assert.match(
    missing.stderr,
    /summary unavailable: CDK did not write a fresh cloud assembly/,
  );
  assert.match(missing.stdout, /CDK exit status: 5/);
  const malformed = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: {
      ...env,
      TEST_TEMPLATE: JSON.stringify({ Resources: { Invalid: null } }),
    },
  });
  assert.equal(malformed.status, 5);
  assert.match(malformed.stderr, /Plan explanation unavailable/);
});
