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

/**
 * Renders one roster player's rows in the legacy spreadsheet format of spec
 * 1.1 §8.6.1: no header, and one `Date,Kills,Assists,Deaths,Win,Loss` line per
 * row. `Win` and `Loss` hold `1` or nothing. A value is quoted only when it
 * holds a comma, a quote or a line break, so a line of digits pastes as is.
 */
export function rowsToGamertagCsv(matchDate: string, rows: CsvRow[]): string {
  const date = exportDate(matchDate);
  return rows
    .map(
      (row) =>
        [
          date,
          row.kills,
          row.assists,
          row.deaths,
          row.win === 1 ? '1' : '',
          row.loss === 1 ? '1' : '',
        ]
          .map(minimalCsvEscape)
          .join(',') + '\n',
    )
    .join('');
}

/** Renders a `YYYY-MM-DD` match date as `M/D/YYYY` without leading zeros. */
export function exportDate(matchDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(matchDate);
  if (!match) {
    throw new Error('Match date is not YYYY-MM-DD');
  }
  const [, year, month, day] = match;
  return `${Number(month)}/${Number(day)}/${year}`;
}

function minimalCsvEscape(value: string): string {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
