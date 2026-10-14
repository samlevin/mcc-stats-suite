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

for (const file of fixtureFiles) {
  const filePath = path.join(fixturesDir, file);
  const raw = fs.readFileSync(filePath, 'utf8');
  const fixture = JSON.parse(raw) as ScoreboardFixture;

  test(`scoreboard fixture: ${fixture.name}`, () => {
    const rows = processScoreboardImage(fixture.blocks, fixture.rowColors);
    assert.deepEqual(
      rows,
      fixture.expectedRows,
      `${file} should match expected rows`,
    );
  });
}
