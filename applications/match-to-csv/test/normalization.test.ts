import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize } from '../src/lambdas/extract-text';

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
