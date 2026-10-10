// CloudFormation deletes a resource that disappears from the template using
// the DeletionPolicy of the template that is already deployed, not the one
// being deployed. Dropping a stateful resource is therefore only safe after a
// release that retains it has reached the stack. The same applies to a custom
// resource with a delete call: removing it runs the deployed delete call.
const STATEFUL_TYPES = new Set([
  'AWS::DynamoDB::Table',
  'AWS::KMS::Key',
  'AWS::S3::Bucket',
  'AWS::SES::ReceiptRule',
  'AWS::SES::ReceiptRuleSet',
  'AWS::SSM::Parameter',
]);
const RETAINING_POLICIES = new Set(['Retain', 'RetainExceptOnCreate']);

/**
 * Lists the resources that `nextTemplate` removes but `liveTemplate` would
 * delete or run a delete call for instead of retaining. An empty list means
 * the deploy is safe.
 */
export function findUnsafeRemovals(liveTemplate, nextTemplate) {
  const live = liveTemplate?.Resources ?? {};
  const next = nextTemplate?.Resources ?? {};
  const problems = [];
  for (const [logicalId, resource] of Object.entries(live)) {
    if (logicalId in next) continue;
    if (
      STATEFUL_TYPES.has(resource.Type) &&
      !RETAINING_POLICIES.has(resource.DeletionPolicy)
    ) {
      problems.push(
        `${logicalId} (${resource.Type}) would be deleted; its deployed DeletionPolicy is ${resource.DeletionPolicy ?? 'Delete'}`,
      );
    }
    if (
      String(resource.Type).startsWith('Custom::') &&
      resource.Properties?.Delete !== undefined
    ) {
      problems.push(
        `${logicalId} (${resource.Type}) would run its deployed delete call`,
      );
    }
  }
  return problems;
}
