import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  processScoreboardImage,
  type TextractBlockLite,
  type RowColor,
  type CsvRow,
} from '../src/lib/scoreboard-logic';

interface ScoreboardFixture {
  name: string;
  blocks: TextractBlockLite[];
  rowColors: RowColor[];
  expectedRows: CsvRow[];
  /**
   * A tracked mismatch between the parser and the screenshot: the listed
   * fields are compared in a todo test, every other field must match.
   */
  knownIssue?: { issue: string; fields: (keyof CsvRow)[] };
}

const fixturesDir = path.join(__dirname, 'fixtures');
const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.fixture.json'))
  .sort();

test('scoreboard fixtures: directory has at least one fixture', () => {
  assert.ok(
    fixtureFiles.length > 0,
    'expected one or more *.fixture.json files',
  );
});

function without(rows: CsvRow[], fields: (keyof CsvRow)[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([field]) => !fields.includes(field as keyof CsvRow),
      ),
    ),
  );
}

for (const file of fixtureFiles) {
  const filePath = path.join(fixturesDir, file);
  const raw = fs.readFileSync(filePath, 'utf8');
  const fixture = JSON.parse(raw) as ScoreboardFixture;
  const run = () => processScoreboardImage(fixture.blocks, fixture.rowColors);
  const known = fixture.knownIssue;

  if (!known) {
    test(`scoreboard fixture: ${fixture.name}`, () => {
      assert.deepEqual(
        run(),
        fixture.expectedRows,
        `${file} should match expected rows`,
      );
    });
    continue;
  }

  test(`scoreboard fixture: ${fixture.name}, except ${known.fields.join(', ')}`, () => {
    assert.ok(known.issue && known.fields.length > 0, `${file} knownIssue`);
    assert.deepEqual(
      without(run(), known.fields),
      without(fixture.expectedRows, known.fields),
      `${file} should match expected rows outside ${known.fields.join(', ')}`,
    );
  });
  test(
    `scoreboard fixture: ${fixture.name}`,
    { todo: `known mismatch, ${known.issue}` },
    () => {
      assert.deepEqual(run(), fixture.expectedRows);
    },
  );
}
