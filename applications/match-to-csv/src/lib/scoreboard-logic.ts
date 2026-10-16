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
//   - Why the list is empty, when the board's team layout is unsupported.
//
// It supports:
//   - Two-team boards only, with any number of players on each team.
//     A board whose player rows form one color cluster, carry no row color,
//     or form three or more clusters yields no rows.
//   - MCC official team colors (Red/Blue/Green/Orange/Gold/Purple/Brown/Pink)
//   - Review flags on player names Textract may have misread. Names always
//     stay as read; a flag only marks the row for a person to check.

//////////////////////
// Public Interfaces //
//////////////////////

/**
 * Minimal version of a Textract Block that the pure logic needs.
 * We keep only the fields that matter for table layout, text, and confidence.
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
  Confidence?: number; // Textract confidence, 0–100
  RowIndex?: number; // For CELL blocks
  ColumnIndex?: number; // For CELL blocks
  Geometry?: TextractGeometry;
  Relationships?: TextractRelationship[];
}

/**
 * Final row we will write to the CSV.
 */
export type { CsvRow, RowReviewFlag } from '@mcc/contracts';
import type { CsvRow, RowReviewFlag } from '@mcc/contracts';

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

/**
 * Why a board with player rows produced no rows. Only two-team boards are
 * supported, so a board whose player rows do not form exactly two color
 * clusters is rejected. `colorClusterCount` is 0 when no player row has a
 * color.
 */
export interface NoRowsReason {
  code: 'UNSUPPORTED_TEAM_LAYOUT';
  colorClusterCount: number;
}

/**
 * The parser's result: the CSV rows, plus the reason when an unsupported
 * team layout left them empty.
 */
export interface ScoreboardParseResult {
  rows: CsvRow[];
  noRowsReason?: NoRowsReason;
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
  reviewFlags: RowReviewFlag[];
}

/**
 * One WORD child of a cell.
 */
interface CellWord {
  text: string;
  confidence?: number;
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

/**
 * A gamertag word with a WORD confidence below this is flagged
 * `LOW_WORD_CONFIDENCE`. In the real Halo 3 captures, correctly read gamertag
 * words go as low as 52 and a misread went to 39, so the threshold sits
 * between them.
 */
const LOW_WORD_CONFIDENCE_BELOW = 50;

/**
 * A gamertag that ends in a digits-only word after a word ending in a letter
 * is flagged `SPLIT_TRAILING_DIGITS` when either word's confidence is below
 * this. Gamertags may contain spaces, so the split alone is no evidence of a
 * misread, but a real capture read `Player06` as `Player 06` at 55 and 88.
 */
const SPLIT_TRAILING_DIGITS_BELOW = 90;

///////////////////////////
/// Main public function //
///////////////////////////

/**
 * Convert Textract blocks + row background colors into CsvRow[].
 *
 * @param blocks    Textract-like blocks from an image containing a scoreboard.
 * @param rowColors For each table row, the average background RGB.
 *
 * @returns The CsvRow objects ready to write to CSV, and the reason they are
 *          empty when the board is not a two-team board.
 */
export function processScoreboardImage(
  blocks: TextractBlockLite[],
  rowColors: RowColor[],
): ScoreboardParseResult {
  if (!blocks.length) return { rows: [] };

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
    return { rows: [] };
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

  // 3) Build 2D maps: tableByRow[rowIndex][columnIndex] = text, and the
  //    same position's WORD children with their confidence.
  const tableByRow: Map<number, Map<number, string>> = new Map();
  const wordsByRow: Map<number, Map<number, CellWord[]>> = new Map();

  for (const cell of cellBlocks) {
    const rowIndex = cell.RowIndex!;
    const colIndex = cell.ColumnIndex!;
    const words = getCellWords(cell, blockMap);
    const text = joinWords(words); // combine WORD children into cell text

    if (!tableByRow.has(rowIndex)) {
      tableByRow.set(rowIndex, new Map());
      wordsByRow.set(rowIndex, new Map());
    }
    tableByRow.get(rowIndex)!.set(colIndex, text);
    wordsByRow.get(rowIndex)!.set(colIndex, words);
  }

  const rowIndices = Array.from(tableByRow.keys()).sort((a, b) => a - b);
  if (!rowIndices.length) return { rows: [] };

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

    const playerWords = colMapping.player
      ? (wordsByRow.get(r)!.get(colMapping.player) ?? [])
      : [];

    const pr: PlayerRow = {
      rowIndex: r,
      player,
      reviewFlags: playerReviewFlags(player, playerWords),
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

  if (!players.length) return { rows: [] };

  // 6) Use row background colors to assign team names. Only a board whose
  //    player rows form exactly two color clusters is supported.
  const { colorClusterCount, rowToTeam } = assignTeamsByColor(
    rowColors,
    players,
  );
  if (colorClusterCount !== 2) {
    return {
      rows: [],
      noRowsReason: { code: 'UNSUPPORTED_TEAM_LAYOUT', colorClusterCount },
    };
  }

  // The top row's team is the winning team.
  const topPlayerRow = players.reduce((a, b) =>
    a.rowIndex < b.rowIndex ? a : b,
  );
  const winningTeam = rowToTeam.get(topPlayerRow.rowIndex);

  // 7) Build final CsvRow list with Win/Loss flags. All players on the
  //    winning team get Win=1; everyone else gets Loss=1.
  const rows: CsvRow[] = [];

  for (const p of players) {
    const playerTeam = rowToTeam.get(p.rowIndex);
    const won = !!playerTeam && playerTeam === winningTeam;

    rows.push({
      team: playerTeam ?? '',
      player: p.player,
      score: p.score ?? '',
      kills: p.kills ?? '',
      assists: p.assists ?? '',
      deaths: p.deaths ?? '',
      win: won ? 1 : 0,
      loss: won ? 0 : 1,
      ...(p.reviewFlags.length ? { reviewFlags: p.reviewFlags } : {}),
    });
  }

  return { rows };
}

//////////////////////////////
// Helper functions (pure)  //
//////////////////////////////

/**
 * Get the WORD children of a CELL, in relationship order, with their text and
 * confidence.
 */
function getCellWords(
  cell: TextractBlockLite,
  blockMap: Map<string, TextractBlockLite>,
): CellWord[] {
  const words: CellWord[] = [];
  for (const rel of cell.Relationships ?? []) {
    if (rel.Type !== 'CHILD') continue;
    for (const id of rel.Ids ?? []) {
      const child = blockMap.get(id);
      if (!child) continue;
      if (child.BlockType === 'WORD' && child.Text) {
        words.push({ text: child.Text, confidence: child.Confidence });
      }
    }
  }
  return words;
}

/**
 * Join a cell's words into its text, separated by spaces.
 */
function joinWords(words: CellWord[]): string {
  return words
    .map((word) => word.text)
    .join(' ')
    .trim();
}

/**
 * Get the text inside a CELL by joining all its child WORD texts.
 */
function getCellText(
  cell: TextractBlockLite,
  blockMap: Map<string, TextractBlockLite>,
): string {
  return joinWords(getCellWords(cell, blockMap));
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
 * - Drop words with no letter, digit, or clan-tag bracket. Gamertags hold
 *   only letters, digits, and spaces, so such a word is an icon Textract read
 *   as text, like the chat bubble MCC draws over the player column as "...".
 * - Remove clan tags like "[UNSC] "
 * - Replace multiple spaces with a single space
 */
function tidyPlayerName(raw: string): string {
  const t = raw.trim().split(/\s+/).filter(isNameWord).join(' ');
  return t.replace(/^\[[^\]]+]\s*/, '');
}

/**
 * Whether a word survives tidyPlayerName's icon filter.
 */
function isNameWord(word: string): boolean {
  return /[\p{L}\p{N}[\]]/u.test(word);
}

/**
 * Flag a tidied player name that Textract may have misread. The name itself
 * is never changed.
 *
 * The name's words are the last words of the cell after the icon filter,
 * as many as the tidied name holds, so a clan tag's words never count.
 * Words without a confidence are skipped, and a name with no known
 * confidence gets no flags.
 */
function playerReviewFlags(
  player: string,
  cellWords: CellWord[],
): RowReviewFlag[] {
  const words = cellWords
    .flatMap((word) =>
      word.text
        .trim()
        .split(/\s+/)
        .map((text) => ({ text, confidence: word.confidence })),
    )
    .filter((word) => isNameWord(word.text));
  const nameWords = words.slice(-player.split(' ').length);
  const flags: RowReviewFlag[] = [];

  const lowest = lowestConfidence(nameWords);
  if (lowest !== undefined && lowest < LOW_WORD_CONFIDENCE_BELOW) {
    flags.push({
      field: 'player',
      code: 'LOW_WORD_CONFIDENCE',
      wordConfidence: lowest,
    });
  }

  const [before, last] = nameWords.slice(-2);
  if (
    nameWords.length >= 2 &&
    /^\d+$/.test(last.text) &&
    /\p{L}$/u.test(before.text)
  ) {
    const split = lowestConfidence([before, last]);
    if (split !== undefined && split < SPLIT_TRAILING_DIGITS_BELOW) {
      flags.push({
        field: 'player',
        code: 'SPLIT_TRAILING_DIGITS',
        wordConfidence: split,
      });
    }
  }

  return flags;
}

/**
 * The lowest known confidence among the words, or undefined when none is
 * known.
 */
function lowestConfidence(words: CellWord[]): number | undefined {
  const known = words.flatMap((word) =>
    word.confidence === undefined ? [] : [word.confidence],
  );
  return known.length ? Math.min(...known) : undefined;
}

/**
 * A simple check to see if a string looks like an integer.
 */
function isProbablyNumeric(val?: string): boolean {
  if (!val) return false;
  return /^\d+$/.test(val.trim());
}

/**
 * Use background colors to cluster player rows into MCC teams.
 * - Returns how many color clusters the player rows form; 0 when no player
 *   row has a color.
 * - Names each cluster with an MCC color (Red/Blue/Green/etc.) and maps each
 *   clustered row to its team. A player row without a color has no team.
 */
function assignTeamsByColor(
  rowColors: RowColor[],
  players: PlayerRow[],
): { colorClusterCount: number; rowToTeam: Map<number, string> } {
  const rowToTeam = new Map<number, string>();

  // Cluster only the colors of rows that parsed as players. The header row
  // and filtered non-player rows are usually shaded differently and would
  // otherwise form their own cluster and turn a one-color board into a
  // two-team board.
  const playerRowIndices = new Set(players.map((p) => p.rowIndex));
  const playerColors = rowColors.filter((rc) =>
    playerRowIndices.has(rc.rowIndex),
  );

  // Group rows into clusters based on RGB distance.
  const clusters: TeamCluster[] = [];

  for (const rc of playerColors) {
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

  return { colorClusterCount: clusters.length, rowToTeam };
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
