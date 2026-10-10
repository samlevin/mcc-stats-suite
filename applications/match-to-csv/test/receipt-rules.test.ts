import t from 'tap';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { BUNDLING_STACKS } from 'aws-cdk-lib/cx-api';
import { createMatchToCsvApp } from '../cdk/lib/app';

function synthesize(context: Record<string, string>): Template {
  return Template.fromStack(
    createMatchToCsvApp({ context: { [BUNDLING_STACKS]: [], ...context } }, {}),
  );
}

const stable = synthesize({ environment: 'dev' });

t.test('stable stacks retain the receipt rule set and rule', (t) => {
  // RetainExceptOnCreate: a failed first deploy rolls back cleanly instead of
  // stranding the names and failing every retry with AlreadyExists.
  stable.hasResource('AWS::SES::ReceiptRuleSet', {
    DeletionPolicy: 'RetainExceptOnCreate',
    UpdateReplacePolicy: 'Retain',
  });
  stable.resourceCountIs('AWS::SES::ReceiptRule', 1);
  // A replaced rule must be removed, or it would duplicate every inbound email.
  stable.hasResource('AWS::SES::ReceiptRule', {
    DeletionPolicy: 'RetainExceptOnCreate',
    UpdateReplacePolicy: Match.absent(),
  });
  t.end();
});

t.test('stable activation never deactivates the rule set on delete', (t) => {
  stable.resourceCountIs('Custom::AWS', 1);
  // Removing Delete must update the resource in place. A new physical ID would
  // make CloudFormation delete the old one, and a different rule set name would
  // switch the account's active rule set.
  stable.hasResourceProperties('Custom::AWS', {
    Create: Match.anyValue(),
    Delete: Match.absent(),
    Update: Match.serializedJson(
      Match.objectLike({
        action: 'setActiveReceiptRuleSet',
        parameters: { RuleSetName: 'mcc-match-to-csv-dev' },
        physicalResourceId: { id: 'mcc-match-to-csv-dev' },
      }),
    ),
  });
  t.end();
});

t.test('ephemeral stacks keep one unretained rule and no rule set', (t) => {
  const template = synthesize({ environment: 'dev', ephemeral: 'test' });

  template.resourceCountIs('AWS::SES::ReceiptRuleSet', 0);
  template.resourceCountIs('Custom::AWS', 0);
  template.resourceCountIs('AWS::SES::ReceiptRule', 1);
  template.hasResource('AWS::SES::ReceiptRule', {
    DeletionPolicy: Match.absent(),
    UpdateReplacePolicy: Match.absent(),
  });
  t.end();
});
