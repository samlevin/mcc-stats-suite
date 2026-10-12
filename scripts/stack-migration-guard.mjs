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

// Statuses whose deployed template is final. Any other status may still change
// the template under the guard, for example an update that is rolling back.
const SETTLED_STATUSES = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);
// A rolled-back first create or a review-only stack owns no resources, and
// cdk deploy replaces it, so its template protects nothing.
const EMPTY_STATUSES = new Set(['ROLLBACK_COMPLETE', 'REVIEW_IN_PROGRESS']);

/**
 * Decides what the guard does with a stack status: `compare` the deployed
 * template, `skip` a stack that owns nothing, or `refuse` until it settles.
 */
export function stackStatusAction(status) {
  if (SETTLED_STATUSES.has(status)) return 'compare';
  if (EMPTY_STATUSES.has(status)) return 'skip';
  return 'refuse';
}

/**
 * Returns the template from a `get-template` TemplateBody, which the CLI
 * prints as an object for JSON templates and a string otherwise. Throws for
 * anything the guard cannot read, so it never passes on missing data.
 */
export function parseTemplateBody(body) {
  if (body && typeof body === 'object') return body;
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch {
      throw new Error('the deployed template is not JSON');
    }
  }
  throw new Error('the deployed template is empty');
}

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
