import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Match } from 'aws-cdk-lib/assertions';
import { synthesize } from './support/app';

type TemplateJson = {
  Parameters?: Record<string, { Type?: string; Default?: string }>;
  Outputs?: Record<string, unknown>;
};

test('stable stacks leave inbound email to the foundation', () => {
  for (const environment of ['dev', 'prod']) {
    const template = synthesize({ environment });

    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
    template.resourceCountIs('AWS::SES::ReceiptRule', 0);
    template.resourceCountIs('Custom::AWS', 0);
    const json = template.toJSON() as TemplateJson;
    const defaults = Object.values(json.Parameters ?? {}).map(
      (parameter) => parameter.Default,
    );
    assert.ok(
      !defaults.includes(`/mcc/${environment}/match-to-csv/email-domain`),
    );
    assert.ok(
      !defaults.includes(
        `/mcc/${environment}/match-to-csv/receipt-rule-set-name`,
      ),
    );
    // The deploy workflow no longer passes --parameters EmailDomain=, so a
    // leftover parameter without a default would fail every stable deploy.
    assert.equal(json.Parameters?.EmailDomain, undefined);
    assert.equal(json.Outputs?.ReceiptRuleSetName, undefined);
  }
});

test('ephemeral stacks add one rule to the foundation rule set', () => {
  const template = synthesize({ environment: 'dev', ephemeral: 'sam' });
  const json = template.toJSON() as TemplateJson;

  template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
  template.resourceCountIs('Custom::AWS', 0);
  template.resourceCountIs('AWS::SES::ReceiptRule', 1);
  // Destroying an ephemeral stack must remove its rule.
  template.hasResource('AWS::SES::ReceiptRule', {
    DeletionPolicy: Match.absent(),
    UpdateReplacePolicy: Match.absent(),
  });

  const [rule] = Object.values(template.findResources('AWS::SES::ReceiptRule'));
  assert.equal(rule.Properties.Rule.Name, 'match-to-csv-e-sam');
  // The recipient domain comes from the foundation's SSM parameter, never from
  // a local value, so it always matches the shared rule.
  const [recipient] = rule.Properties.Rule.Recipients as [
    { 'Fn::Join': [string, [string, { Ref: string }]] },
  ];
  const [localPart, domain] = recipient['Fn::Join'][1];
  assert.equal(localPart, 'submit+sam@');
  assert.equal(
    json.Parameters?.[domain.Ref]?.Type,
    'AWS::SSM::Parameter::Value<String>',
  );
  assert.equal(
    json.Parameters?.[domain.Ref]?.Default,
    '/mcc/dev/match-to-csv/email-domain',
  );
  assert.equal(json.Parameters?.EmailDomain, undefined);
  assert.equal(
    rule.Properties.Rule.Actions[0].S3Action.ObjectKeyPrefix,
    'incoming/sam/',
  );
  assert.deepEqual(rule.Properties.Rule.Actions[1], {
    StopAction: { Scope: 'RuleSet' },
  });

  const ruleSetRef = (rule.Properties.RuleSetName as { Ref: string }).Ref;
  assert.equal(
    json.Parameters?.[ruleSetRef]?.Default,
    '/mcc/dev/match-to-csv/receipt-rule-set-name',
  );
});
