import t from 'tap';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { BUNDLING_STACKS } from 'aws-cdk-lib/cx-api';
import { resolveDeployment } from '@samlevin/cdk-config';
import { MatchToCsvStack } from '../cdk/lib/match-to-csv-stack';

function synthesize(context: Record<string, string>): Template {
  const app = new App({
    context: { [BUNDLING_STACKS]: [], ...context },
  });
  const deployment = resolveDeployment(app.node, 'match-to-csv', {});
  const stack = new MatchToCsvStack(app, deployment.stackName, {
    deployment,
    env: { account: '000000000000', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

t.test('stable stacks leave inbound email to the foundation', (t) => {
  for (const environment of ['dev', 'prod']) {
    const template = synthesize({ environment });

    template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
    template.resourceCountIs('AWS::SES::ReceiptRule', 0);
    template.resourceCountIs('Custom::AWS', 0);
    const json = template.toJSON() as {
      Parameters?: Record<string, { Default?: string }>;
      Outputs?: Record<string, unknown>;
    };
    const defaults = Object.values(json.Parameters ?? {}).map(
      (parameter) => parameter.Default,
    );
    t.notOk(defaults.includes(`/mcc/${environment}/match-to-csv/email-domain`));
    t.same(json.Outputs?.ReceiptRuleSetName, undefined);
  }
  t.end();
});

t.test('ephemeral stacks add one rule to the foundation rule set', (t) => {
  const template = synthesize({ environment: 'dev', ephemeral: 'sam' });
  const json = template.toJSON();

  template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
  template.resourceCountIs('Custom::AWS', 0);
  template.resourceCountIs('AWS::SES::ReceiptRule', 1);

  const [rule] = Object.values(template.findResources('AWS::SES::ReceiptRule'));
  t.equal(rule.DeletionPolicy, undefined);
  // The recipient domain comes from the foundation's SSM parameter, never from
  // a local value, so it always matches the shared rule.
  const [recipient] = rule.Properties.Rule.Recipients as [
    { 'Fn::Join': [string, [string, { Ref: string }]] },
  ];
  const [localPart, domain] = recipient['Fn::Join'][1];
  t.equal(localPart, 'submit+sam@');
  t.equal(
    json.Parameters[domain.Ref].Type,
    'AWS::SSM::Parameter::Value<String>',
  );
  t.equal(
    json.Parameters[domain.Ref].Default,
    '/mcc/dev/match-to-csv/email-domain',
  );
  t.equal(json.Parameters.EmailDomain, undefined);
  t.equal(
    rule.Properties.Rule.Actions[0].S3Action.ObjectKeyPrefix,
    'incoming/sam/',
  );
  t.same(rule.Properties.Rule.Actions[1], {
    StopAction: { Scope: 'RuleSet' },
  });

  const ruleSetRef = (rule.Properties.RuleSetName as { Ref: string }).Ref;
  t.equal(
    json.Parameters[ruleSetRef].Default,
    '/mcc/dev/match-to-csv/receipt-rule-set-name',
  );
  t.end();
});
