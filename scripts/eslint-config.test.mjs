import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function lintMarkdown(text, filePath = 'docs/example.md') {
  const [result] = await eslint.lintText(text, { filePath });
  return result.messages.map(({ ruleId, line }) => ({ ruleId, line }));
}

test('Markdown with a broken link fragment fails lint', async () => {
  assert.deepEqual(
    await lintMarkdown('# Title\n\nSee [the steps](#missing-steps).\n'),
    [{ ruleId: 'markdown/no-missing-link-fragments', line: 3 }],
  );
});

test('a GitHub table row with an extra cell fails lint', async () => {
  assert.deepEqual(
    await lintMarkdown('# Title\n\n| A | B |\n| --- | --- |\n| 1 | 2 | 3 |\n'),
    [{ ruleId: 'markdown/table-column-count', line: 5 }],
  );
});

test('valid Markdown with YAML front matter passes lint', async () => {
  // Parsed as Markdown, the bracketed front matter value would be a missing
  // label reference.
  assert.deepEqual(
    await lintMarkdown(
      "---\nname: example\nargument-hint: '[issue or PR URL]'\n---\n\n# Title\n\nSee [the steps](#steps).\n\n## Steps\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
      '.claude/skills/example/SKILL.md',
    ),
    [],
  );
});

test('Markdown gets only Markdown rules, never JavaScript, TypeScript, or Prettier rules', async () => {
  const config = await eslint.calculateConfigForFile('AGENTS.md');
  const rules = Object.keys(config.rules);
  assert.ok(rules.includes('markdown/table-column-count'));
  assert.deepEqual(
    rules.filter((rule) => !rule.startsWith('markdown/')),
    [],
  );
});
