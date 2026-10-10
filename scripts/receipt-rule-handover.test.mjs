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
const deactivate =
  '{"service":"SES","action":"setActiveReceiptRuleSet","parameters":{}}';

const beforeRetain = {
  Resources: {
    ReceiptRuleSet: ruleSet(),
    StoreRawEmail: rule(),
    Activate: activation({ Create: create, Delete: deactivate }),
  },
};
const retained = {
  Resources: {
    ReceiptRuleSet: ruleSet({ DeletionPolicy: 'Retain' }),
    StoreRawEmail: rule({ DeletionPolicy: 'Retain' }),
    Activate: activation({ Create: create, Update: create }),
  },
};
const dropped = { Resources: { Other: { Type: 'AWS::SNS::Topic' } } };

test('blocks dropping the resources from a stack deployed before the retain release', () => {
  const blockers = handoverBlockers(beforeRetain, dropped);
  assert.equal(blockers.length, 3);
  assert.match(blockers[0], /ReceiptRuleSet .* not retained/);
  assert.match(blockers[2], /Activate would deactivate/);
});

test('allows the retain release itself on a stack deployed before it', () => {
  assert.deepEqual(handoverBlockers(beforeRetain, retained), []);
});

test('allows dropping the resources once the deployed stack retains them', () => {
  assert.deepEqual(handoverBlockers(retained, dropped), []);
});

test('blocks a replacement that changes the type behind a logical ID', () => {
  const incoming = {
    Resources: { ReceiptRuleSet: { Type: 'AWS::SNS::Topic' } },
  };
  assert.deepEqual(
    handoverBlockers({ Resources: { ReceiptRuleSet: ruleSet() } }, incoming),
    [
      'ReceiptRuleSet (AWS::SES::ReceiptRuleSet) would be deleted because it is not retained',
    ],
  );
});

test('allows a deployed stack that declares no receipt resources', () => {
  assert.deepEqual(handoverBlockers({ Resources: {} }, beforeRetain), []);
  assert.deepEqual(handoverBlockers(undefined, dropped), []);
});

test('detects a Delete call built with Fn::Join', () => {
  const blockers = handoverBlockers(
    {
      Resources: {
        Activate: activation({
          Delete: {
            'Fn::Join': ['', ['{"action":"setActiveReceiptRuleSet"}']],
          },
        }),
      },
    },
    dropped,
  );
  assert.deepEqual(blockers, [
    'Activate would deactivate the receipt rule set when it is removed',
  ]);
});
