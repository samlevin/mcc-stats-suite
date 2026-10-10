import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { handoverBlockers } from './receipt-rule-handover.mjs';

const script = fileURLToPath(
  new URL('./receipt-rule-handover.mjs', import.meta.url),
);
const runCli = (args, input) =>
  spawnSync(process.execPath, [script, ...args], { input, encoding: 'utf8' });

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

test('the CLI reads the deployed template from stdin, string-encoded or not', () => {
  const incomingPath = join(
    mkdtempSync(join(tmpdir(), 'handover-')),
    'incoming.json',
  );
  writeFileSync(incomingPath, JSON.stringify(dropped));

  // get-template --output json wraps non-JSON templates in a JSON string.
  const blocked = runCli(
    [incomingPath],
    JSON.stringify(JSON.stringify(beforeRetain)),
  );
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /ReceiptRuleSet .* not retained/);
  assert.match(blocked.stderr, /Deploy a release that retains/);

  const allowed = runCli([incomingPath], JSON.stringify(retained));
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stderr, '');
});

test('the CLI fails clearly without a readable synthesized template', () => {
  const usage = runCli([], '{}');
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /^Usage:/);

  const missing = runCli(
    [join(tmpdir(), 'handover-missing.template.json')],
    '{}',
  );
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Cannot read the synthesized template/);
});
