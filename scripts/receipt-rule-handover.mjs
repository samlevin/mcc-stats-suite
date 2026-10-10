import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Before a release that stops declaring the receipt rule set, the deployed stack must
// already retain it and must not deactivate it on delete. Otherwise CloudFormation
// deletes the live resources and turns off inbound email for the account (issue #45).
export function handoverBlockers(template) {
  const blockers = [];
  for (const [id, resource] of Object.entries(template?.Resources ?? {})) {
    if (
      (resource.Type === 'AWS::SES::ReceiptRuleSet' ||
        resource.Type === 'AWS::SES::ReceiptRule') &&
      resource.DeletionPolicy !== 'Retain'
    ) {
      blockers.push(`${id} (${resource.Type}) is not retained on deletion`);
    }
    if (
      resource.Type === 'Custom::AWS' &&
      JSON.stringify(resource.Properties?.Delete ?? '').includes(
        'setActiveReceiptRuleSet',
      )
    ) {
      blockers.push(`${id} deactivates the receipt rule set on delete`);
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
  const blockers = handoverBlockers(parseTemplate(readFileSync(0, 'utf8')));
  if (blockers.length > 0) {
    for (const blocker of blockers) process.stderr.write(`${blocker}\n`);
    process.stderr.write(
      'Deploy the release that retains the receipt rules (#49) to this environment first.\n',
    );
    process.exit(1);
  }
}
