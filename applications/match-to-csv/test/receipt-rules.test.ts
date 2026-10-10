import t from 'tap';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { resolveDeployment } from '@samlevin/cdk-config';
import { MatchToCsvStack } from '../cdk/lib/match-to-csv-stack';

function synthesize(context: Record<string, string>): Template {
  const app = new App({
    context: { 'aws:cdk:bundling-stacks': [], ...context },
  });
  const deployment = resolveDeployment(app.node, 'match-to-csv', {});
  const stack = new MatchToCsvStack(app, deployment.stackName, {
    deployment,
    env: { account: '000000000000', region: 'us-east-1' },
  });
  return Template.fromStack(stack);
}

t.test('stable stacks retain the receipt rule set and rule', (t) => {
  const template = synthesize({ environment: 'dev' });

  template.hasResource('AWS::SES::ReceiptRuleSet', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
  template.hasResource('AWS::SES::ReceiptRule', {
    DeletionPolicy: 'Retain',
    UpdateReplacePolicy: 'Retain',
  });
  t.end();
});

t.test('stable activation never deactivates the rule set on delete', (t) => {
  const template = synthesize({ environment: 'dev' });
  const activation = Object.values(template.findResources('Custom::AWS'));

  t.equal(activation.length, 1);
  t.equal(activation[0].Properties.Delete, undefined);
  t.ok(activation[0].Properties.Create);
  t.end();
});
