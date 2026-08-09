// test/processScoreboardImage.test.ts
//
// Unit tests for processScoreboardImage using tap (TAP-compatible).
// These tests are intentionally very detailed and heavily commented,
// so that a junior developer can understand what's going on.
//
// To run:
//   npx tap --ts test/processScoreboardImage.test.ts
//
// The tests cover:
//   1) Simple 2-team match (Red vs Blue) with clear color separation.
//   2) Free-for-all match where all row colors are the same (no teams).
//   3) Three-team match (Red vs Blue vs Green) with uneven team sizes.
//   4) Filtering of non-player rows (e.g. mis-detected header, blank rows).
//   5) Header fallback logic when Textract can't read headers clearly.

import t from 'tap';
import {
  processScoreboardImage,
  TextractBlockLite,
  RowColor,
  CsvRow,
} from '../src/lib/scoreboard-logic';

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
t.test('processScoreboardImage: simple 2-team Red vs Blue match', (t) => {
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
    { rowIndex: 2, r: 230, g: 20, b: 20 },  // Red team
    { rowIndex: 3, r: 20, g: 20, b: 230 },  // Blue team
  ];

  const rows = processScoreboardImage(blocks, rowColors);
  t.same(
    rows.length,
    2,
    'should produce exactly 2 player rows (one per player)',
  );

  // For easier checks, sort rows by player name.
  rows.sort((a, b) => a.player.localeCompare(b.player));

  const blue = rows.find((r) => r.player === 'BlueGuy') as CsvRow;
  const red = rows.find((r) => r.player === 'RedGuy') as CsvRow;

  t.ok(red, 'RedGuy row should exist');
  t.ok(blue, 'BlueGuy row should exist');

  t.equal(red.team, 'Red', 'RedGuy should be on Red team');
  t.equal(blue.team, 'Blue', 'BlueGuy should be on Blue team');

  t.equal(red.win, 1, 'RedGuy (top row) should have win=1');
  t.equal(red.loss, 0, 'RedGuy (top row) should have loss=0');

  t.equal(blue.win, 0, 'BlueGuy (lower row) should have win=0');
  t.equal(blue.loss, 1, 'BlueGuy (lower row) should have loss=1');

  t.end();
});

/**
 * Test 2:
 * Free-for-all (FFA) match.
 *
 * - All row colors are the SAME, so clustering will produce 1 cluster.
 * - processScoreboardImage treats this as FFA:
 *     * Team column should be empty for all players.
 *     * Only the top row is the winner (score doesn't matter here).
 */
t.test('processScoreboardImage: free-for-all match (no teams)', (t) => {
  // Very similar to previous test, but we make both rows have the same color.
  const wPlayer = word('ffa-w-player', 'PLAYERS');
  const wScore = word('ffa-w-score', 'SCORE');
  const wKills = word('ffa-w-kills', 'KILLS');
  const wAssists = word('ffa-w-assists', 'ASSISTS');
  const wDeaths = word('ffa-w-deaths', 'DEATHS');

  const wP1 = word('ffa-w-p1-name', 'PlayerOne');
  const wP1Score = word('ffa-w-p1-score', '15');
  const wP1Kills = word('ffa-w-p1-kills', '15');
  const wP1Assists = word('ffa-w-p1-assists', '5');
  const wP1Deaths = word('ffa-w-p1-deaths', '10');

  const wP2 = word('ffa-w-p2-name', 'PlayerTwo');
  const wP2Score = word('ffa-w-p2-score', '10');
  const wP2Kills = word('ffa-w-p2-kills', '10');
  const wP2Assists = word('ffa-w-p2-assists', '3');
  const wP2Deaths = word('ffa-w-p2-deaths', '12');

  const cHeaderPlayer = cell('ffa-c-header-player', 1, 1, 'ffa-w-player');
  const cHeaderScore = cell('ffa-c-header-score', 1, 2, 'ffa-w-score');
  const cHeaderKills = cell('ffa-c-header-kills', 1, 3, 'ffa-w-kills');
  const cHeaderAssists = cell('ffa-c-header-assists', 1, 4, 'ffa-w-assists');
  const cHeaderDeaths = cell('ffa-c-header-deaths', 1, 5, 'ffa-w-deaths');

  const cP1Player = cell('ffa-c-p1-player', 2, 1, 'ffa-w-p1-name');
  const cP1Score = cell('ffa-c-p1-score', 2, 2, 'ffa-w-p1-score');
  const cP1Kills = cell('ffa-c-p1-kills', 2, 3, 'ffa-w-p1-kills');
  const cP1Assists = cell('ffa-c-p1-assists', 2, 4, 'ffa-w-p1-assists');
  const cP1Deaths = cell('ffa-c-p1-deaths', 2, 5, 'ffa-w-p1-deaths');

  const cP2Player = cell('ffa-c-p2-player', 3, 1, 'ffa-w-p2-name');
  const cP2Score = cell('ffa-c-p2-score', 3, 2, 'ffa-w-p2-score');
  const cP2Kills = cell('ffa-c-p2-kills', 3, 3, 'ffa-w-p2-kills');
  const cP2Assists = cell('ffa-c-p2-assists', 3, 4, 'ffa-w-p2-assists');
  const cP2Deaths = cell('ffa-c-p2-deaths', 3, 5, 'ffa-w-p2-deaths');

  const tbl = table('ffa-tbl', [
    cHeaderPlayer.Id!,
    cHeaderScore.Id!,
    cHeaderKills.Id!,
    cHeaderAssists.Id!,
    cHeaderDeaths.Id!,
    cP1Player.Id!,
    cP1Score.Id!,
    cP1Kills.Id!,
    cP1Assists.Id!,
    cP1Deaths.Id!,
    cP2Player.Id!,
    cP2Score.Id!,
    cP2Kills.Id!,
    cP2Assists.Id!,
    cP2Deaths.Id!,
  ]);

  const blocks: TextractBlockLite[] = [
    tbl,
    wPlayer,
    wScore,
    wKills,
    wAssists,
    wDeaths,
    wP1,
    wP1Score,
    wP1Kills,
    wP1Assists,
    wP1Deaths,
    wP2,
    wP2Score,
    wP2Kills,
    wP2Assists,
    wP2Deaths,
    cHeaderPlayer,
    cHeaderScore,
    cHeaderKills,
    cHeaderAssists,
    cHeaderDeaths,
    cP1Player,
    cP1Score,
    cP1Kills,
    cP1Assists,
    cP1Deaths,
    cP2Player,
    cP2Score,
    cP2Kills,
    cP2Assists,
    cP2Deaths,
  ];

  // All rows same background color => FFA.
  const rowColors: RowColor[] = [
    { rowIndex: 2, r: 120, g: 120, b: 120 },
    { rowIndex: 3, r: 120, g: 120, b: 120 },
  ];

  const rows = processScoreboardImage(blocks, rowColors);
  t.same(rows.length, 2, 'should produce 2 rows in FFA');

  const p1 = rows.find((r) => r.player === 'PlayerOne') as CsvRow;
  const p2 = rows.find((r) => r.player === 'PlayerTwo') as CsvRow;

  t.equal(p1.team, '', 'PlayerOne should have empty team (FFA)');
  t.equal(p2.team, '', 'PlayerTwo should have empty team (FFA)');

  t.equal(p1.win, 1, 'PlayerOne (top row) should be winner in FFA');
  t.equal(p1.loss, 0, 'PlayerOne should have loss=0 in FFA');

  t.equal(p2.win, 0, 'PlayerTwo should be non-winner in FFA');
  t.equal(p2.loss, 1, 'PlayerTwo should have loss=1 in FFA');

  t.end();
});

/**
 * Test 3:
 * Three-team match with uneven team sizes (Red vs Blue vs Green).
 *
 * - Row colors:
 *     Row 2 -> Red
 *     Row 3 -> Blue
 *     Row 4 -> Blue (same team as Row 3)
 *     Row 5 -> Green
 * - We expect:
 *     - 3 team names (Red, Blue, Green).
 *     - All Blue players share the same team name.
 *     - Top row (RowIndex 2) = Red player is the winner.
 */
t.test('processScoreboardImage: 3-team match with uneven sizes', (t) => {
  // We'll simplify the table: only 1 stat column we care about (Score).
  const wPlayer = word('3t-w-player', 'PLAYERS');
  const wScore = word('3t-w-score', 'SCORE');

  const wRed = word('3t-w-red', 'RedGuy');
  const wRedScore = word('3t-w-red-score', '25');

  const wBlue1 = word('3t-w-blue1', 'BlueOne');
  const wBlue1Score = word('3t-w-blue1-score', '15');

  const wBlue2 = word('3t-w-blue2', 'BlueTwo');
  const wBlue2Score = word('3t-w-blue2-score', '10');

  const wGreen = word('3t-w-green', 'GreenGuy');
  const wGreenScore = word('3t-w-green-score', '5');

  // Header row
  const cHeaderPlayer = cell('3t-c-header-player', 1, 1, '3t-w-player');
  const cHeaderScore = cell('3t-c-header-score', 1, 2, '3t-w-score');

  // Red row
  const cRedPlayer = cell('3t-c-red-player', 2, 1, '3t-w-red');
  const cRedScore = cell('3t-c-red-score', 2, 2, '3t-w-red-score');

  // BlueOne row
  const cBlue1Player = cell('3t-c-blue1-player', 3, 1, '3t-w-blue1');
  const cBlue1Score = cell('3t-c-blue1-score', 3, 2, '3t-w-blue1-score');

  // BlueTwo row
  const cBlue2Player = cell('3t-c-blue2-player', 4, 1, '3t-w-blue2');
  const cBlue2Score = cell('3t-c-blue2-score', 4, 2, '3t-w-blue2-score');

  // Green row
  const cGreenPlayer = cell('3t-c-green-player', 5, 1, '3t-w-green');
  const cGreenScore = cell('3t-c-green-score', 5, 2, '3t-w-green-score');

  const tbl = table('3t-tbl', [
    cHeaderPlayer.Id!,
    cHeaderScore.Id!,
    cRedPlayer.Id!,
    cRedScore.Id!,
    cBlue1Player.Id!,
    cBlue1Score.Id!,
    cBlue2Player.Id!,
    cBlue2Score.Id!,
    cGreenPlayer.Id!,
    cGreenScore.Id!,
  ]);

  const blocks: TextractBlockLite[] = [
    tbl,
    wPlayer,
    wScore,
    wRed,
    wRedScore,
    wBlue1,
    wBlue1Score,
    wBlue2,
    wBlue2Score,
    wGreen,
    wGreenScore,
    cHeaderPlayer,
    cHeaderScore,
    cRedPlayer,
    cRedScore,
    cBlue1Player,
    cBlue1Score,
    cBlue2Player,
    cBlue2Score,
    cGreenPlayer,
    cGreenScore,
  ];

  // Row colors:
  // - Red rowIndex 2 is red-ish
  // - Blue rows 3 and 4 are blue-ish
  // - Green row 5 is green-ish
  const rowColors: RowColor[] = [
    { rowIndex: 2, r: 220, g: 30, b: 30 },   // Red
    { rowIndex: 3, r: 30, g: 30, b: 220 },   // Blue
    { rowIndex: 4, r: 35, g: 35, b: 210 },   // Blue-ish, same team as row 3
    { rowIndex: 5, r: 30, g: 220, b: 30 },   // Green
  ];

  const rows = processScoreboardImage(blocks, rowColors);
  t.same(rows.length, 4, 'should produce 4 player rows');

  const red = rows.find((r) => r.player === 'RedGuy') as CsvRow;
  const blue1 = rows.find((r) => r.player === 'BlueOne') as CsvRow;
  const blue2 = rows.find((r) => r.player === 'BlueTwo') as CsvRow;
  const green = rows.find((r) => r.player === 'GreenGuy') as CsvRow;

  t.equal(red.team, 'Red', 'RedGuy should be on Red team');
  t.equal(green.team, 'Green', 'GreenGuy should be on Green team');

  t.equal(
    blue1.team,
    blue2.team,
    'BlueOne and BlueTwo should share the same team name',
  );
  t.equal(
    blue1.team,
    'Blue',
    'Blue team should be labeled as Blue per MCC color legend',
  );

  t.equal(red.win, 1, 'RedGuy (rowIndex 2) should be winner (top row)');
  t.equal(red.loss, 0, 'RedGuy should not have a loss');

  t.equal(blue1.win, 0, 'BlueOne should not be the winning team');
  t.equal(blue2.win, 0, 'BlueTwo should not be the winning team');
  t.equal(green.win, 0, 'GreenGuy should not be the winning team');

  t.end();
});

/**
 * Test 4:
 * Non-player rows should be filtered out.
 *
 * - We add a fake "Total" row with non-numeric score/kills.
 * - Only player rows with numeric score or kills should be returned.
 */
t.test('processScoreboardImage: filters out non-player rows', (t) => {
  const wPlayer = word('np-w-player', 'PLAYERS');
  const wScore = word('np-w-score', 'SCORE');

  const wP1 = word('np-w-p1', 'RealPlayer');
  const wP1Score = word('np-w-p1-score', '10');

  const wTotal = word('np-w-total', 'Total');
  const wTotalScore = word('np-w-total-score', 'N/A'); // not numeric

  const cHeaderPlayer = cell('np-c-header-player', 1, 1, 'np-w-player');
  const cHeaderScore = cell('np-c-header-score', 1, 2, 'np-w-score');

  const cP1Player = cell('np-c-p1-player', 2, 1, 'np-w-p1');
  const cP1Score = cell('np-c-p1-score', 2, 2, 'np-w-p1-score');

  const cTotalPlayer = cell('np-c-total-player', 3, 1, 'np-w-total');
  const cTotalScore = cell('np-c-total-score', 3, 2, 'np-w-total-score');

  const tbl = table('np-tbl', [
    cHeaderPlayer.Id!,
    cHeaderScore.Id!,
    cP1Player.Id!,
    cP1Score.Id!,
    cTotalPlayer.Id!,
    cTotalScore.Id!,
  ]);

  const blocks: TextractBlockLite[] = [
    tbl,
    wPlayer,
    wScore,
    wP1,
    wP1Score,
    wTotal,
    wTotalScore,
    cHeaderPlayer,
    cHeaderScore,
    cP1Player,
    cP1Score,
    cTotalPlayer,
    cTotalScore,
  ];

  // All rows same color => FFA, but we only care that "Total" is filtered out.
  const rowColors: RowColor[] = [
    { rowIndex: 2, r: 100, g: 100, b: 100 },
    { rowIndex: 3, r: 100, g: 100, b: 100 },
  ];

  const rows = processScoreboardImage(blocks, rowColors);
  t.same(rows.length, 1, 'should only contain the real player row');

  const p = rows[0];
  t.equal(p.player, 'RealPlayer', 'only RealPlayer row should remain');

  t.end();
});

/**
 * Test 5:
 * Header fallback logic.
 *
 * - We simulate a situation where Textract mis-reads header texts (e.g. "P1", "P2").
 * - In that case, processScoreboardImage falls back to assuming:
 *     col 1 => Player, col 2 => Score, col 3 => Kills, col 4 => Assists, col 5 => Deaths.
 * - We verify that stats still go into the correct fields.
 */
t.test('processScoreboardImage: header fallback when headers are not clearly recognized', (t) => {
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

  // Single row, but color doesn't matter here; use any values.
  const rowColors: RowColor[] = [{ rowIndex: 2, r: 150, g: 150, b: 150 }];

  const rows = processScoreboardImage(blocks, rowColors);
  t.same(rows.length, 1, 'should produce exactly 1 row');

  const row = rows[0];
  t.equal(row.player, 'MysteryPlayer', 'player name should be mapped from col 1');
  t.equal(row.score, '30', 'score should be mapped from col 2');
  t.equal(row.kills, '25', 'kills should be mapped from col 3');
  t.equal(row.assists, '5', 'assists should be mapped from col 4');
  t.equal(row.deaths, '8', 'deaths should be mapped from col 5');

  t.end();
});
