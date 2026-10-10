// Resources that a later release hands to OpenTofu. CloudFormation applies the
// DeletionPolicy from the template that is currently deployed, not the one
// being deployed, so a stack that has never received the retaining release
// must not deploy a template that drops them.
const GUARDED_TYPES = new Set([
  'AWS::SES::ReceiptRuleSet',
  'AWS::SES::ReceiptRule',
]);
const RETAINING_POLICIES = new Set(['Retain', 'RetainExceptOnCreate']);
const ACTIVATION_CALL = 'setActiveReceiptRuleSet';

/**
 * Lists the resources that `nextTemplate` removes but `liveTemplate` would
 * delete or deactivate instead of retaining. An empty list means the deploy
 * is safe.
 */
export function findUnsafeRemovals(liveTemplate, nextTemplate) {
  const live = liveTemplate?.Resources ?? {};
  const next = nextTemplate?.Resources ?? {};
  const problems = [];
  for (const [logicalId, resource] of Object.entries(live)) {
    if (logicalId in next) continue;
    if (
      GUARDED_TYPES.has(resource.Type) &&
      !RETAINING_POLICIES.has(resource.DeletionPolicy)
    ) {
      problems.push(
        `${logicalId} (${resource.Type}) would be deleted because the deployed template does not retain it`,
      );
    }
    if (
      resource.Type === 'Custom::AWS' &&
      JSON.stringify(resource.Properties?.Delete ?? '').includes(
        ACTIVATION_CALL,
      )
    ) {
      problems.push(
        `${logicalId} (Custom::AWS) would run its delete handler and deactivate the SES receipt rule set`,
      );
    }
  }
  return problems;
}
