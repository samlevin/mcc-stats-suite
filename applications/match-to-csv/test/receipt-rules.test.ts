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

const stable = synthesize({ environment: 'dev' });

t.test('stable stacks retain the receipt rule set and rule', (t) => {
  stable.hasResource('AWS::SES::ReceiptRuleSet', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
  const [rule] = Object.values(stable.findResources('AWS::SES::ReceiptRule'));
  t.equal(rule.DeletionPolicy, 'Retain');
  // A replaced rule must be removed, or it would duplicate every inbound email.
  t.equal(rule.UpdateReplacePolicy, undefined);
  t.end();
});

t.test('stable activation never deactivates the rule set on delete', (t) => {
  const activation = Object.values(stable.findResources('Custom::AWS'));

  t.equal(activation.length, 1);
  t.equal(activation[0].Properties.Delete, undefined);
  t.ok(activation[0].Properties.Create);
  // Removing Delete must update the resource in place. A new physical ID would
  // make CloudFormation delete the old one, and a different rule set name would
  // switch the account's active rule set.
  const update = JSON.parse(activation[0].Properties.Update as string) as {
    action: string;
    parameters: { RuleSetName: string };
    physicalResourceId: { id: string };
  };
  t.equal(update.action, 'setActiveReceiptRuleSet');
  t.equal(update.parameters.RuleSetName, 'mcc-match-to-csv-dev');
  t.equal(update.physicalResourceId.id, 'mcc-match-to-csv-dev');
  t.end();
});

t.test('ephemeral stacks keep one unretained rule and no rule set', (t) => {
  const template = synthesize({ environment: 'dev', ephemeral: 'test' });
  const rules = Object.values(template.findResources('AWS::SES::ReceiptRule'));

  template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
  template.resourceCountIs('Custom::AWS', 0);
  t.equal(rules.length, 1);
  t.equal(rules[0].DeletionPolicy, undefined);
  t.equal(rules[0].UpdateReplacePolicy, undefined);
  t.end();
});
