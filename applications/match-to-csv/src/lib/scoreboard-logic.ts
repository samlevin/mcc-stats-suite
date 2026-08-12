// scoreboardLogic.ts
//
// This file contains the "brain" of your MCC parser.
// It does NOT talk to AWS, S3, Rekognition, Textract, or sharp.
// It is pure logic that can be unit-tested easily.
//
// It takes:
//   - Textract-style blocks from an image containing a scoreboard
//   - Per-row background colors (average RGB per row)
// and returns:
//   - A list of CsvRow objects:
//       Team, Player, Score, Kills, Assists, Deaths, Win, Loss
//
// It supports:
//   - Arbitrary team sizes (1v3v2, 4v3, etc.)
//   - MCC official team colors (Red/Blue/Green/Orange/Gold/Purple/Brown/Pink)
//   - Free-for-all (FFA) matches where Team is empty.

//////////////////////
// Public Interfaces //
//////////////////////

/**
 * Minimal version of a Textract Block that the pure logic needs.
 * We keep only the fields that matter for table layout and text.
 */
export interface TextractRelationship {
  Type?: string;
  Ids?: string[];
}

export interface TextractGeometryBox {
  Top?: number; // normalized 0–1
  Height?: number; // normalized 0–1
}

export interface TextractGeometry {
  BoundingBox?: TextractGeometryBox;
}

export interface TextractBlockLite {
  Id?: string;
  BlockType?: string; // "TABLE", "CELL", "WORD", etc.
  Text?: string; // For WORD blocks
  RowIndex?: number; // For CELL blocks
  ColumnIndex?: number; // For CELL blocks
  Geometry?: TextractGeometry;
  Relationships?: TextractRelationship[];
}

/**
 * Final row we will write to the CSV.
 */
export type { CsvRow } from '@mcc/contracts';
import type { CsvRow } from '@mcc/contracts';

/**
 * Average background color for one table row.
 *
 * The extraction Lambda computes this by sampling a horizontal band across
 * each row's background.
 */
export interface RowColor {
  rowIndex: number; // Textract RowIndex
  r: number; // average red 0–255
  g: number; // average green 0–255
  b: number; // average blue 0–255
}

/////////////////////////
// Internal Structures //
/////////////////////////

interface ColumnMapping {
  player?: number;
  score?: number;
  kills?: number;
  assists?: number;
  deaths?: number;
}

/**
 * Intermediate representation of a player row before we add team and win/loss.
 */
interface PlayerRow {
  rowIndex: number;
  player: string;
  score?: string;
  kills?: string;
  assists?: string;
  deaths?: string;
}

/**
 * Cluster of rows that share similar background color.
 * Each cluster becomes one MCC team.
 */
interface TeamCluster {
  name: string; // MCC color name, e.g. "Red"
  r: number; // mean R of the cluster
  g: number; // mean G of the cluster
  b: number; // mean B of the cluster
  rows: number[]; // RowIndex[] in this cluster
}

/**
 * If the RGB distance between two rows is smaller than this,
 * we treat them as the same team color.
 */
const COLOR_CLUSTER_THRESHOLD = 40;

///////////////////////////
/// Main public function //
///////////////////////////

/**
 * Convert Textract blocks + row background colors into CsvRow[].
 *
 * @param blocks    Textract-like blocks from an image containing a scoreboard.
 * @param rowColors For each table row, the average background RGB.
 *
 * @returns A list of CsvRow objects ready to write to CSV.
 */
export function processScoreboardImage(
  blocks: TextractBlockLite[],
  rowColors: RowColor[],
): CsvRow[] {
  if (!blocks.length) return [];

  // Map Id -> Block for quick lookup.
  const blockMap = new Map<string, TextractBlockLite>();
  for (const b of blocks) {
    if (b.Id) blockMap.set(b.Id, b);
  }

  // 1) Find the TABLE block that most closely resembles the scoreboard.
  const table = blocks
    .filter((block) => block.BlockType === 'TABLE')
    .sort(
      (left, right) =>
        tableHeaderScore(right, blockMap) - tableHeaderScore(left, blockMap),
    )[0];
  if (!table || !table.Relationships) {
    // No table found => nothing to parse.
    return [];
  }

  // 2) Gather CELL blocks that are children of the TABLE.
  const cellBlocks: TextractBlockLite[] = [];
  for (const rel of table.Relationships ?? []) {
    if (rel.Type !== 'CHILD') continue;
    for (const id of rel.Ids ?? []) {
      const child = blockMap.get(id);
      if (child?.BlockType === 'CELL') cellBlocks.push(child);
    }
  }

  // 3) Build a 2D map: tableByRow[rowIndex][columnIndex] = text.
  const tableByRow: Map<number, Map<number, string>> = new Map();

  for (const cell of cellBlocks) {
    const rowIndex = cell.RowIndex!;
    const colIndex = cell.ColumnIndex!;
    const text = getCellText(cell, blockMap); // combine WORD children into cell text

    if (!tableByRow.has(rowIndex)) {
      tableByRow.set(rowIndex, new Map());
    }
    tableByRow.get(rowIndex)!.set(colIndex, text);
  }

  const rowIndices = Array.from(tableByRow.keys()).sort((a, b) => a - b);
  if (!rowIndices.length) return [];

  // 4) Use the first row as header to detect which column is Player/Score/etc.
  const headerRowIndex = rowIndices[0];
  const headerRow = tableByRow.get(headerRowIndex)!;

  const colMapping: ColumnMapping = {};
  for (const [col, headerText] of headerRow.entries()) {
    const norm = headerText.trim().toUpperCase();
    if (norm.includes('PLAYER')) colMapping.player = col;
    else if (norm === 'SCORE') colMapping.score = col;
    else if (norm === 'KILLS') colMapping.kills = col;
    else if (norm === 'ASSISTS') colMapping.assists = col;
    else if (norm === 'DEATHS') colMapping.deaths = col;
  }

  // If Textract mis-reads headers, fall back to the standard column order.
  const headerCols = Array.from(headerRow.keys()).sort((a, b) => a - b);
  if (!colMapping.player && headerCols.length >= 1)
    colMapping.player = headerCols[0];
  if (!colMapping.score && headerCols.length >= 2)
    colMapping.score = headerCols[1];
  if (!colMapping.kills && headerCols.length >= 3)
    colMapping.kills = headerCols[2];
  if (!colMapping.assists && headerCols.length >= 4)
    colMapping.assists = headerCols[3];
  if (!colMapping.deaths && headerCols.length >= 5)
    colMapping.deaths = headerCols[4];

  // 5) Build a list of PlayerRow entries (skip header row).
  const players: PlayerRow[] = [];

  for (const r of rowIndices.slice(1)) {
    const row = tableByRow.get(r)!;

    const rawPlayer = colMapping.player
      ? (row.get(colMapping.player) ?? '')
      : '';
    const player = tidyPlayerName(rawPlayer);
    if (!player) continue;

    const pr: PlayerRow = {
      rowIndex: r,
      player,
    };

    if (colMapping.score) pr.score = row.get(colMapping.score) ?? '';
    if (colMapping.kills) pr.kills = row.get(colMapping.kills) ?? '';
    if (colMapping.assists) pr.assists = row.get(colMapping.assists) ?? '';
    if (colMapping.deaths) pr.deaths = row.get(colMapping.deaths) ?? '';

    // Skip rows that clearly aren't player stats (no numeric score or kills).
    if (!isProbablyNumeric(pr.score) && !isProbablyNumeric(pr.kills)) {
      continue;
    }

    players.push(pr);
  }

  if (!players.length) return [];

  // 6) Use row background colors to assign team names (or FFA).
  const rowToTeam = assignTeamsByColor(rowColors, players);

  // If no row gets a team name, treat it as FFA.
  const anyTeamAssigned = Array.from(rowToTeam.values()).some((t) => !!t);
  const isFFA = !anyTeamAssigned;

  // The top row in the table is the winner.
  const topPlayerRow = players.reduce((a, b) =>
    a.rowIndex < b.rowIndex ? a : b,
  );

  let winningTeam: string | undefined;
  let winningRowIndex: number | undefined;

  if (isFFA) {
    winningRowIndex = topPlayerRow.rowIndex;
  } else {
    winningTeam = rowToTeam.get(topPlayerRow.rowIndex);
  }

  // 7) Build final CsvRow list with Win/Loss flags.
  const rows: CsvRow[] = [];

  for (const p of players) {
    const team = rowToTeam.get(p.rowIndex) ?? '';

    let win = 0;
    let loss = 0;

    if (isFFA) {
      // Free-for-all: only top row is winner.
      if (p.rowIndex === winningRowIndex) {
        win = 1;
        loss = 0;
      } else {
        win = 0;
        loss = 1;
      }
    } else {
      // Team game: all players on winningTeam get Win=1.
      const playerTeam = rowToTeam.get(p.rowIndex);
      if (playerTeam && playerTeam === winningTeam) {
        win = 1;
        loss = 0;
      } else {
        win = 0;
        loss = 1;
      }
    }

    rows.push({
      team,
      player: p.player,
      score: p.score ?? '',
      kills: p.kills ?? '',
      assists: p.assists ?? '',
      deaths: p.deaths ?? '',
      win,
      loss,
    });
  }

  return rows;
}

//////////////////////////////
// Helper functions (pure)  //
//////////////////////////////

/**
 * Get the text inside a CELL by joining all its child WORD texts.
 */
function getCellText(
  cell: TextractBlockLite,
  blockMap: Map<string, TextractBlockLite>,
): string {
  let text = '';
  for (const rel of cell.Relationships ?? []) {
    if (rel.Type !== 'CHILD') continue;
    for (const id of rel.Ids ?? []) {
      const child = blockMap.get(id);
      if (!child) continue;
      if (child.BlockType === 'WORD' && child.Text) {
        if (text) text += ' ';
        text += child.Text;
      }
    }
  }
  return text.trim();
}

function tableHeaderScore(
  table: TextractBlockLite,
  blockMap: Map<string, TextractBlockLite>,
): number {
  let score = 0;
  for (const relationship of table.Relationships ?? []) {
    if (relationship.Type !== 'CHILD') continue;
    for (const id of relationship.Ids ?? []) {
      const cell = blockMap.get(id);
      if (cell?.BlockType !== 'CELL' || cell.RowIndex !== 1) continue;
      const header = getCellText(cell, blockMap).trim().toUpperCase();
      if (header.includes('PLAYER')) score += 3;
      if (['SCORE', 'KILLS', 'ASSISTS', 'DEATHS'].includes(header)) score += 1;
    }
  }
  return score;
}

/**
 * Clean up the raw player name.
 * - Trim whitespace
 * - Remove clan tags like "[UNSC] "
 * - Replace multiple spaces with a single space
 */
function tidyPlayerName(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^\[[^\]]+]\s*/, '');
  return t.replace(/\s+/g, ' ');
}

/**
 * A simple check to see if a string looks like an integer.
 */
function isProbablyNumeric(val?: string): boolean {
  if (!val) return false;
  return /^\d+$/.test(val.trim());
}

/**
 * Use background colors to cluster rows into MCC teams.
 * - If only one cluster => treat as FFA and return undefined for all rows.
 * - Otherwise => name each cluster with an MCC color (Red/Blue/Green/etc.).
 */
function assignTeamsByColor(
  rowColors: RowColor[],
  players: PlayerRow[],
): Map<number, string | undefined> {
  const rowToTeam = new Map<number, string | undefined>();

  if (!rowColors.length) {
    // No color info => safest is to treat as FFA.
    for (const p of players) rowToTeam.set(p.rowIndex, undefined);
    return rowToTeam;
  }

  // Group rows into clusters based on RGB distance.
  const clusters: TeamCluster[] = [];

  for (const rc of rowColors) {
    let bestIdx = -1;
    let bestDist = Number.MAX_VALUE;

    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i];
      const dist = colorDistance(rc, c);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    if (bestIdx === -1 || bestDist > COLOR_CLUSTER_THRESHOLD) {
      // New team cluster.
      clusters.push({
        name: 'TEMP',
        r: rc.r,
        g: rc.g,
        b: rc.b,
        rows: [rc.rowIndex],
      });
    } else {
      // Add to existing cluster and update its average color.
      const c = clusters[bestIdx];
      c.rows.push(rc.rowIndex);
      const n = c.rows.length;
      c.r = (c.r * (n - 1) + rc.r) / n;
      c.g = (c.g * (n - 1) + rc.g) / n;
      c.b = (c.b * (n - 1) + rc.b) / n;
    }
  }

  // If we only have one color cluster, scoreboard looks like FFA.
  if (clusters.length <= 1) {
    for (const p of players) rowToTeam.set(p.rowIndex, undefined);
    return rowToTeam;
  }

  // Give each cluster an official MCC color name based on its hue.
  const nameCounts = new Map<string, number>();
  for (const c of clusters) {
    const baseName = getMccTeamColorName(c.r, c.g, c.b);
    const count = nameCounts.get(baseName) ?? 0;
    const name = count === 0 ? baseName : `${baseName} ${count + 1}`;
    nameCounts.set(baseName, count + 1);
    c.name = name;
  }

  // Map each rowIndex -> its team's name.
  for (const c of clusters) {
    for (const rowIndex of c.rows) {
      rowToTeam.set(rowIndex, c.name);
    }
  }

  return rowToTeam;
}

/**
 * Euclidean distance between two RGB colors.
 */
function colorDistance(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Map average RGB to one of the official MCC team colors:
 *   Red, Blue, Green, Orange, Gold, Purple, Brown, Pink
 *
 * This uses HSV hue plus some rules for brightness and saturation
 * so that small differences between screenshots still map
 * to the same color name.
 */
function getMccTeamColorName(r: number, g: number, b: number): string {
  const { h, s, v } = rgbToHsv(r, g, b);
  const hue = h * 360;
  const sat = s;
  const val = v;

  // Red
  if (hue >= 345 || hue < 10) return 'Red';

  // Brown = dark / desaturated orange-ish
  if (hue >= 10 && hue < 25 && (val < 0.55 || sat < 0.55)) return 'Brown';

  // Orange = bright and saturated
  if (hue >= 15 && hue < 35 && sat >= 0.45) return 'Orange';

  // Gold = bright yellow-ish
  if (hue >= 35 && hue < 60 && val >= 0.55) return 'Gold';

  // Green
  if (hue >= 95 && hue < 140) return 'Green';

  // Blue
  if (hue >= 200 && hue < 250) return 'Blue';

  // Purple
  if (hue >= 260 && hue < 290) return 'Purple';

  // Pink / Magenta
  if (hue >= 290 && hue < 345) return 'Pink';

  // Fallbacks / tie-breakers.
  if (val < 0.45 && sat < 0.45) return 'Brown';
  if (hue >= 55 && hue < 95) return 'Gold';

  // As a last resort, pick whichever MCC color is closest in hue.
  const candidates = [
    { name: 'Red', target: 0 },
    { name: 'Orange', target: 25 },
    { name: 'Gold', target: 50 },
    { name: 'Green', target: 120 },
    { name: 'Blue', target: 225 },
    { name: 'Purple', target: 275 },
    { name: 'Pink', target: 315 },
    { name: 'Brown', target: 20 },
  ];
  candidates.sort(
    (a, b) => hueDistance(hue, a.target) - hueDistance(hue, b.target),
  );
  return candidates[0].name;
}

/**
 * Small helper for circular hue distance on a color wheel.
 */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b);
  return Math.min(d, 360 - d);
}

/**
 * Convert RGB (0–255 each) to HSV (0–1 each).
 *
 * h is hue in range [0,1], representing [0°,360°]
 * s is saturation
 * v is value (brightness)
 */
function rgbToHsv(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;

  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) {
      h = ((gn - bn) / delta) % 6;
    } else if (max === gn) {
      h = (bn - rn) / delta + 2;
    } else {
      h = (rn - gn) / delta + 4;
    }
    h /= 6;
    if (h < 0) h += 1;
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;

  return { h, s, v };
}
