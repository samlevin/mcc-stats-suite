// Reduces a capture from scripts/capture-textract.ts to a parser fixture under
// test/fixtures, replacing real gamertags and clan tags with placeholders.
//
// Usage, from applications/match-to-csv:
//   npx tsx scripts/reduce-capture.ts --capture <file> --mapping <file> \
//     --name <fixture name> --output test/fixtures/<name>.fixture.json
//
// The capture and the mapping hold real gamertags and must stay outside the
// repository. The mapping is JSON:
//   {
//     "names":    { "<gamertag as Textract read it>": "<placeholder>" },
//     "clanTags": { "<clan tag as Textract read it, without brackets>": "<placeholder>" }
//   }
// List every spelling Textract produced. Give OCR variants of one gamertag a
// placeholder that varies the same way, so the fixture still shows the misread.
//
// Only WORD text in the data cells of each table's player column changes. Each
// key is replaced wherever it occurs in a cell, so characters Textract read
// around a name or clan tag, such as a bracket misread as `I`, stay as read.
// Blocks outside a TABLE (PAGE, LINE, and words that belong to no cell) are
// dropped, and polygons and page numbers are removed from geometry. Everything
// else is copied unchanged. When the output file exists, its `expectedRows`,
// `knownIssue`, and `misreads` are kept: expected rows are transcribed from
// the screenshot by hand, never generated.

import { CliHelp, cliError, defineCli, parseCli } from './cli';
import fs from 'node:fs';
import type {
  AnalyzeDocumentCommandOutput,
  Block,
} from '@aws-sdk/client-textract';
import type { RowColor } from '../src/lib/scoreboard-logic';
import { assertOutsideRepository } from './fixture-paths';

export interface PlaceholderMapping {
  names: Record<string, string>;
  clanTags: Record<string, string>;
}

export interface TextractCapture {
  rowColors: RowColor[];
  response: Pick<AnalyzeDocumentCommandOutput, 'Blocks'>;
}

export interface ReducedFixture {
  name: string;
  blocks: Block[];
  rowColors: RowColor[];
}

/**
 * Letters and digits Textract may read in place of a clan tag's brackets, and
 * how many of them may touch one clan-tag placeholder.
 */
const BRACKET_MISREADS = /^[IlLJ1]$/;
const MAX_BRACKET_MISREADS = 2;

export function reduceCapture(
  capture: TextractCapture,
  mapping: PlaceholderMapping,
  name: string,
): ReducedFixture {
  validateMapping(mapping);
  const blocks = capture.response.Blocks ?? [];
  const byId = new Map(
    blocks.flatMap((block) => (block.Id ? [[block.Id, block] as const] : [])),
  );
  const kept = tableBlockIds(blocks, byId);
  const replacements = playerWordReplacements(blocks, byId, mapping);

  const reduced = blocks
    .filter((block) => block.Id && kept.has(block.Id))
    .map((block) => {
      const copy = reduceBlock(block);
      const text = replacements.get(block.Id ?? '');
      if (text !== undefined) copy.Text = text;
      return copy;
    });

  const fixture = { name, blocks: reduced, rowColors: capture.rowColors };
  assertNoRealNames(fixture, mapping);
  return fixture;
}

/** Throws when any real name or clan tag in the mapping occurs in a fixture's text. */
export function assertNoRealNames(
  fixture: {
    blocks: Block[];
    expectedRows?: { player: string }[];
    misreads?: { expected: string; read: string }[];
  },
  mapping: PlaceholderMapping,
): void {
  const texts = [
    ...fixture.blocks.flatMap((block) => (block.Text ? [block.Text] : [])),
    ...(fixture.expectedRows ?? []).map((row) => row.player),
    ...(fixture.misreads ?? []).flatMap((misread) => [
      misread.expected,
      misread.read,
    ]),
  ].map((text) => text.toLowerCase());
  for (const needle of sensitiveNeedles(mapping)) {
    if (texts.some((text) => text.includes(needle))) {
      throw new Error(
        'A real gamertag or clan tag from the mapping remains in the fixture text',
      );
    }
  }
}

function validateMapping(mapping: PlaceholderMapping): void {
  const entries = [
    ...Object.entries(mapping.names ?? {}),
    ...Object.entries(mapping.clanTags ?? {}),
  ];
  if (entries.length === 0) throw new Error('The mapping has no entries');
  const needles = sensitiveNeedles(mapping);
  for (const [real, placeholder] of entries) {
    if (!real.trim() || !placeholder.trim()) {
      throw new Error('Mapping keys and placeholders must not be empty');
    }
    if (wordCount(real) !== wordCount(placeholder)) {
      throw new Error(
        `Placeholder "${placeholder}" must have the same word count as the text it replaces`,
      );
    }
    const lower = placeholder.toLowerCase();
    if (needles.some((needle) => lower.includes(needle))) {
      throw new Error(
        `Placeholder "${placeholder}" contains a real gamertag or clan tag`,
      );
    }
  }
}

/** Lowercased real names, clan tags, and their words that a fixture must not contain. */
function sensitiveNeedles(mapping: PlaceholderMapping): string[] {
  const reals = [
    ...Object.keys(mapping.names ?? {}),
    ...Object.keys(mapping.clanTags ?? {}),
  ];
  const needles = new Set<string>();
  for (const real of reals) {
    for (const candidate of [real, ...real.split(/\s+/)]) {
      if (candidate.length >= 3 && /\p{L}/u.test(candidate)) {
        needles.add(candidate.toLowerCase());
      }
    }
  }
  return [...needles];
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).length;
}

/** IDs of TABLE blocks and every block reachable from them. */
function tableBlockIds(blocks: Block[], byId: Map<string, Block>): Set<string> {
  const kept = new Set<string>();
  const pending = blocks.filter((block) => block.BlockType === 'TABLE');
  while (pending.length > 0) {
    const block = pending.pop()!;
    if (!block.Id || kept.has(block.Id)) continue;
    kept.add(block.Id);
    for (const relationship of block.Relationships ?? []) {
      for (const id of relationship.Ids ?? []) {
        const child = byId.get(id);
        if (child) pending.push(child);
      }
    }
  }
  return kept;
}

function reduceBlock(block: Block): Block {
  const copy: Block = { ...block };
  delete copy.Page;
  if (block.Geometry) {
    copy.Geometry = { BoundingBox: block.Geometry.BoundingBox };
  }
  return copy;
}

function childIds(block: Block, byId: Map<string, Block>): Block[] {
  return (block.Relationships ?? [])
    .filter((relationship) => relationship.Type === 'CHILD')
    .flatMap((relationship) => relationship.Ids ?? [])
    .flatMap((id) => {
      const child = byId.get(id);
      return child ? [child] : [];
    });
}

/** New text for each WORD in a player-column data cell, keyed by block ID. */
function playerWordReplacements(
  blocks: Block[],
  byId: Map<string, Block>,
  mapping: PlaceholderMapping,
): Map<string, string> {
  const replacements = new Map<string, string>();
  const replace = replacer(mapping);
  for (const table of blocks.filter((block) => block.BlockType === 'TABLE')) {
    const cells = childIds(table, byId).filter(
      (block) => block.BlockType === 'CELL',
    );
    if (cells.length === 0) continue;
    const headerRow = Math.min(...cells.map((cell) => cell.RowIndex ?? 0));
    const playerColumn = findPlayerColumn(cells, headerRow, byId);
    for (const cell of cells) {
      if (cell.ColumnIndex !== playerColumn) continue;
      if ((cell.RowIndex ?? 0) <= headerRow) continue;
      const words = childIds(cell, byId).filter(
        (block) => block.BlockType === 'WORD',
      );
      if (words.length === 0) continue;
      const replaced = replace(
        words.map((word) => word.Text ?? '').join(' '),
        cell.RowIndex ?? 0,
      );
      const replacedWords = replaced.split(' ');
      if (replacedWords.length !== words.length) {
        throw new Error(
          `Row ${cell.RowIndex}: replacement changed the cell's word count`,
        );
      }
      words.forEach((word, index) => {
        if (word.Id) replacements.set(word.Id, replacedWords[index]);
      });
    }
  }
  return replacements;
}

function findPlayerColumn(
  cells: Block[],
  headerRow: number,
  byId: Map<string, Block>,
): number {
  const header = cells.filter((cell) => cell.RowIndex === headerRow);
  const player = header.find((cell) =>
    childIds(cell, byId)
      .map((word) => word.Text ?? '')
      .join(' ')
      .toUpperCase()
      .includes('PLAYER'),
  );
  return (
    player?.ColumnIndex ??
    Math.min(...header.map((cell) => cell.ColumnIndex ?? 0))
  );
}

/**
 * Returns a function that replaces every mapped name and clan tag in a cell's
 * text and throws when letters or digits remain outside the placeholders.
 */
function replacer(
  mapping: PlaceholderMapping,
): (text: string, rowIndex: number) => string {
  const entries = [
    ...Object.entries(mapping.names ?? {}).map(([real, placeholder]) => ({
      real,
      placeholder,
      clan: false,
    })),
    ...Object.entries(mapping.clanTags ?? {}).map(([real, placeholder]) => ({
      real,
      placeholder,
      clan: true,
    })),
  ].sort((left, right) => right.real.length - left.real.length);
  const byReal = new Map(entries.map((entry) => [entry.real, entry]));
  const pattern = new RegExp(
    entries.map((entry) => escapeRegExp(entry.real)).join('|'),
    'g',
  );

  return (text, rowIndex) => {
    const pieces: { text: string; placeholder?: { clan: boolean } }[] = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const entry = byReal.get(match[0])!;
      pieces.push({ text: text.slice(last, match.index) });
      pieces.push({ text: entry.placeholder, placeholder: entry });
      last = match.index + match[0].length;
    }
    pieces.push({ text: text.slice(last) });
    assertOnlyMappedText(pieces, rowIndex);
    return pieces.map((piece) => piece.text).join('');
  };
}

/**
 * Letters and digits outside a placeholder mean a name the mapping does not
 * cover, except for up to two bracket misreads touching a clan-tag
 * placeholder.
 */
function assertOnlyMappedText(
  pieces: { text: string; placeholder?: { clan: boolean } }[],
  rowIndex: number,
): void {
  pieces.forEach((piece, index) => {
    if (piece.placeholder) return;
    const leftover = piece.text.split(' ');
    leftover.forEach((fragment, position) => {
      const unmapped = fragment.match(/[\p{L}\p{N}]/gu) ?? [];
      if (unmapped.length === 0) return;
      const touchesClan =
        (position === 0 && pieces[index - 1]?.placeholder?.clan) ||
        (position === leftover.length - 1 &&
          pieces[index + 1]?.placeholder?.clan);
      if (
        touchesClan &&
        unmapped.length <= MAX_BRACKET_MISREADS &&
        unmapped.every((character) => BRACKET_MISREADS.test(character))
      ) {
        return;
      }
      throw new Error(
        `Row ${rowIndex}: player cell text is not covered by the mapping; add every spelling Textract read`,
      );
    });
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CLI = defineCli(
  'Usage: reduce-capture.ts --capture <file> --mapping <file> --name <name> --output <file>',
  ['capture', 'mapping', 'name', 'output'],
);

function parseArguments(argv: string[]): Record<string, string> {
  const { options, positionals } = parseCli(argv, CLI);
  if (positionals.length) throw cliError(CLI, 'Unexpected positional argument');
  const result: Record<string, string> = {};
  for (const required of ['capture', 'mapping', 'name', 'output']) {
    const value = options[required];
    if (typeof value !== 'string' || !value)
      throw cliError(CLI, `Missing --${required}`);
    result[required] = value;
  }
  return result;
}

function main(argv: string[]): void {
  const options = parseArguments(argv);
  assertOutsideRepository(options.capture);
  assertOutsideRepository(options.mapping);
  const capture = JSON.parse(
    fs.readFileSync(options.capture, 'utf8'),
  ) as TextractCapture;
  const mapping = JSON.parse(
    fs.readFileSync(options.mapping, 'utf8'),
  ) as PlaceholderMapping;
  const reduced = reduceCapture(capture, mapping, options.name);

  const existing = fs.existsSync(options.output)
    ? (JSON.parse(fs.readFileSync(options.output, 'utf8')) as {
        expectedRows?: { player: string }[];
        knownIssue?: unknown;
        misreads?: { expected: string; read: string }[];
      })
    : {};
  const fixture = {
    ...reduced,
    expectedRows: existing.expectedRows ?? [],
    ...(existing.knownIssue ? { knownIssue: existing.knownIssue } : {}),
    ...(existing.misreads ? { misreads: existing.misreads } : {}),
  };
  assertNoRealNames(fixture, mapping);
  fs.writeFileSync(options.output, `${JSON.stringify(fixture, null, 2)}\n`);
  process.stdout.write(
    `${options.output}: ${reduced.blocks.length} blocks, ${reduced.rowColors.length} row colors\n`,
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliHelp) {
      process.stdout.write(`${error.message}\n`);
    } else {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exit(1);
    }
  }
}
