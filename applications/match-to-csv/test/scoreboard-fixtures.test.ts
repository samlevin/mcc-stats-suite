import fs from 'fs';
import path from 'path';
import t from 'tap';
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

t.test('scoreboard fixtures: directory has at least one fixture', (t) => {
  t.ok(fixtureFiles.length > 0, 'expected one or more *.fixture.json files');
  t.end();
});

for (const file of fixtureFiles) {
  const filePath = path.join(fixturesDir, file);
  const raw = fs.readFileSync(filePath, 'utf8');
  const fixture = JSON.parse(raw) as ScoreboardFixture;

  t.test(`scoreboard fixture: ${fixture.name}`, (t) => {
    const rows = processScoreboardImage(fixture.blocks, fixture.rowColors);
    t.same(rows, fixture.expectedRows, `${file} should match expected rows`);
    t.end();
  });
}
