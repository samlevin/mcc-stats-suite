import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rowsToCsv } from '../src/lib/csv';

test('CSV output quotes commas, quotes, and numeric flags', () => {
  const csv = rowsToCsv([
    {
      team: 'Blue',
      player: 'Player, "One"',
      score: '19',
      kills: '10',
      assists: '4',
      deaths: '2',
      win: 1,
      loss: 0,
    },
  ]);
  assert.match(csv, /"Player, ""One"""/);
  assert.match(csv, /"1","0"/);
  assert.ok(csv.endsWith('\n'));
});
