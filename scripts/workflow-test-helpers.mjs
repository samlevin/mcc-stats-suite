import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export const workflow = (name) =>
  parse(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      'utf8',
    ),
  );

// Execute a github-script body with mocked globals (require, context, github, core).
export const runScript = (script, globals) =>
  new (Object.getPrototypeOf(async function () {}).constructor)(
    ...Object.keys(globals),
    script,
  )(...Object.values(globals));

export const evaluate = (expression, values) =>
  Function(
    ...Object.keys(values),
    `return (${expression});`,
  )(...Object.values(values));
