// CloudFormation deletes a resource that the next template no longer declares, or
// declares with another type, unless the deployed template retains it. It replaces
// a resource whose immutable properties change and deletes the old one unless the
// incoming template retains it on replacement. It also runs the delete handler of
// a custom resource it removes or replaces. For the SES receipt rule set, the
// shared rule, and the activation, that turns off inbound email for the whole
// account (issue #45). Compare the deployed template with the one about to deploy
// and block only a deploy that would delete, replace, or deactivate them.
//
// The guard only matters while a stack still declares these resources, so the
// replacement keys cover the two SES types by hand instead of asking
// CloudFormation for a change set on every deploy.
const replacementKeys = {
  'AWS::SES::ReceiptRuleSet': (properties) => [properties?.RuleSetName],
  'AWS::SES::ReceiptRule': (properties) => [
    properties?.RuleSetName,
    properties?.Rule?.Name,
  ],
};

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

const deactivatesOnDelete = (resource) =>
  resource.Type === 'Custom::AWS' &&
  JSON.stringify(resource.Properties?.Delete ?? '').includes(
    'setActiveReceiptRuleSet',
  );

export function handoverBlockers(deployed, incoming) {
  const blockers = [];
  const next = incoming?.Resources ?? {};
  for (const [id, resource] of Object.entries(deployed?.Resources ?? {})) {
    const keys = replacementKeys[resource.Type];
    const replacement = next[id];
    if (replacement?.Type === resource.Type) {
      if (
        keys &&
        replacement.UpdateReplacePolicy !== 'Retain' &&
        !same(keys(resource.Properties), keys(replacement.Properties))
      ) {
        blockers.push(
          `${id} (${resource.Type}) would be replaced, which deletes the live resource`,
        );
      }
      // The physical ID lives in the Create call. Changing it replaces the
      // custom resource, and CloudFormation then runs the old delete handler.
      if (
        deactivatesOnDelete(resource) &&
        !same(resource.Properties?.Create, replacement.Properties?.Create)
      ) {
        blockers.push(
          `${id} would be replaced and its delete handler deactivates the receipt rule set`,
        );
      }
      continue;
    }
    if (keys && resource.DeletionPolicy !== 'Retain') {
      blockers.push(
        `${id} (${resource.Type}) would be deleted because it is not retained`,
      );
    }
    if (deactivatesOnDelete(resource)) {
      blockers.push(
        `${id} would deactivate the receipt rule set when it is removed`,
      );
    }
  }
  return blockers;
}
