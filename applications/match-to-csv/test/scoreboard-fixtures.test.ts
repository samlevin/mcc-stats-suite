import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  processScoreboardImage,
  type TextractBlockLite,
  type RowColor,
  type CsvRow,
  type RowReviewFlag,
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
  /**
   * OCR misreads the parser keeps as read and flags for review. The expected
   * row whose `field` the screenshot shows as `expected` must come out as
   * `read`, and that expected row must carry a review flag on the field.
   */
  misreads?: {
    field: RowReviewFlag['field'];
    expected: string;
    read: string;
  }[];
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

/**
 * The expected rows with each misread value replaced by the text Textract
 * read, after checking that the fixture flags every misread row.
 */
function asRead(fixture: ScoreboardFixture, file: string): CsvRow[] {
  const rows = fixture.expectedRows.map((row) => ({ ...row }));
  for (const misread of fixture.misreads ?? []) {
    const matches = rows.filter(
      (row) => row[misread.field] === misread.expected,
    );
    assert.equal(
      matches.length,
      1,
      `${file}: misread "${misread.expected}" must match one expected row`,
    );
    assert.ok(
      matches[0].reviewFlags?.some((flag) => flag.field === misread.field),
      `${file}: misread "${misread.expected}" must be flagged for review`,
    );
    matches[0][misread.field] = misread.read;
  }
  return rows;
}

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
        asRead(fixture, file),
        `${file} should match expected rows`,
      );
    });
    continue;
  }

  test(`scoreboard fixture: ${fixture.name}, except ${known.fields.join(', ')}`, () => {
    assert.ok(known.issue && known.fields.length > 0, `${file} knownIssue`);
    assert.deepEqual(
      without(run(), known.fields),
      without(asRead(fixture, file), known.fields),
      `${file} should match expected rows outside ${known.fields.join(', ')}`,
    );
  });
  test(
    `scoreboard fixture: ${fixture.name}`,
    { todo: `known mismatch, ${known.issue}` },
    () => {
      assert.deepEqual(run(), asRead(fixture, file));
    },
  );
}
