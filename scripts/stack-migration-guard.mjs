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
 * Returns the stack name and template file of the single stack in a CDK cloud
 * assembly manifest, so the guard compares the stack the deploy targets
 * without rebuilding its name. Throws unless there is exactly one stack.
 */
export function stackArtifact(manifest) {
  const stacks = Object.entries(manifest?.artifacts ?? {}).filter(
    ([, artifact]) => artifact.type === 'aws:cloudformation:stack',
  );
  if (stacks.length !== 1) {
    throw new Error(
      `expected one stack in the cloud assembly, found ${stacks.length}`,
    );
  }
  const [[id, artifact]] = stacks;
  return {
    stackName: artifact.properties?.stackName ?? id,
    templateFile: artifact.properties?.templateFile ?? `${id}.template.json`,
  };
}

/**
 * Stable deploys reuse the assembly the guard synthesizes, so options that
 * would change synthesis cannot apply. Only GitHub Actions deploys stable
 * stacks, and it passes just `--require-approval`. Returns an error message,
 * or undefined when the options are allowed.
 */
export function stableDeployOptionsError(passthrough) {
  for (let index = 0; index < passthrough.length; index += 1) {
    const option = passthrough[index];
    if (/^--require-approval=\S+$/.test(option)) continue;
    if (
      option === '--require-approval' &&
      passthrough[index + 1] &&
      !passthrough[index + 1].startsWith('-')
    ) {
      index += 1;
      continue;
    }
    return `Stable deploys accept only --require-approval; remove ${option}`;
  }
  return undefined;
}

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

// Properties of each stateful type whose change makes CloudFormation replace
// the resource, deleting the old one unless UpdateReplacePolicy is Retain.
// CloudFormation rejects a Type change under the same logical ID on its own.
const REPLACING_PROPERTIES = {
  'AWS::DynamoDB::Table': ['TableName', 'KeySchema'],
  'AWS::KMS::Key': ['KeySpec', 'KeyUsage'],
  'AWS::S3::Bucket': ['BucketName'],
  'AWS::SES::ReceiptRule': ['RuleSetName'],
  'AWS::SES::ReceiptRuleSet': ['RuleSetName'],
  'AWS::SSM::Parameter': ['Name'],
};

function isCustomResource(type) {
  return (
    String(type).startsWith('Custom::') ||
    type === 'AWS::CloudFormation::CustomResource'
  );
}

// Removing a custom resource runs its provider's delete handler unless the
// deployed DeletionPolicy retains it. AwsCustomResource (Custom::AWS) is the
// exception: with no Delete call, its handler does nothing.
function runsDeleteHandler(resource) {
  if (RETAINING_POLICIES.has(resource.DeletionPolicy)) return false;
  if (resource.Type === 'Custom::AWS') {
    return resource.Properties?.Delete !== undefined;
  }
  return true;
}

function replacedProperties(liveResource, nextResource) {
  return (REPLACING_PROPERTIES[liveResource.Type] ?? []).filter(
    (property) =>
      JSON.stringify(liveResource.Properties?.[property]) !==
      JSON.stringify(nextResource.Properties?.[property]),
  );
}

/**
 * Lists the resources that `nextTemplate` removes or replaces but
 * `liveTemplate` would delete, or run a delete handler for, instead of
 * retaining. An empty list means the deploy is safe.
 */
export function findUnsafeRemovals(liveTemplate, nextTemplate) {
  const live = liveTemplate?.Resources ?? {};
  const next = nextTemplate?.Resources ?? {};
  const problems = [];
  for (const [logicalId, resource] of Object.entries(live)) {
    const stateful = STATEFUL_TYPES.has(resource.Type);
    if (logicalId in next) {
      if (!stateful || resource.UpdateReplacePolicy === 'Retain') continue;
      const changed = replacedProperties(resource, next[logicalId]);
      if (changed.length > 0) {
        problems.push(
          `${logicalId} (${resource.Type}) would be replaced because ${changed.join(', ')} changed; its deployed UpdateReplacePolicy is ${resource.UpdateReplacePolicy ?? 'Delete'}`,
        );
      }
      continue;
    }
    if (stateful && !RETAINING_POLICIES.has(resource.DeletionPolicy)) {
      problems.push(
        `${logicalId} (${resource.Type}) would be deleted; its deployed DeletionPolicy is ${resource.DeletionPolicy ?? 'Delete'}`,
      );
    }
    if (isCustomResource(resource.Type) && runsDeleteHandler(resource)) {
      problems.push(
        `${logicalId} (${resource.Type}) would run its deployed delete handler`,
      );
    }
  }
  return problems;
}
