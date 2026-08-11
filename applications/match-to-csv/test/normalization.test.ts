import t from 'tap';
import { normalize } from '../src/lambdas/extract-text';

const source = { screenshotId: 'screen-1', submissionId: 'submission-1', bucket: 'evidence', key: 'source/original', attachmentName: 'scoreboard.png', contentType: 'image/png', sha256: 'hash', acquisitionType: 'SCREENSHOT' as const, widthPx: 1920, heightPx: 1080 };

function word(id: string, text: string) { return { Id: id, BlockType: 'WORD' as const, Text: text }; }
function cell(id: string, row: number, column: number, wordId: string) { return { Id: id, BlockType: 'CELL' as const, RowIndex: row, ColumnIndex: column, Confidence: 99, Relationships: [{ Type: 'CHILD' as const, Ids: [wordId] }] }; }

t.test('normalization maps known scoreboard headers to semantic fields', (t) => {
  const blocks = [
    { Id: 'table', BlockType: 'TABLE' as const, Relationships: [{ Type: 'CHILD' as const, Ids: ['h-player', 'h-score', 'player', 'score'] }] },
    cell('h-player', 1, 1, 'w-player'), cell('h-score', 1, 2, 'w-score'),
    cell('player', 2, 1, 'w-name'), cell('score', 2, 2, 'w-value'),
    word('w-player', 'PLAYER'), word('w-score', 'SCORE'), word('w-name', 'Spartan'), word('w-value', '19'),
  ];
  const normalized = normalize(blocks, source, 'run-1');
  t.equal(normalized.cells.find((item) => item.providerBlockId === 'player')?.semanticLocation.field, 'PLAYER');
  const score = normalized.cells.find((item) => item.providerBlockId === 'score');
  t.equal(score?.semanticLocation.field, 'SCORE');
  t.equal(score?.parsed.expectedType, 'INTEGER');
  t.equal(score?.tableObservationId, 'run-1:table:table');
  t.equal(score?.tableLocation.tableIndex, 0);
  const scoreHeader = normalized.cells.find((item) => item.providerBlockId === 'h-score');
  t.equal(scoreHeader?.semanticLocation.rowRole, 'HEADER');
  t.equal(scoreHeader?.parsed.expectedType, 'STRING');
  t.equal(scoreHeader?.validation.valid, true);
  t.notOk(scoreHeader?.validation.flags.some((flag) => flag.code === 'INVALID_INTEGER'));
  t.end();
});

t.test('normalization maps each table independently and flags invalid integers', (t) => {
  const blocks = [
    { Id: 'table-a', BlockType: 'TABLE' as const, Relationships: [{ Type: 'CHILD' as const, Ids: ['a-header', 'a-value'] }] },
    cell('a-header', 1, 1, 'a-header-word'),
    cell('a-value', 2, 1, 'a-value-word'),
    word('a-header-word', 'PLAYER'),
    word('a-value-word', 'Spartan'),
    { Id: 'table-b', BlockType: 'TABLE' as const, Relationships: [{ Type: 'CHILD' as const, Ids: ['b-header', 'b-value'] }] },
    cell('b-header', 1, 1, 'b-header-word'),
    cell('b-value', 2, 1, 'b-value-word'),
    word('b-header-word', 'SCORE'),
    word('b-value-word', 'I9'),
  ];
  const normalized = normalize(blocks, source, 'run-1');
  const player = normalized.cells.find((item) => item.providerBlockId === 'a-value');
  const score = normalized.cells.find((item) => item.providerBlockId === 'b-value');
  t.equal(player?.semanticLocation.field, 'PLAYER');
  t.equal(score?.semanticLocation.field, 'SCORE');
  t.equal(score?.tableLocation.tableIndex, 1);
  t.equal(score?.parsed.parseSucceeded, false);
  t.equal(score?.validation.valid, false);
  t.ok(score?.validation.flags.some((flag) => flag.code === 'INVALID_INTEGER'));
  t.end();
});
