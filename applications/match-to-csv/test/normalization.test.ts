import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Block } from '@aws-sdk/client-textract';
import { cellMeasurements, normalize } from '../src/lambdas/extract-text';

const source = {
  screenshotId: 'screen-1',
  submissionId: 'submission-1',
  bucket: 'evidence',
  key: 'source/original',
  attachmentName: 'scoreboard.png',
  contentType: 'image/png',
  sha256: 'hash',
  acquisitionType: 'SCREENSHOT' as const,
  widthPx: 1920,
  heightPx: 1080,
};

function word(id: string, text: string) {
  return { Id: id, BlockType: 'WORD' as const, Text: text };
}
function cell(id: string, row: number, column: number, wordId: string) {
  return {
    Id: id,
    BlockType: 'CELL' as const,
    RowIndex: row,
    ColumnIndex: column,
    Confidence: 99,
    Relationships: [{ Type: 'CHILD' as const, Ids: [wordId] }],
  };
}

test('normalization maps known scoreboard headers to semantic fields', () => {
  const blocks = [
    {
      Id: 'table',
      BlockType: 'TABLE' as const,
      Relationships: [
        {
          Type: 'CHILD' as const,
          Ids: ['h-player', 'h-score', 'player', 'score'],
        },
      ],
    },
    cell('h-player', 1, 1, 'w-player'),
    cell('h-score', 1, 2, 'w-score'),
    cell('player', 2, 1, 'w-name'),
    cell('score', 2, 2, 'w-value'),
    word('w-player', 'PLAYER'),
    word('w-score', 'SCORE'),
    word('w-name', 'Spartan'),
    word('w-value', '19'),
  ];
  const normalized = normalize(blocks, source, 'run-1');
  assert.equal(
    normalized.cells.find((item) => item.providerBlockId === 'player')
      ?.semanticLocation.field,
    'PLAYER',
  );
  const score = normalized.cells.find(
    (item) => item.providerBlockId === 'score',
  );
  assert.equal(score?.semanticLocation.field, 'SCORE');
  assert.equal(score?.parsed.expectedType, 'INTEGER');
  assert.equal(score?.tableObservationId, 'run-1:table:table');
  assert.equal(score?.tableLocation.tableIndex, 0);
  const scoreHeader = normalized.cells.find(
    (item) => item.providerBlockId === 'h-score',
  );
  assert.equal(scoreHeader?.semanticLocation.rowRole, 'HEADER');
  assert.equal(scoreHeader?.parsed.expectedType, 'STRING');
  assert.equal(scoreHeader?.validation.valid, true);
  assert.ok(
    !scoreHeader?.validation.flags.some(
      (flag) => flag.code === 'INVALID_INTEGER',
    ),
  );
});

test('normalization maps each table independently and flags invalid integers', () => {
  const blocks = [
    {
      Id: 'table-a',
      BlockType: 'TABLE' as const,
      Relationships: [{ Type: 'CHILD' as const, Ids: ['a-header', 'a-value'] }],
    },
    cell('a-header', 1, 1, 'a-header-word'),
    cell('a-value', 2, 1, 'a-value-word'),
    word('a-header-word', 'PLAYER'),
    word('a-value-word', 'Spartan'),
    {
      Id: 'table-b',
      BlockType: 'TABLE' as const,
      Relationships: [{ Type: 'CHILD' as const, Ids: ['b-header', 'b-value'] }],
    },
    cell('b-header', 1, 1, 'b-header-word'),
    cell('b-value', 2, 1, 'b-value-word'),
    word('b-header-word', 'SCORE'),
    word('b-value-word', 'I9'),
  ];
  const normalized = normalize(blocks, source, 'run-1');
  const player = normalized.cells.find(
    (item) => item.providerBlockId === 'a-value',
  );
  const score = normalized.cells.find(
    (item) => item.providerBlockId === 'b-value',
  );
  assert.equal(player?.semanticLocation.field, 'PLAYER');
  assert.equal(score?.semanticLocation.field, 'SCORE');
  assert.equal(score?.tableLocation.tableIndex, 1);
  assert.equal(score?.parsed.parseSucceeded, false);
  assert.equal(score?.validation.valid, false);
  assert.ok(
    score?.validation.flags.some((flag) => flag.code === 'INVALID_INTEGER'),
  );
});

function scoredWord(id: string, text: string, confidence?: number) {
  return { ...word(id, text), Confidence: confidence };
}
function multiWordCell(id: string, row: number, wordIds: string[]) {
  return {
    Id: id,
    BlockType: 'CELL' as const,
    RowIndex: row,
    ColumnIndex: 1,
    Confidence: 70,
    Relationships: [{ Type: 'CHILD' as const, Ids: wordIds }],
  };
}

test('LOW_TEXTRACT_CONFIDENCE reads the lowest WORD confidence and ignores the CELL block', () => {
  const blocks = [
    {
      Id: 'table',
      BlockType: 'TABLE' as const,
      Relationships: [
        {
          Type: 'CHILD' as const,
          Ids: ['header', 'clear', 'unclear', 'blank', 'unscored'],
        },
      ],
    },
    multiWordCell('header', 1, ['w-header']),
    multiWordCell('clear', 2, ['w-clear-1', 'w-clear-2']),
    multiWordCell('unclear', 3, ['w-unclear-1', 'w-unclear-2']),
    multiWordCell('blank', 4, []),
    multiWordCell('unscored', 5, ['w-unscored']),
    scoredWord('w-header', 'PLAYERS', 99),
    scoredWord('w-clear-1', '[CLAN1]', 96),
    scoredWord('w-clear-2', 'Spartan', 90),
    scoredWord('w-unclear-1', 'Spartan', 98),
    scoredWord('w-unclear-2', '117', 52.5),
    scoredWord('w-unscored', 'Noble'),
  ];
  const normalized = normalize(blocks, source, 'run-1');
  const byId = (id: string) =>
    normalized.cells.find((item) => item.providerBlockId === id)!;

  for (const cell of normalized.cells) {
    assert.equal(cell.confidence, 70, 'cells keep the CELL block confidence');
  }
  assert.deepEqual(byId('header').validation.flags, []);
  assert.deepEqual(
    byId('clear').validation.flags,
    [],
    'a lowest word at the threshold is not flagged',
  );
  assert.equal(byId('clear').validation.deterministicReviewRequired, false);
  assert.deepEqual(byId('unclear').validation.flags, [
    { code: 'LOW_TEXTRACT_CONFIDENCE', severity: 'WARNING', actual: 52.5 },
  ]);
  assert.deepEqual(
    byId('blank').validation.flags,
    [{ code: 'EMPTY_REQUIRED_CELL', severity: 'WARNING' }],
    'a cell without words gets no confidence flag',
  );
  assert.deepEqual(
    byId('unscored').validation.flags,
    [],
    'a word without a confidence is skipped',
  );
  assert.deepEqual(normalized.cellWordConfidences, [
    99,
    90,
    52.5,
    undefined,
    undefined,
  ]);
  assert.deepEqual(
    cellMeasurements(normalized.cells, normalized.cellWordConfidences),
    { meanConfidence: (99 + 90 + 52.5) / 3, reviewRequiredCells: 2 },
    'cells without a word confidence stay out of the mean',
  );
});

test('cellMeasurements has no mean when no cell holds a word confidence', () => {
  assert.deepEqual(
    cellMeasurements(
      [{ validation: { deterministicReviewRequired: true } }],
      [undefined],
    ),
    { reviewRequiredCells: 1 },
  );
});

/** `OcrMeanConfidenceAlarm` fires below this mean (spec 1.3 §9.1). */
const OCR_MEAN_CONFIDENCE_ALARM_BELOW = 90;
const fixturesDir = path.join(__dirname, 'fixtures');
const halo3Fixtures = fs
  .readdirSync(fixturesDir)
  .filter((file) => /^halo3-.*\.fixture\.json$/.test(file))
  .sort();

test('the halo3 fixtures are all present', () => {
  assert.deepEqual(halo3Fixtures, [
    'halo3-faint-assists-header-1.fixture.json',
    'halo3-faint-assists-header-2.fixture.json',
    'halo3-two-team-capture-1.fixture.json',
    'halo3-two-team-capture-2.fixture.json',
  ]);
});

for (const file of halo3Fixtures) {
  test(`${file}: most cells pass the confidence check and the mean clears the alarm`, () => {
    const { blocks } = JSON.parse(
      fs.readFileSync(path.join(fixturesDir, file), 'utf8'),
    ) as { blocks: Block[] };
    const normalized = normalize(blocks, source, 'run-1');
    const flagged = normalized.cells.filter((cell) =>
      cell.validation.flags.some(
        (flag) => flag.code === 'LOW_TEXTRACT_CONFIDENCE',
      ),
    ).length;
    const { meanConfidence } = cellMeasurements(
      normalized.cells,
      normalized.cellWordConfidences,
    );
    assert.ok(
      flagged < normalized.cells.length / 4,
      `${flagged} of ${normalized.cells.length} cells flagged`,
    );
    assert.ok(
      meanConfidence !== undefined &&
        meanConfidence > OCR_MEAN_CONFIDENCE_ALARM_BELOW,
      `mean ${meanConfidence}`,
    );
  });
}
