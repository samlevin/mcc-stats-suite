import { readFileSync } from 'node:fs';
import { handoverBlockers } from './receipt-rule-handover.mjs';

// Usage: node receipt-rule-handover-cli.mjs <synthesized-template.json> < deployed-template.json
// Exit 0 when the deploy is safe, 1 when it would delete or deactivate a live
// receipt resource, and 2 when a template cannot be read. This file always runs
// its check, so a path mismatch can never turn the guard into a no-op.

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

const incomingPath = process.argv[2];
if (!incomingPath) {
  process.stderr.write(
    'Usage: node receipt-rule-handover-cli.mjs <synthesized-template.json> < deployed-template.json\n',
  );
  process.exit(2);
}
const blockers = handoverBlockers(
  parseTemplate(readTemplate(0, 'deployed'), 'deployed'),
  parseTemplate(readTemplate(incomingPath, 'synthesized'), 'synthesized'),
);
if (blockers.length > 0) {
  for (const blocker of blockers) process.stderr.write(`${blocker}\n`);
  process.stderr.write(
    'Deploy a release that retains these resources before one that removes them.\n',
  );
  process.exit(1);
}
