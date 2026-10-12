import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  findUnsafeRemovals,
  parseTemplateBody,
  rolledBackMessage,
  stableDeployOptionsError,
  stackArtifact,
  stackStatusAction,
} from './stack-migration-guard.mjs';

test('a rolled-back first create names what it kept and how to recover', () => {
  const message = rolledBackMessage('match-to-csv-dev', [
    {
      LogicalResourceId: 'WorkflowLogs',
      ResourceType: 'AWS::Logs::LogGroup',
      PhysicalResourceId: '/aws/vendedlogs/states/match-to-csv-dev',
      ResourceStatus: 'DELETE_SKIPPED',
    },
    {
      LogicalResourceId: 'Workflow',
      ResourceType: 'AWS::StepFunctions::StateMachine',
      PhysicalResourceId: 'arn',
      ResourceStatus: 'DELETE_COMPLETE',
    },
  ]);
  assert.match(message, /^match-to-csv-dev is ROLLBACK_COMPLETE/);
  assert.match(
    message,
    /WorkflowLogs \(AWS::Logs::LogGroup\): \/aws\/vendedlogs\/states\/match-to-csv-dev/,
  );
  assert.doesNotMatch(message, /StateMachine/);
  assert.match(
    message,
    /--no-enable-termination-protection --stack-name match-to-csv-dev/,
  );
  assert.match(message, /delete-stack --stack-name match-to-csv-dev$/);
  assert.match(rolledBackMessage('s', undefined), /kept no retained resources/);
});

test('queues, log groups, and the extra replacement properties are guarded', () => {
  const live = template({
    Dlq: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'a' } },
    Logs: { Type: 'AWS::Logs::LogGroup', Properties: {} },
  });
  assert.equal(findUnsafeRemovals(live, template({})).length, 2);
  const changed = [
    ['AWS::SQS::Queue', { QueueName: 'a' }, { QueueName: 'b' }],
    ['AWS::Logs::LogGroup', { LogGroupName: 'a' }, { LogGroupName: 'b' }],
    [
      'AWS::DynamoDB::Table',
      { LocalSecondaryIndexes: [{ IndexName: 'a' }] },
      { LocalSecondaryIndexes: [{ IndexName: 'b' }] },
    ],
    ['AWS::KMS::Key', { MultiRegion: false }, { MultiRegion: true }],
    ['AWS::KMS::Key', { Origin: 'AWS_KMS' }, { Origin: 'EXTERNAL' }],
  ];
  for (const [type, before, after] of changed) {
    const problems = findUnsafeRemovals(
      template({ R: { Type: type, Properties: before } }),
      template({ R: { Type: type, Properties: after } }),
    );
    assert.equal(problems.length, 1, `${type} ${JSON.stringify(after)}`);
  }
});

test('the stack comes from the cloud assembly manifest', () => {
  const artifacts = {
    Tree: { type: 'cdk:tree' },
    'match-to-csv-dev': {
      type: 'aws:cloudformation:stack',
      properties: { templateFile: 'match-to-csv-dev.template.json' },
    },
  };
  assert.deepEqual(stackArtifact({ artifacts }), {
    stackName: 'match-to-csv-dev',
    templateFile: 'match-to-csv-dev.template.json',
  });
  assert.equal(
    stackArtifact({
      artifacts: {
        Id: {
          type: 'aws:cloudformation:stack',
          properties: {
            stackName: 'renamed',
            templateFile: 'Id.template.json',
          },
        },
      },
    }).stackName,
    'renamed',
  );
  assert.throws(() => stackArtifact({ artifacts: {} }), /found 0/);
  assert.throws(
    () =>
      stackArtifact({
        artifacts: {
          ...artifacts,
          Other: { type: 'aws:cloudformation:stack', properties: {} },
        },
      }),
    /found 2/,
  );
});

test('stable deploys accept only --require-approval', () => {
  assert.equal(stableDeployOptionsError([]), undefined);
  assert.equal(
    stableDeployOptionsError(['--require-approval', 'never']),
    undefined,
  );
  assert.equal(
    stableDeployOptionsError(['--require-approval=broadening']),
    undefined,
  );
  for (const options of [
    ['--no-staging'],
    ['--app', 'other'],
    ['--require-approval'],
    ['--require-approval', '--exclusively'],
    ['--require-approval', 'never', 'match-to-csv-dev'],
  ]) {
    assert.match(
      stableDeployOptionsError(options),
      /accept only --require-approval/,
      options.join(' '),
    );
  }
});

const stateful = (type, policy) => ({
  Type: type,
  ...(policy ? { DeletionPolicy: policy } : {}),
  Properties: {},
});
const custom = (withDelete) => ({
  Type: 'Custom::AWS',
  Properties: {
    Create: '{"action":"setActiveReceiptRuleSet"}',
    ...(withDelete ? { Delete: '{"action":"setActiveReceiptRuleSet"}' } : {}),
  },
});
const template = (resources) => ({ Resources: resources });
const stateless = { Type: 'AWS::Lambda::Function', Properties: {} };

test('keeping every resource is always safe', () => {
  const live = template({
    RuleSet: stateful('AWS::SES::ReceiptRuleSet'),
    Bucket: stateful('AWS::S3::Bucket'),
    Activate: custom(true),
  });
  assert.deepEqual(findUnsafeRemovals(live, live), []);
});

test('removing unretained stateful resources is refused', () => {
  const live = template({
    RuleSet: stateful('AWS::SES::ReceiptRuleSet'),
    Rule: stateful('AWS::SES::ReceiptRule', 'Delete'),
    Table: stateful('AWS::DynamoDB::Table'),
    Fn: stateless,
  });
  const problems = findUnsafeRemovals(live, template({ Fn: stateless }));
  assert.deepEqual(
    problems.map((problem) => problem.split(' ')[0]),
    ['RuleSet', 'Rule', 'Table'],
  );
  assert.match(problems[0], /DeletionPolicy is Delete$/);
});

test('removing retained stateful resources is allowed', () => {
  for (const policy of ['Retain', 'RetainExceptOnCreate']) {
    const live = template({
      RuleSet: stateful('AWS::SES::ReceiptRuleSet', policy),
      Bucket: stateful('AWS::S3::Bucket', policy),
    });
    assert.deepEqual(findUnsafeRemovals(live, template({})), []);
  }
});

test('removing an AwsCustomResource with a delete call is refused', () => {
  const live = template({ Activate: custom(true) });
  const problems = findUnsafeRemovals(live, template({}));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^Activate .*delete handler$/);
});

test('removing an AwsCustomResource without a delete call is allowed', () => {
  const live = template({ Activate: custom(false) });
  assert.deepEqual(findUnsafeRemovals(live, template({})), []);
});

test('removing a provider-framework custom resource is refused', () => {
  for (const type of [
    'Custom::S3AutoDeleteObjects',
    'AWS::CloudFormation::CustomResource',
  ]) {
    const live = template({ Handler: { Type: type, Properties: {} } });
    const problems = findUnsafeRemovals(live, template({}));
    assert.equal(problems.length, 1, type);
    assert.match(problems[0], /delete handler$/);
  }
});

test('removing a retained custom resource is allowed', () => {
  const live = template({
    Activate: { ...custom(true), DeletionPolicy: 'Retain' },
    Handler: { Type: 'Custom::Other', DeletionPolicy: 'Retain' },
  });
  assert.deepEqual(findUnsafeRemovals(live, template({})), []);
});

test('replacing an unretained stateful resource is refused', () => {
  const bucket = (name, policy) => ({
    Type: 'AWS::S3::Bucket',
    ...(policy ? { UpdateReplacePolicy: policy } : {}),
    Properties: { BucketName: name },
  });
  const problems = findUnsafeRemovals(
    template({ Bucket: bucket('old') }),
    template({ Bucket: bucket('new') }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^Bucket .*replaced because BucketName changed/);
  assert.deepEqual(
    findUnsafeRemovals(
      template({ Bucket: bucket('old', 'Retain') }),
      template({ Bucket: bucket('new') }),
    ),
    [],
  );
  assert.deepEqual(
    findUnsafeRemovals(
      template({ Bucket: bucket('same') }),
      template({ Bucket: bucket('same') }),
    ),
    [],
  );
});

test('replacing a receipt rule set by name is refused', () => {
  const ruleSet = (name) => ({
    Type: 'AWS::SES::ReceiptRuleSet',
    UpdateReplacePolicy: 'Delete',
    Properties: { RuleSetName: name },
  });
  const problems = findUnsafeRemovals(
    template({ RuleSet: ruleSet('a') }),
    template({ RuleSet: ruleSet('b') }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /UpdateReplacePolicy is Delete$/);
});

test('removing stateless resources is allowed', () => {
  const live = template({ Fn: stateless, Bucket: stateful('AWS::S3::Bucket') });
  const next = template({ Bucket: stateful('AWS::S3::Bucket') });
  assert.deepEqual(findUnsafeRemovals(live, next), []);
});

test('a renamed stateful resource counts as a removal', () => {
  const live = template({ OldBucket: stateful('AWS::S3::Bucket') });
  const next = template({ NewBucket: stateful('AWS::S3::Bucket') });
  assert.equal(findUnsafeRemovals(live, next).length, 1);
});

test('a missing stack or empty template has nothing to protect', () => {
  assert.deepEqual(findUnsafeRemovals(undefined, template({})), []);
  assert.deepEqual(findUnsafeRemovals({}, template({})), []);
});

test('only settled stacks are compared', () => {
  for (const status of [
    'CREATE_COMPLETE',
    'UPDATE_COMPLETE',
    'UPDATE_ROLLBACK_COMPLETE',
    'IMPORT_COMPLETE',
    'IMPORT_ROLLBACK_COMPLETE',
  ]) {
    assert.equal(stackStatusAction(status), 'compare', status);
  }
  assert.equal(stackStatusAction('ROLLBACK_COMPLETE'), 'rolled-back');
  assert.equal(stackStatusAction('REVIEW_IN_PROGRESS'), 'skip');
  for (const status of [
    'UPDATE_IN_PROGRESS',
    'UPDATE_ROLLBACK_IN_PROGRESS',
    'UPDATE_ROLLBACK_FAILED',
    'DELETE_FAILED',
    'None',
    '',
  ]) {
    assert.equal(stackStatusAction(status), 'refuse', status);
  }
});

test('template bodies parse or fail closed', () => {
  const resources = { Resources: { Bucket: { Type: 'AWS::S3::Bucket' } } };
  assert.deepEqual(parseTemplateBody(resources), resources);
  assert.deepEqual(parseTemplateBody(JSON.stringify(resources)), resources);
  assert.throws(
    () => parseTemplateBody('Resources:\n  Bucket: {}'),
    /not JSON/,
  );
  assert.throws(() => parseTemplateBody(null), /empty/);
  assert.throws(() => parseTemplateBody(undefined), /empty/);
});
