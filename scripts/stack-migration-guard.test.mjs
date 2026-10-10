import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findUnsafeRemovals } from './stack-migration-guard.mjs';

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

test('removing a custom resource with a delete call is refused', () => {
  const live = template({ Activate: custom(true) });
  const problems = findUnsafeRemovals(live, template({}));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^Activate .*delete call$/);
});

test('removing a custom resource without a delete call is allowed', () => {
  const live = template({ Activate: custom(false) });
  assert.deepEqual(findUnsafeRemovals(live, template({})), []);
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
