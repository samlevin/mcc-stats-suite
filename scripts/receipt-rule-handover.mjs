import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// CloudFormation deletes a resource that the next template no longer declares, or
// declares with another type, unless the deployed template retains it. It replaces
// a resource whose immutable properties change and deletes the old one unless the
// deployed template retains it on replacement. It also runs the delete handler of
// a custom resource it removes. For the SES receipt rule set, the shared rule, and
// the activation, that turns off inbound email for the whole account (issue #45).
// Compare the deployed template with the one about to deploy and block only a
// deploy that would delete, replace, or deactivate them.
const replacementKeys = {
  'AWS::SES::ReceiptRuleSet': (properties) => [properties?.RuleSetName],
  'AWS::SES::ReceiptRule': (properties) => [
    properties?.RuleSetName,
    properties?.Rule?.Name,
  ],
};

export function handoverBlockers(deployed, incoming) {
  const blockers = [];
  const next = incoming?.Resources ?? {};
  for (const [id, resource] of Object.entries(deployed?.Resources ?? {})) {
    const keys = replacementKeys[resource.Type];
    const replacement = next[id];
    if (replacement?.Type === resource.Type) {
      if (
        keys &&
        resource.UpdateReplacePolicy !== 'Retain' &&
        JSON.stringify(keys(resource.Properties)) !==
          JSON.stringify(keys(replacement.Properties))
      ) {
        blockers.push(
          `${id} (${resource.Type}) would be replaced, which deletes the live resource`,
        );
      }
      continue;
    }
    if (keys && resource.DeletionPolicy !== 'Retain') {
      blockers.push(
        `${id} (${resource.Type}) would be deleted because it is not retained`,
      );
    }
    if (
      resource.Type === 'Custom::AWS' &&
      JSON.stringify(resource.Properties?.Delete ?? '').includes(
        'setActiveReceiptRuleSet',
      )
    ) {
      blockers.push(
        `${id} would deactivate the receipt rule set when it is removed`,
      );
    }
  }
  return blockers;
}

function parseTemplate(text, label) {
  try {
    const body = JSON.parse(text);
    // get-template returns JSON templates as objects and other templates as strings.
    return typeof body === 'string' ? JSON.parse(body) : body;
  } catch (error) {
    process.stderr.write(
      `Cannot parse the ${label} template: ${error.message}\n`,
    );
    process.exit(2);
  }
}

function readTemplate(path, label) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    process.stderr.write(
      `Cannot read the ${label} template ${path}: ${error.message}\n`,
    );
    process.exit(2);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const incomingPath = process.argv[2];
  if (!incomingPath) {
    process.stderr.write(
      'Usage: node receipt-rule-handover.mjs <synthesized-template.json> < deployed-template.json\n',
    );
    process.exit(2);
  }
  const blockers = handoverBlockers(
    parseTemplate(readFileSync(0, 'utf8'), 'deployed'),
    parseTemplate(readTemplate(incomingPath, 'synthesized'), 'synthesized'),
  );
  if (blockers.length > 0) {
    for (const blocker of blockers) process.stderr.write(`${blocker}\n`);
    process.stderr.write(
      'Deploy a release that retains these resources before one that removes them.\n',
    );
    process.exit(1);
  }
}
