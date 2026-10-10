import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handoverBlockers } from './receipt-rule-handover.mjs';

const ruleSet = (extra = {}) => ({
  Type: 'AWS::SES::ReceiptRuleSet',
  Properties: { RuleSetName: 'mcc-match-to-csv-dev' },
  ...extra,
});
const rule = (extra = {}) => ({
  Type: 'AWS::SES::ReceiptRule',
  Properties: { RuleSetName: 'mcc-match-to-csv-dev' },
  ...extra,
});
const activation = (properties) => ({
  Type: 'Custom::AWS',
  Properties: properties,
});
const create = '{"service":"SES","action":"setActiveReceiptRuleSet"}';

test('blocks a stack deployed before the retain release', () => {
  const blockers = handoverBlockers({
    Resources: {
      ReceiptRuleSet: ruleSet(),
      StoreRawEmail: rule(),
      Activate: activation({
        Create: create,
        Delete:
          '{"service":"SES","action":"setActiveReceiptRuleSet","parameters":{}}',
      }),
    },
  });
  assert.equal(blockers.length, 3);
});

test('allows a stack that retains the rules and never deactivates them', () => {
  assert.deepEqual(
    handoverBlockers({
      Resources: {
        ReceiptRuleSet: ruleSet({ DeletionPolicy: 'Retain' }),
        StoreRawEmail: rule({ DeletionPolicy: 'Retain' }),
        Activate: activation({ Create: create, Update: create }),
      },
    }),
    [],
  );
});

test('allows a stack that no longer declares receipt resources', () => {
  assert.deepEqual(handoverBlockers({ Resources: {} }), []);
  assert.deepEqual(handoverBlockers(undefined), []);
});

test('detects a Delete call built with Fn::Join', () => {
  const blockers = handoverBlockers({
    Resources: {
      Activate: activation({
        Delete: { 'Fn::Join': ['', ['{"action":"setActiveReceiptRuleSet"}']] },
      }),
    },
  });
  assert.deepEqual(blockers, [
    'Activate deactivates the receipt rule set on delete',
  ]);
});
