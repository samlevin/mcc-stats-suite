import type { CsvRow } from '@mcc/contracts';

/**
 * Renders rows as the quoted CSV of spec 1.1 §8.6 and spec 1.2 §7.6. `Player`
 * holds the roster gamertag for `EXACT` and `RESOLVED` rows and the name as
 * read otherwise. `PlayerMatch` holds the match status, and is empty for a row
 * without a `playerResolution`.
 */
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
    'PlayerMatch',
  ];
  const lines = [header.map(csvEscape).join(',')];

  for (const row of rows) {
    lines.push(
      [
        row.team,
        csvPlayer(row),
        row.score,
        row.kills,
        row.assists,
        row.deaths,
        row.win,
        row.loss,
        row.playerResolution?.status ?? '',
      ]
        .map(csvEscape)
        .join(','),
    );
  }

  return `${lines.join('\n')}\n`;
}

function csvPlayer(row: CsvRow): string {
  const resolution = row.playerResolution;
  if (resolution && resolution.status !== 'UNMATCHED' && resolution.gamertag) {
    return resolution.gamertag;
  }
  return row.player;
}

function csvEscape(value: string | number): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}
