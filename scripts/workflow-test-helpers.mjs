import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export const workflow = (name) =>
  parse(
    readFileSync(
      new URL(`../.github/workflows/${name}.yml`, import.meta.url),
      'utf8',
    ),
  );

export const evaluate = (expression, values) =>
  Function(
    ...Object.keys(values),
    `return (${expression});`,
  )(...Object.values(values));
