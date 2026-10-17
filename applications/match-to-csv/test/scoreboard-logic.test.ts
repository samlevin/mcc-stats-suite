// test/scoreboard-logic.test.ts
//
// Unit tests for processScoreboardImage using node:test.
// These tests are intentionally very detailed and heavily commented,
// so that a junior developer can understand what's going on.
//
// To run:
//   npm test --workspace @mcc/match-to-csv
//
// The tests cover:
//   1) Simple 2-team match (Red vs Blue) with clear color separation.
//   2) Boards that are not two-team boards (one color cluster, no row color
//      data, three color clusters) yield no rows and say why.
//   3) Filtering of non-player rows (e.g. mis-detected header, blank rows),
//      and ignoring header and non-player row colors when assigning teams.
//   4) Header fallback logic when Textract can't read headers clearly.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  processScoreboardImage,
  type TextractBlockLite,
  type RowColor,
  type CsvRow,
} from '../src/lib/scoreboard-logic';

/**
 * Two-team row colors for the given row indexes: the first half red, the
 * rest blue, so the top row's team is Red.
 */
function twoTeamColors(rowIndexes: number[]): RowColor[] {
  const half = Math.ceil(rowIndexes.length / 2);
  return rowIndexes.map((rowIndex, position) =>
    position < half
      ? { rowIndex, r: 230, g: 20, b: 20 }
      : { rowIndex, r: 20, g: 20, b: 230 },
  );
}

/**
 * A board of PLAYERS/SCORE rows, one per name, with its first player on
 * RowIndex 2.
 */
function simpleBoard(prefix: string, names: string[]): TextractBlockLite[] {
  const cellIds = [`${prefix}-c-h-player`, `${prefix}-c-h-score`];
  const blocks: TextractBlockLite[] = [
    word(`${prefix}-w-h-player`, 'PLAYERS'),
    word(`${prefix}-w-h-score`, 'SCORE'),
    cell(`${prefix}-c-h-player`, 1, 1, `${prefix}-w-h-player`),
    cell(`${prefix}-c-h-score`, 1, 2, `${prefix}-w-h-score`),
  ];
  names.forEach((name, index) => {
    const rowIndex = index + 2;
    const id = `${prefix}-${rowIndex}`;
    blocks.push(
      word(`${id}-w-player`, name),
      word(`${id}-w-score`, String(20 - index)),
      cell(`${id}-c-player`, rowIndex, 1, `${id}-w-player`),
      cell(`${id}-c-score`, rowIndex, 2, `${id}-w-score`),
    );
    cellIds.push(`${id}-c-player`, `${id}-c-score`);
  });
  blocks.push(table(`${prefix}-tbl`, cellIds));
  return blocks;
}

/**
 * Helper: create a WORD block.
 */
function word(id: string, text: string): TextractBlockLite {
  return {
    Id: id,
    BlockType: 'WORD',
    Text: text,
  };
}

/**
 * Helper: create a CELL block with a single WORD child.
 * We only include the fields that processScoreboardImage actually uses.
 */
function cell(
  id: string,
  rowIndex: number,
  colIndex: number,
  wordBlockId: string,
): TextractBlockLite {
  return {
    Id: id,
    BlockType: 'CELL',
    RowIndex: rowIndex,
    ColumnIndex: colIndex,
    Relationships: [
      {
        Type: 'CHILD',
        Ids: [wordBlockId],
      },
    ],
  };
}

/**
 * Helper: build a simple TABLE block with given cell IDs.
 */
function table(tableId: string, cellIds: string[]): TextractBlockLite {
  return {
    Id: tableId,
    BlockType: 'TABLE',
    Relationships: [
      {
        Type: 'CHILD',
        Ids: cellIds,
      },
    ],
  };
}

/**
 * Test 1:
 * Simple 2-team match, Red vs Blue.
 *
 * - We build a tiny 3x5 table:
 *     Row 1: header (PLAYERS, SCORE, KILLS, ASSISTS, DEATHS)
 *     Row 2: Red player, higher score
 *     Row 3: Blue player, lower score
 * - Row colors:
 *     RowIndex 2: bright red
 *     RowIndex 3: bright blue
 * - We expect:
 *     - Team names: "Red" and "Blue"
 *     - Red player is the winner (rowIndex 2 is top player row)
 *     - Win/Loss set correctly
 */
test('processScoreboardImage: simple 2-team Red vs Blue match', () => {
  // Build WORD blocks for header row.
  const wPlayer = word('w-player', 'PLAYERS');
  const wScore = word('w-score', 'SCORE');
  const wKills = word('w-kills', 'KILLS');
  const wAssists = word('w-assists', 'ASSISTS');
  const wDeaths = word('w-deaths', 'DEATHS');

  // Build WORD blocks for player rows.
  const wRedName = word('w-red-name', 'RedGuy');
  const wRedScore = word('w-red-score', '20');
  const wRedKills = word('w-red-kills', '20');
  const wRedAssists = word('w-red-assists', '5');
  const wRedDeaths = word('w-red-deaths', '10');

  const wBlueName = word('w-blue-name', 'BlueGuy');
  const wBlueScore = word('w-blue-score', '10');
  const wBlueKills = word('w-blue-kills', '10');
  const wBlueAssists = word('w-blue-assists', '3');
  const wBlueDeaths = word('w-blue-deaths', '15');

  // Header row cells: rowIndex=1
  const cHeaderPlayer = cell('c-header-player', 1, 1, 'w-player');
  const cHeaderScore = cell('c-header-score', 1, 2, 'w-score');
  const cHeaderKills = cell('c-header-kills', 1, 3, 'w-kills');
  const cHeaderAssists = cell('c-header-assists', 1, 4, 'w-assists');
  const cHeaderDeaths = cell('c-header-deaths', 1, 5, 'w-deaths');

  // Red row: rowIndex=2
  const cRedPlayer = cell('c-red-player', 2, 1, 'w-red-name');
  const cRedScore = cell('c-red-score', 2, 2, 'w-red-score');
  const cRedKills = cell('c-red-kills', 2, 3, 'w-red-kills');
  const cRedAssists = cell('c-red-assists', 2, 4, 'w-red-assists');
  const cRedDeaths = cell('c-red-deaths', 2, 5, 'w-red-deaths');

  // Blue row: rowIndex=3
  const cBluePlayer = cell('c-blue-player', 3, 1, 'w-blue-name');
  const cBlueScore = cell('c-blue-score', 3, 2, 'w-blue-score');
  const cBlueKills = cell('c-blue-kills', 3, 3, 'w-blue-kills');
  const cBlueAssists = cell('c-blue-assists', 3, 4, 'w-blue-assists');
  const cBlueDeaths = cell('c-blue-deaths', 3, 5, 'w-blue-deaths');

  // TABLE block connects all CELL blocks.
  const tbl = table('tbl-1', [
    cHeaderPlayer.Id!,
    cHeaderScore.Id!,
    cHeaderKills.Id!,
    cHeaderAssists.Id!,
    cHeaderDeaths.Id!,
    cRedPlayer.Id!,
    cRedScore.Id!,
    cRedKills.Id!,
    cRedAssists.Id!,
    cRedDeaths.Id!,
    cBluePlayer.Id!,
    cBlueScore.Id!,
    cBlueKills.Id!,
    cBlueAssists.Id!,
    cBlueDeaths.Id!,
  ]);

  const blocks: TextractBlockLite[] = [
    tbl,
    // header WORDs
    wPlayer,
    wScore,
    wKills,
    wAssists,
    wDeaths,
    // red row WORDs
    wRedName,
    wRedScore,
    wRedKills,
    wRedAssists,
    wRedDeaths,
    // blue row WORDs
    wBlueName,
    wBlueScore,
    wBlueKills,
    wBlueAssists,
    wBlueDeaths,
    // cells
    cHeaderPlayer,
    cHeaderScore,
    cHeaderKills,
    cHeaderAssists,
    cHeaderDeaths,
    cRedPlayer,
    cRedScore,
    cRedKills,
    cRedAssists,
    cRedDeaths,
    cBluePlayer,
    cBlueScore,
    cBlueKills,
    cBlueAssists,
    cBlueDeaths,
  ];

  // Row background colors for team assignment:
  // rowIndex 2 is bright red, rowIndex 3 is bright blue.
  const rowColors: RowColor[] = [
    { rowIndex: 2, r: 230, g: 20, b: 20 }, // Red team
    { rowIndex: 3, r: 20, g: 20, b: 230 }, // Blue team
  ];

  const { rows, noRowsReason } = processScoreboardImage(blocks, rowColors);
  assert.equal(noRowsReason, undefined, 'a two-team board has no reason');
  assert.deepEqual(
    rows.length,
    2,
    'should produce exactly 2 player rows (one per player)',
  );

  // For easier checks, sort rows by player name.
  rows.sort((a, b) => a.player.localeCompare(b.player));

  const blue = rows.find((r) => r.player === 'BlueGuy') as CsvRow;
  const red = rows.find((r) => r.player === 'RedGuy') as CsvRow;

  assert.ok(red, 'RedGuy row should exist');
  assert.ok(blue, 'BlueGuy row should exist');

  assert.equal(red.team, 'Red', 'RedGuy should be on Red team');
  assert.equal(blue.team, 'Blue', 'BlueGuy should be on Blue team');

  assert.equal(red.win, 1, 'RedGuy (top row) should have win=1');
  assert.equal(red.loss, 0, 'RedGuy (top row) should have loss=0');

  assert.equal(blue.win, 0, 'BlueGuy (lower row) should have win=0');
  assert.equal(blue.loss, 1, 'BlueGuy (lower row) should have loss=1');
});

/**
 * Test 2:
 * Boards that are not two-team boards produce no rows.
 *
 * Only two-team boards are supported. When the player rows form one color
 * cluster, carry no row color data, or form three or more clusters, the
 * parser returns no rows and an UNSUPPORTED_TEAM_LAYOUT reason with the
 * cluster count.
 */
test('processScoreboardImage: one color cluster yields no rows', () => {
  const blocks = simpleBoard('one', ['PlayerOne', 'PlayerTwo', 'PlayerThree']);
  const rowColors: RowColor[] = [
    { rowIndex: 2, r: 120, g: 120, b: 120 },
    { rowIndex: 3, r: 120, g: 120, b: 120 },
    { rowIndex: 4, r: 125, g: 118, b: 122 },
  ];

  assert.deepEqual(processScoreboardImage(blocks, rowColors), {
    rows: [],
    noRowsReason: { code: 'UNSUPPORTED_TEAM_LAYOUT', colorClusterCount: 1 },
  });
});

test('processScoreboardImage: no row color data yields no rows', () => {
  const blocks = simpleBoard('none', ['PlayerOne', 'PlayerTwo']);
  const expected = {
    rows: [],
    noRowsReason: { code: 'UNSUPPORTED_TEAM_LAYOUT', colorClusterCount: 0 },
  };

  assert.deepEqual(processScoreboardImage(blocks, []), expected);
  // Colors for rows that are not player rows are no color data either.
  assert.deepEqual(
    processScoreboardImage(blocks, [{ rowIndex: 1, r: 30, g: 30, b: 30 }]),
    expected,
  );
});

test('processScoreboardImage: three color clusters yield no rows', () => {
  const blocks = simpleBoard('three', [
    'RedGuy',
    'BlueOne',
    'BlueTwo',
    'GreenGuy',
  ]);
  const rowColors: RowColor[] = [
    { rowIndex: 2, r: 220, g: 30, b: 30 }, // Red
    { rowIndex: 3, r: 30, g: 30, b: 220 }, // Blue
    { rowIndex: 4, r: 35, g: 35, b: 210 }, // Blue, same cluster as row 3
    { rowIndex: 5, r: 30, g: 220, b: 30 }, // Green
  ];

  assert.deepEqual(processScoreboardImage(blocks, rowColors), {
    rows: [],
    noRowsReason: { code: 'UNSUPPORTED_TEAM_LAYOUT', colorClusterCount: 3 },
  });
});

/**
 * Test 3:
 * Non-player rows should be filtered out.
 *
 * - We add a fake "Total" row with non-numeric score/kills.
 * - Only player rows with numeric score or kills should be returned.
 */
test('processScoreboardImage: filters out non-player rows', () => {
  const blocks = simpleBoard('np', ['RealPlayer', 'OtherPlayer']);
  const tbl = blocks.find((block) => block.BlockType === 'TABLE')!;
  tbl.Relationships![0].Ids!.push('np-c-total-player', 'np-c-total-score');
  blocks.push(
    word('np-w-total', 'Total'),
    word('np-w-total-score', 'N/A'), // not numeric
    cell('np-c-total-player', 4, 1, 'np-w-total'),
    cell('np-c-total-score', 4, 2, 'np-w-total-score'),
  );

  const { rows } = processScoreboardImage(blocks, twoTeamColors([2, 3]));
  assert.deepEqual(
    rows.map((r) => r.player),
    ['RealPlayer', 'OtherPlayer'],
    'only the real player rows should remain',
  );
});

/**
 * Test 3b:
 * Header and non-player row colors must not create team clusters.
 *
 * - The header row (RowIndex 1) and a "Total" row (RowIndex 4) are shaded
 *   differently from the player rows.
 * - Only player rows count toward team clustering, so player rows of one
 *   color stay one cluster and yield no rows, and two-team player rows stay
 *   two clusters.
 */
test('processScoreboardImage: header and non-player row colors do not create teams', () => {
  const blocks: TextractBlockLite[] = [
    table('hc-tbl', [
      'hc-c-h-player',
      'hc-c-h-score',
      'hc-c-p1-player',
      'hc-c-p1-score',
      'hc-c-p2-player',
      'hc-c-p2-score',
      'hc-c-total-player',
      'hc-c-total-score',
    ]),
    word('hc-w-h-player', 'PLAYERS'),
    word('hc-w-h-score', 'SCORE'),
    word('hc-w-p1', 'PlayerOne'),
    word('hc-w-p1-score', '15'),
    word('hc-w-p2', 'PlayerTwo'),
    word('hc-w-p2-score', '9'),
    word('hc-w-total', 'Total'),
    word('hc-w-total-score', 'N/A'),
    cell('hc-c-h-player', 1, 1, 'hc-w-h-player'),
    cell('hc-c-h-score', 1, 2, 'hc-w-h-score'),
    cell('hc-c-p1-player', 2, 1, 'hc-w-p1'),
    cell('hc-c-p1-score', 2, 2, 'hc-w-p1-score'),
    cell('hc-c-p2-player', 3, 1, 'hc-w-p2'),
    cell('hc-c-p2-score', 3, 2, 'hc-w-p2-score'),
    cell('hc-c-total-player', 4, 1, 'hc-w-total'),
    cell('hc-c-total-score', 4, 2, 'hc-w-total-score'),
  ];

  const oneColor: RowColor[] = [
    { rowIndex: 1, r: 30, g: 30, b: 30 }, // dark header
    { rowIndex: 2, r: 120, g: 120, b: 120 },
    { rowIndex: 3, r: 120, g: 120, b: 120 },
    { rowIndex: 4, r: 20, g: 20, b: 230 }, // blue-tinted footer
  ];
  assert.deepEqual(
    processScoreboardImage(blocks, oneColor),
    {
      rows: [],
      noRowsReason: { code: 'UNSUPPORTED_TEAM_LAYOUT', colorClusterCount: 1 },
    },
    'one player color is one cluster, not a two-team board',
  );

  const twoTeams: RowColor[] = [
    { rowIndex: 1, r: 30, g: 30, b: 30 }, // dark header
    { rowIndex: 2, r: 230, g: 20, b: 20 },
    { rowIndex: 3, r: 20, g: 20, b: 230 },
    { rowIndex: 4, r: 20, g: 230, b: 20 }, // green-tinted footer
  ];
  const { rows, noRowsReason } = processScoreboardImage(blocks, twoTeams);
  assert.equal(noRowsReason, undefined);
  assert.deepEqual(
    rows.map((r) => [r.player, r.team, r.win, r.loss]),
    [
      ['PlayerOne', 'Red', 1, 0],
      ['PlayerTwo', 'Blue', 0, 1],
    ],
    'two player colors stay a two-team board',
  );
});

/**
 * Test 4:
 * Header fallback logic.
 *
 * - We simulate a situation where Textract mis-reads header texts (e.g. "P1", "P2").
 * - In that case, processScoreboardImage falls back to assuming:
 *     col 1 => Player, col 2 => Score, col 3 => Kills, col 4 => Assists, col 5 => Deaths.
 * - We verify that stats still go into the correct fields.
 */
test('processScoreboardImage: header fallback when headers are not clearly recognized', () => {
  // Fake headers (Textract mis-reads them).
  const wH1 = word('hf-w-h1', 'P1');
  const wH2 = word('hf-w-h2', 'P2');
  const wH3 = word('hf-w-h3', 'P3');
  const wH4 = word('hf-w-h4', 'P4');
  const wH5 = word('hf-w-h5', 'P5');

  const wName = word('hf-w-name', 'MysteryPlayer');
  const wScore = word('hf-w-score', '30');
  const wKills = word('hf-w-kills', '25');
  const wAssists = word('hf-w-assists', '5');
  const wDeaths = word('hf-w-deaths', '8');

  const cH1 = cell('hf-c-h1', 1, 1, 'hf-w-h1');
  const cH2 = cell('hf-c-h2', 1, 2, 'hf-w-h2');
  const cH3 = cell('hf-c-h3', 1, 3, 'hf-w-h3');
  const cH4 = cell('hf-c-h4', 1, 4, 'hf-w-h4');
  const cH5 = cell('hf-c-h5', 1, 5, 'hf-w-h5');

  const cName = cell('hf-c-name', 2, 1, 'hf-w-name');
  const cScore = cell('hf-c-score', 2, 2, 'hf-w-score');
  const cKills = cell('hf-c-kills', 2, 3, 'hf-w-kills');
  const cAssists = cell('hf-c-assists', 2, 4, 'hf-w-assists');
  const cDeaths = cell('hf-c-deaths', 2, 5, 'hf-w-deaths');

  const tbl = table('hf-tbl', [
    cH1.Id!,
    cH2.Id!,
    cH3.Id!,
    cH4.Id!,
    cH5.Id!,
    cName.Id!,
    cScore.Id!,
    cKills.Id!,
    cAssists.Id!,
    cDeaths.Id!,
  ]);

  const blocks: TextractBlockLite[] = [
    tbl,
    wH1,
    wH2,
    wH3,
    wH4,
    wH5,
    wName,
    wScore,
    wKills,
    wAssists,
    wDeaths,
    cH1,
    cH2,
    cH3,
    cH4,
    cH5,
    cName,
    cScore,
    cKills,
    cAssists,
    cDeaths,
  ];

  // A second player on the other team, so the board is a two-team board.
  ['OtherPlayer', '10', '9', '1', '12'].forEach((text, index) => {
    const column = index + 1;
    blocks.push(
      word(`hf-w-other-${column}`, text),
      cell(`hf-c-other-${column}`, 3, column, `hf-w-other-${column}`),
    );
    tbl.Relationships![0].Ids!.push(`hf-c-other-${column}`);
  });

  const { rows } = processScoreboardImage(blocks, twoTeamColors([2, 3]));
  assert.deepEqual(rows.length, 2, 'should produce exactly 2 rows');

  const row = rows[0];
  assert.equal(
    row.player,
    'MysteryPlayer',
    'player name should be mapped from col 1',
  );
  assert.equal(row.score, '30', 'score should be mapped from col 2');
  assert.equal(row.kills, '25', 'kills should be mapped from col 3');
  assert.equal(row.assists, '5', 'assists should be mapped from col 4');
  assert.equal(row.deaths, '8', 'deaths should be mapped from col 5');
});

test('processScoreboardImage selects the scoreboard when Textract finds another table first', () => {
  const decoyHeader = cell('decoy-header', 1, 1, 'decoy-header-word');
  const decoyValue = cell('decoy-value', 2, 1, 'decoy-value-word');
  const playerHeader = cell('player-header', 1, 1, 'player-header-word');
  const scoreHeader = cell('score-header', 1, 2, 'score-header-word');
  const playerValue = cell('player-value', 2, 1, 'player-value-word');
  const scoreValue = cell('score-value', 2, 2, 'score-value-word');
  const otherPlayer = cell('other-player', 3, 1, 'other-player-word');
  const otherScore = cell('other-score', 3, 2, 'other-score-word');
  const blocks = [
    table('decoy-table', ['decoy-header', 'decoy-value']),
    word('decoy-header-word', 'SETTING'),
    word('decoy-value-word', 'ON'),
    decoyHeader,
    decoyValue,
    table('scoreboard-table', [
      'player-header',
      'score-header',
      'player-value',
      'score-value',
      'other-player',
      'other-score',
    ]),
    word('player-header-word', 'PLAYERS'),
    word('score-header-word', 'SCORE'),
    word('player-value-word', 'Spartan'),
    word('score-value-word', '19'),
    word('other-player-word', 'Elite'),
    word('other-score-word', '7'),
    playerHeader,
    scoreHeader,
    playerValue,
    scoreValue,
    otherPlayer,
    otherScore,
  ];
  const { rows } = processScoreboardImage(blocks, twoTeamColors([2, 3]));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].player, 'Spartan');
  assert.equal(rows[0].score, '19');
});

test('processScoreboardImage drops icon words Textract reads in the player column', () => {
  const nameCell = (
    id: string,
    rowIndex: number,
    wordIds: string[],
  ): TextractBlockLite => ({
    Id: id,
    BlockType: 'CELL',
    RowIndex: rowIndex,
    ColumnIndex: 1,
    Relationships: [{ Type: 'CHILD', Ids: wordIds }],
  });
  const blocks: TextractBlockLite[] = [
    table('icon-table', [
      'icon-player-header',
      'icon-score-header',
      'icon-chat',
      'icon-chat-score',
      'icon-split',
      'icon-split-score',
    ]),
    cell('icon-player-header', 1, 1, 'icon-player-header-word'),
    cell('icon-score-header', 1, 2, 'icon-score-header-word'),
    word('icon-player-header-word', 'PLAYERS'),
    word('icon-score-header-word', 'SCORE'),
    // MCC draws a chat bubble over the player column; Textract reads "...".
    nameCell('icon-chat', 2, ['icon-clan', 'icon-dots', 'icon-name']),
    word('icon-clan', '[UNSC]'),
    word('icon-dots', '...'),
    word('icon-name', 'Spartan117'),
    cell('icon-chat-score', 2, 2, 'icon-chat-score-word'),
    word('icon-chat-score-word', '13'),
    // A bracket Textract reads as its own word still delimits the clan tag.
    nameCell('icon-split', 3, [
      'icon-open',
      'icon-tag',
      'icon-name-1',
      'icon-name-2',
    ]),
    word('icon-open', '['),
    word('icon-tag', 'Elite]'),
    word('icon-name-1', 'Noble'),
    word('icon-name-2', 'Six'),
    cell('icon-split-score', 3, 2, 'icon-split-score-word'),
    word('icon-split-score-word', '7'),
  ];
  const { rows } = processScoreboardImage(blocks, twoTeamColors([2, 3]));
  assert.deepEqual(
    rows.map((row) => row.player),
    ['Spartan117', 'Noble Six'],
  );
});

test('processScoreboardImage flags possibly misread gamertags and keeps them as read', () => {
  // Each row is the player cell's words as [text, WORD confidence].
  const players: [string, number | undefined][][] = [
    // A low-confidence clan tag or icon word is not part of the name.
    [
      ['[UNSC]', 20],
      ['...', 10],
      ['Spartan117', 99],
    ],
    // A lowercase l read as an uppercase I, at very low confidence.
    [['PIayer05', 39]],
    // A high-confidence name with a space before its digits is left alone.
    [
      ['Agent', 99],
      ['47', 99],
    ],
    // The same split read with low confidence may be a misread space.
    [
      ['Player', 60],
      ['06', 95],
    ],
    // Both rules can apply to one name.
    [
      ['Lone', 40],
      ['7', 95],
    ],
    // Without a confidence there is no evidence for a flag.
    [['NoConfidence', undefined]],
  ];
  const blocks: TextractBlockLite[] = [
    word('flag-player-header-word', 'PLAYERS'),
    word('flag-score-header-word', 'SCORE'),
    cell('flag-player-header', 1, 1, 'flag-player-header-word'),
    cell('flag-score-header', 1, 2, 'flag-score-header-word'),
  ];
  const cellIds = ['flag-player-header', 'flag-score-header'];
  players.forEach((words, index) => {
    const rowIndex = index + 2;
    const wordIds = words.map(([text, confidence], position) => {
      const id = `flag-${rowIndex}-word-${position}`;
      blocks.push({ ...word(id, text), Confidence: confidence });
      return id;
    });
    blocks.push(
      {
        Id: `flag-${rowIndex}-player`,
        BlockType: 'CELL',
        RowIndex: rowIndex,
        ColumnIndex: 1,
        Relationships: [{ Type: 'CHILD', Ids: wordIds }],
      },
      word(`flag-${rowIndex}-score-word`, '10'),
      cell(
        `flag-${rowIndex}-score`,
        rowIndex,
        2,
        `flag-${rowIndex}-score-word`,
      ),
    );
    cellIds.push(`flag-${rowIndex}-player`, `flag-${rowIndex}-score`);
  });
  blocks.push(table('flag-table', cellIds));

  const { rows } = processScoreboardImage(
    blocks,
    twoTeamColors(players.map((_, index) => index + 2)),
  );
  const low = (wordConfidence: number) => ({
    field: 'player',
    code: 'LOW_WORD_CONFIDENCE',
    wordConfidence,
  });
  const split = (wordConfidence: number) => ({
    field: 'player',
    code: 'SPLIT_TRAILING_DIGITS',
    wordConfidence,
  });
  assert.deepEqual(
    rows.map((row) => [row.player, row.reviewFlags]),
    [
      ['Spartan117', undefined],
      ['PIayer05', [low(39)]],
      ['Agent 47', undefined],
      ['Player 06', [split(60)]],
      ['Lone 7', [low(40), split(40)]],
      ['NoConfidence', undefined],
    ],
  );
  assert.ok(!('reviewFlags' in rows[0]), 'an unflagged row has no flag list');
});
