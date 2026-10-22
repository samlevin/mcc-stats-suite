import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Match, type Template } from 'aws-cdk-lib/assertions';
import { synthesize } from './support/app';

type TemplateJson = {
  Parameters?: Record<string, { Type?: string; Default?: string }>;
  Outputs?: Record<string, unknown>;
};

function processEmailVariables(
  template: Template,
  name: string,
): Record<string, unknown> {
  const [fn] = Object.values(
    template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: `match-to-csv-${name}-ProcessEmail` },
    }),
  );
  return fn.Properties.Environment.Variables as Record<string, unknown>;
}

/** Parameter names that any ssm:GetParameter grant in the stack covers. */
function parameterReads(template: Template): string[] {
  const names: string[] = [];
  for (const policy of Object.values(
    template.findResources('AWS::IAM::Policy'),
  )) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      if (statement.Action !== 'ssm:GetParameter') continue;
      for (const resource of [statement.Resource].flat()) {
        const parts = resource['Fn::Join'][1] as unknown[];
        const last = parts[parts.length - 1] as string;
        names.push(
          last.slice(last.indexOf(':parameter') + ':parameter'.length),
        );
      }
    }
  }
  return names.sort();
}

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
    // A stable stack resolves the domain only for its reply address and
    // SES send grants, and never the alias.
    assert.ok(
      defaults.includes(`/mcc/${environment}/match-to-csv/email-domain`),
    );
    assert.ok(
      !defaults.includes(`/mcc/${environment}/match-to-csv/email-alias`),
    );
    // The shared rule fixes a stable stack's recipient, so it checks none.
    const variables = processEmailVariables(template, environment);
    assert.equal(variables.EMAIL_ALIAS_PARAMETER, undefined);
    assert.equal(variables.EMAIL_DOMAIN_PARAMETER, undefined);
    assert.equal(variables.RECIPIENT_SUBADDRESS, undefined);
    assert.deepEqual(parameterReads(template), [
      `/mcc/${environment}/match-to-csv/sender-allowlist`,
    ]);
    assert.ok(
      !defaults.includes(
        `/mcc/${environment}/match-to-csv/receipt-rule-set-name`,
      ),
    );
    // The deploy workflow passes no --parameters EmailDomain=, so an
    // EmailDomain parameter without a default would fail every stable deploy.
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
  // The alias and domain come from the foundation's SSM parameters, never
  // from a local value, so the rule is <alias>+<name>@<domain> for the alias
  // and domain of the shared rule.
  const recipients = rule.Properties.Rule.Recipients as Array<{
    'Fn::Join': [string, [{ Ref: string }, string, { Ref: string }]];
  }>;
  assert.equal(recipients.length, 1);
  const [separator, [alias, subaddress, domain]] = recipients[0]['Fn::Join'];
  assert.equal(separator, '');
  assert.equal(subaddress, '+sam@');
  for (const [reference, parameter] of [
    [alias, '/mcc/dev/match-to-csv/email-alias'],
    [domain, '/mcc/dev/match-to-csv/email-domain'],
  ] as const) {
    assert.equal(
      json.Parameters?.[reference.Ref]?.Type,
      'AWS::SSM::Parameter::Value<String>',
    );
    assert.equal(json.Parameters?.[reference.Ref]?.Default, parameter);
  }
  assert.equal(json.Parameters?.EmailDomain, undefined);
  assert.equal(
    rule.Properties.Rule.Actions[0].S3Action.ObjectKeyPrefix,
    'incoming/sam/',
  );
  assert.deepEqual(rule.Properties.Rule.Actions[1], {
    StopAction: { Scope: 'RuleSet' },
  });

  // process-email requires the current address among the SES recipients, so
  // a rule left on an old alias or domain accepts nothing.
  const variables = processEmailVariables(template, 'e-sam');
  assert.equal(
    variables.EMAIL_ALIAS_PARAMETER,
    '/mcc/dev/match-to-csv/email-alias',
  );
  assert.equal(
    variables.EMAIL_DOMAIN_PARAMETER,
    '/mcc/dev/match-to-csv/email-domain',
  );
  assert.equal(variables.RECIPIENT_SUBADDRESS, 'sam');
  assert.deepEqual(parameterReads(template), [
    '/mcc/dev/match-to-csv/email-alias',
    '/mcc/dev/match-to-csv/email-domain',
    '/mcc/dev/match-to-csv/sender-allowlist',
  ]);

  const ruleSetRef = (rule.Properties.RuleSetName as { Ref: string }).Ref;
  assert.equal(
    json.Parameters?.[ruleSetRef]?.Default,
    '/mcc/dev/match-to-csv/receipt-rule-set-name',
  );
});
