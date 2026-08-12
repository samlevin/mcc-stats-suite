import t from 'tap';
import { rowsToCsv } from '../src/lib/csv';

t.test('CSV output quotes commas, quotes, and numeric flags', (t) => {
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
  t.match(csv, /"Player, ""One"""/);
  t.match(csv, /"1","0"/);
  t.ok(csv.endsWith('\n'));
  t.end();
});
