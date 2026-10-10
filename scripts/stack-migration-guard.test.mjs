import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findUnsafeRemovals } from './stack-migration-guard.mjs';

const ruleSet = (policy) => ({
  Type: 'AWS::SES::ReceiptRuleSet',
  ...(policy ? { DeletionPolicy: policy } : {}),
  Properties: { RuleSetName: 'mcc-match-to-csv-dev' },
});
const rule = (policy) => ({
  Type: 'AWS::SES::ReceiptRule',
  ...(policy ? { DeletionPolicy: policy } : {}),
  Properties: { RuleSetName: 'mcc-match-to-csv-dev' },
});
const activation = (withDelete) => ({
  Type: 'Custom::AWS',
  Properties: {
    Create: '{"action":"setActiveReceiptRuleSet"}',
    Update: '{"action":"setActiveReceiptRuleSet"}',
    ...(withDelete ? { Delete: '{"action":"setActiveReceiptRuleSet"}' } : {}),
  },
});
const template = (resources) => ({ Resources: resources });
const unrelated = { Type: 'AWS::SQS::Queue', Properties: {} };

test('keeping every resource is always safe', () => {
  const live = template({
    ReceiptRuleSet: ruleSet(),
    StoreRawEmail: rule(),
    Activate: activation(true),
  });
  assert.deepEqual(findUnsafeRemovals(live, live), []);
});

test('removing unretained receipt resources is refused', () => {
  const live = template({
    ReceiptRuleSet: ruleSet(),
    StoreRawEmail: rule(),
    Activate: activation(true),
    Queue: unrelated,
  });
  const problems = findUnsafeRemovals(live, template({ Queue: unrelated }));
  assert.equal(problems.length, 3);
  assert.match(problems[0], /^ReceiptRuleSet .*deleted/);
  assert.match(problems[1], /^StoreRawEmail .*deleted/);
  assert.match(problems[2], /^Activate .*deactivate/);
});

test('removing retained receipt resources is allowed', () => {
  for (const policy of ['Retain', 'RetainExceptOnCreate']) {
    const live = template({
      ReceiptRuleSet: ruleSet(policy),
      StoreRawEmail: rule(policy),
      Activate: activation(false),
    });
    assert.deepEqual(findUnsafeRemovals(live, template({})), []);
  }
});

test('removing unrelated resources is allowed', () => {
  const live = template({ Queue: unrelated, ReceiptRuleSet: ruleSet() });
  const next = template({ ReceiptRuleSet: ruleSet() });
  assert.deepEqual(findUnsafeRemovals(live, next), []);
});

test('an activation whose delete handler is an intrinsic is still caught', () => {
  const live = template({
    Activate: {
      Type: 'Custom::AWS',
      Properties: {
        Delete: { 'Fn::Join': ['', ['{"action":"setActiveReceiptRuleSet"']] },
      },
    },
  });
  assert.equal(findUnsafeRemovals(live, template({})).length, 1);
});

test('a missing stack or empty template has nothing to protect', () => {
  assert.deepEqual(findUnsafeRemovals(undefined, template({})), []);
  assert.deepEqual(findUnsafeRemovals({}, template({})), []);
});
