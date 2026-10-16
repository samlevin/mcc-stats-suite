import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Block } from '@aws-sdk/client-textract';
import { assertOutsideRepository } from '../scripts/fixture-paths';
import {
  assertNoRealNames,
  reduceCapture,
  type PlaceholderMapping,
  type TextractCapture,
} from '../scripts/reduce-capture';
import { processScoreboardImage } from '../src/lib/scoreboard-logic';

function word(id: string, text: string): Block {
  return {
    Id: id,
    BlockType: 'WORD',
    Text: text,
    Confidence: 99.5,
    Page: 1,
    Geometry: {
      BoundingBox: { Top: 0.2, Height: 0.02, Left: 0.1, Width: 0.05 },
      Polygon: [{ X: 0.1, Y: 0.2 }],
    },
  };
}

function cell(
  id: string,
  rowIndex: number,
  columnIndex: number,
  wordIds: string[],
): Block {
  return {
    Id: id,
    BlockType: 'CELL',
    RowIndex: rowIndex,
    ColumnIndex: columnIndex,
    Page: 1,
    Geometry: {
      BoundingBox: { Top: 0.1 * rowIndex, Height: 0.05, Left: 0, Width: 0.4 },
      Polygon: [{ X: 0, Y: 0.1 * rowIndex }],
    },
    Relationships: wordIds.length ? [{ Type: 'CHILD', Ids: wordIds }] : [],
  };
}

/**
 * A Textract-style capture with one scoreboard table and text outside it.
 * Player rows alternate red and blue, so the parser reads a two-team board.
 */
function capture(playerWords: Record<string, string[]>): TextractCapture {
  const rows = Object.entries(playerWords);
  const cells = [
    cell('h-player', 1, 1, ['w-h-player']),
    cell('h-score', 1, 2, ['w-h-score']),
    ...rows.flatMap(([, words], index) => [
      cell(
        `c-player-${index}`,
        index + 2,
        1,
        words.map((_, position) => `w-${index}-${position}`),
      ),
      cell(`c-score-${index}`, index + 2, 2, [`w-score-${index}`]),
    ]),
  ];
  const blocks: Block[] = [
    { Id: 'page', BlockType: 'PAGE' },
    {
      Id: 'line',
      BlockType: 'LINE',
      Text: rows.map(([real]) => real).join(' '),
    },
    word('w-title', 'RED TEAM WON'),
    {
      Id: 'table',
      BlockType: 'TABLE',
      Relationships: [{ Type: 'CHILD', Ids: cells.map((block) => block.Id!) }],
    },
    ...cells,
    word('w-h-player', 'PLAYERS'),
    word('w-h-score', 'SCORE'),
    ...rows.flatMap(([, words], index) => [
      ...words.map((text, position) => word(`w-${index}-${position}`, text)),
      word(`w-score-${index}`, String(10 + index)),
    ]),
  ];
  return {
    rowColors: rows.map((_, index) => ({
      rowIndex: index + 2,
      r: index % 2 ? 0 : 200,
      g: 0,
      b: index % 2 ? 200 : 0,
    })),
    response: { Blocks: blocks },
  };
}

const mapping: PlaceholderMapping = {
  names: {
    'Master Chief': 'Player01 A',
    Arbiter117: 'Player02',
    Arbiterl17: 'PIayer02',
  },
  clanTags: { UNSC: 'CLAN1', 'Covenant Elite': 'CLAN2 X' },
};

function textOf(blocks: Block[], id: string): string | undefined {
  return blocks.find((block) => block.Id === id)?.Text;
}

test('reduceCapture replaces names and clan tags word by word', () => {
  const fixture = reduceCapture(
    capture({
      'Master Chief': ['[UNSC]', 'Master', 'Chief'],
      'Covenant Elite': ['[Covenant', 'Elite]', '...', 'Arbiter117'],
    }),
    mapping,
    'synthetic',
  );
  assert.equal(fixture.name, 'synthetic');
  assert.deepEqual(
    ['w-0-0', 'w-0-1', 'w-0-2', 'w-1-0', 'w-1-1', 'w-1-2', 'w-1-3'].map((id) =>
      textOf(fixture.blocks, id),
    ),
    ['[CLAN1]', 'Player01', 'A', '[CLAN2', 'X]', '...', 'Player02'],
  );
  assert.deepEqual(
    processScoreboardImage(fixture.blocks, fixture.rowColors).rows.map(
      (row) => row.player,
    ),
    ['Player01 A', 'Player02'],
  );
});

test('reduceCapture keeps characters Textract misread around a clan tag', () => {
  const fixture = reduceCapture(
    capture({ Arbiter: ['IUNSC]', 'Arbiterl17'] }),
    mapping,
    'misread',
  );
  assert.equal(textOf(fixture.blocks, 'w-0-0'), 'ICLAN1]');
  assert.equal(textOf(fixture.blocks, 'w-0-1'), 'PIayer02');
});

test('reduceCapture copies everything except player-column text', () => {
  const source = capture({ 'Master Chief': ['Master', 'Chief'] });
  const fixture = reduceCapture(source, mapping, 'copy');
  const ids = fixture.blocks.map((block) => block.Id);
  assert.ok(!ids.includes('page') && !ids.includes('line'));
  assert.ok(!ids.includes('w-title'), 'words outside a table are dropped');
  assert.equal(textOf(fixture.blocks, 'w-h-player'), 'PLAYERS');
  assert.equal(textOf(fixture.blocks, 'w-score-0'), '10');
  assert.deepEqual(fixture.rowColors, source.rowColors);

  const original = source.response.Blocks!.find((b) => b.Id === 'c-player-0')!;
  const reduced = fixture.blocks.find((b) => b.Id === 'c-player-0')!;
  assert.deepEqual(reduced, {
    Id: original.Id,
    BlockType: original.BlockType,
    RowIndex: original.RowIndex,
    ColumnIndex: original.ColumnIndex,
    Geometry: { BoundingBox: original.Geometry!.BoundingBox },
    Relationships: original.Relationships,
  });
  const reducedWord = fixture.blocks.find((b) => b.Id === 'w-score-0')!;
  assert.equal(reducedWord.Confidence, 99.5);
});

test('reduceCapture refuses a player cell the mapping does not cover', () => {
  assert.throws(
    () =>
      reduceCapture(capture({ Unknown: ['[UNSC]', 'Cortana'] }), mapping, 'x'),
    /not covered by the mapping/,
  );
  assert.throws(
    () => reduceCapture(capture({ Joined: ['[UNSC]Ed'] }), mapping, 'x'),
    /not covered by the mapping/,
  );
});

test('reduceCapture refuses invalid mappings', () => {
  const source = capture({ 'Master Chief': ['Master', 'Chief'] });
  assert.throws(
    () => reduceCapture(source, { names: {}, clanTags: {} }, 'x'),
    /no entries/,
  );
  assert.throws(
    () =>
      reduceCapture(
        source,
        { names: { 'Master Chief': 'Player01' }, clanTags: {} },
        'x',
      ),
    /same word count/,
  );
  assert.throws(
    () =>
      reduceCapture(
        source,
        { names: { 'Master Chief': 'Chief01 A' }, clanTags: {} },
        'x',
      ),
    /contains a real gamertag/,
  );
});

test('assertNoRealNames checks block text, expected rows, and misreads', () => {
  const blocks = [word('w', 'Player02')];
  assert.doesNotThrow(() =>
    assertNoRealNames(
      { blocks, expectedRows: [{ player: 'Player02' }] },
      mapping,
    ),
  );
  assert.throws(
    () =>
      assertNoRealNames(
        { blocks, expectedRows: [{ player: 'master chief' }] },
        mapping,
      ),
    /remains in the fixture/,
  );
  assert.throws(
    () => assertNoRealNames({ blocks: [word('w', 'Chiefly')] }, mapping),
    /remains in the fixture/,
  );
  assert.throws(
    () =>
      assertNoRealNames(
        {
          blocks,
          misreads: [{ expected: 'Player02', read: 'Master Chlef' }],
        },
        mapping,
      ),
    /remains in the fixture/,
  );
});

test('assertOutsideRepository refuses paths inside a Git working tree', () => {
  assert.throws(
    () => assertOutsideRepository(path.join(__dirname, 'new', 'capture.json')),
    /inside the Git working tree/,
  );
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-capture-'));
  try {
    assert.doesNotThrow(() =>
      assertOutsideRepository(path.join(outside, 'not-yet', 'a.json')),
    );
  } finally {
    fs.rmSync(outside, { recursive: true });
  }
});
