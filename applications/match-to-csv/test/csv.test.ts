import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CsvRow, PlayerResolution } from '@mcc/contracts';
import { rowsToCsv } from '../src/lib/csv';

const row: CsvRow = {
  team: 'Blue',
  player: 'Player 06',
  score: '19',
  kills: '10',
  assists: '4',
  deaths: '2',
  win: 1,
  loss: 0,
};

function resolution(
  status: PlayerResolution['status'],
  gamertag: string | null,
): PlayerResolution {
  return {
    status,
    asRead: row.player,
    gamertagId: gamertag ? 'entry-1' : null,
    gamertag,
    keyDistance: status === 'UNMATCHED' ? null : 0,
    runnerUpDistance: null,
    textDistance: gamertag ? 1 : null,
    errorTypes: status === 'RESOLVED' ? ['EXTRA_CHARACTERS'] : [],
    unmatchedReason: status === 'UNMATCHED' ? 'NO_CANDIDATE' : null,
  };
}

function lines(csv: string): string[] {
  assert.ok(csv.endsWith('\n'));
  return csv.slice(0, -1).split('\n');
}

test('CSV header ends with the PlayerMatch column', () => {
  assert.deepEqual(lines(rowsToCsv([])), [
    '"Team","Player","Score","Kills","Assists","Deaths","Win","Loss","PlayerMatch"',
  ]);
});

test('CSV Player and PlayerMatch follow the player resolution of each row', () => {
  const csv = rowsToCsv([
    {
      ...row,
      player: 'Player05',
      playerResolution: {
        ...resolution('EXACT', 'Player05'),
        asRead: 'Player05',
        textDistance: 0,
      },
    },
    { ...row, playerResolution: resolution('RESOLVED', 'Player06') },
    {
      ...row,
      player: 'Stranger',
      playerResolution: {
        ...resolution('UNMATCHED', null),
        asRead: 'Stranger',
      },
    },
    { ...row, player: 'Before Roster' },
  ]);

  assert.deepEqual(lines(csv).slice(1), [
    '"Blue","Player05","19","10","4","2","1","0","EXACT"',
    '"Blue","Player06","19","10","4","2","1","0","RESOLVED"',
    '"Blue","Stranger","19","10","4","2","1","0","UNMATCHED"',
    '"Blue","Before Roster","19","10","4","2","1","0",""',
  ]);
  // A resolved row's name as read stays out of the CSV.
  assert.ok(!csv.includes('Player 06'));
});

test('CSV leaves out review flags', () => {
  const csv = rowsToCsv([
    {
      ...row,
      reviewFlags: [
        { field: 'player', code: 'LOW_WORD_CONFIDENCE', wordConfidence: 12 },
      ],
    },
  ]);
  assert.ok(!csv.includes('LOW_WORD_CONFIDENCE'));
});

test('CSV output quotes commas, quotes, and numeric flags', () => {
  const csv = rowsToCsv([
    {
      ...row,
      player: 'Player, "One"',
      playerResolution: {
        ...resolution('RESOLVED', 'Roster, "One"'),
        asRead: 'Player, "One"',
      },
    },
  ]);
  assert.match(csv, /"Roster, ""One"""/);
  assert.match(csv, /"1","0","RESOLVED"\n$/);
});
