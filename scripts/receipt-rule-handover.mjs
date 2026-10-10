import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// CloudFormation deletes a resource that the next template no longer declares, or
// declares with another type, unless the deployed template retains it. It also runs
// the delete handler of a custom resource it removes. For the SES receipt rule set,
// the shared rule, and the activation, that turns off inbound email for the whole
// account (issue #45). Compare the deployed template with the one about to deploy
// and block only a deploy that would delete or deactivate them.
const receiptTypes = new Set([
  'AWS::SES::ReceiptRuleSet',
  'AWS::SES::ReceiptRule',
]);

export function handoverBlockers(deployed, incoming) {
  const blockers = [];
  const next = incoming?.Resources ?? {};
  for (const [id, resource] of Object.entries(deployed?.Resources ?? {})) {
    if (next[id]?.Type === resource.Type) continue;
    if (
      receiptTypes.has(resource.Type) &&
      resource.DeletionPolicy !== 'Retain'
    ) {
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

function parseTemplate(text) {
  const body = JSON.parse(text);
  // get-template returns JSON templates as objects and other templates as strings.
  return typeof body === 'string' ? JSON.parse(body) : body;
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
  let incoming;
  try {
    incoming = readFileSync(incomingPath, 'utf8');
  } catch (error) {
    process.stderr.write(
      `Cannot read the synthesized template ${incomingPath}: ${error.message}\n`,
    );
    process.exit(2);
  }
  const blockers = handoverBlockers(
    parseTemplate(readFileSync(0, 'utf8')),
    parseTemplate(incoming),
  );
  if (blockers.length > 0) {
    for (const blocker of blockers) process.stderr.write(`${blocker}\n`);
    process.stderr.write(
      'Deploy a release that retains these resources before one that removes them.\n',
    );
    process.exit(1);
  }
}
