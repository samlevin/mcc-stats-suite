import type { CsvRow } from '@mcc/contracts';

export function rowsToCsv(rows: CsvRow[]): string {
  const header = [
    'Team',
    'Player',
    'Score',
    'Kills',
    'Assists',
    'Deaths',
    'Win',
    'Loss',
  ];
  const lines = [header.map(csvEscape).join(',')];

  for (const row of rows) {
    lines.push(
      [
        row.team,
        row.player,
        row.score,
        row.kills,
        row.assists,
        row.deaths,
        row.win,
        row.loss,
      ]
        .map(csvEscape)
        .join(','),
    );
  }

  return `${lines.join('\n')}\n`;
}

function csvEscape(value: string | number): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}
