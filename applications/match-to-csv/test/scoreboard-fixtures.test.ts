import fs from 'fs';
import path from 'path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Block } from '@aws-sdk/client-textract';
import type {
  CellErrorType,
  ExtractTextOutput,
  PlayerResolution,
  RosterEntry,
} from '@mcc/contracts';
import { runExtraction } from '../src/lambdas/extract-text';
import {
  processScoreboardImage,
  type TextractBlockLite,
  type RowColor,
  type CsvRow,
  type RowReviewFlag,
} from '../src/lib/scoreboard-logic';

interface ScoreboardFixture {
  name: string;
  blocks: TextractBlockLite[];
  rowColors: RowColor[];
  expectedRows: CsvRow[];
  /**
   * A tracked mismatch between the parser and the screenshot: the listed
   * fields are compared in a todo test, every other field must match.
   */
  knownIssue?: { issue: string; fields: (keyof CsvRow)[] };
  /**
   * OCR misreads the parser keeps as read and flags for review. The expected
   * row whose `field` the screenshot shows as `expected` must come out as
   * `read`, and that expected row must carry a review flag on the field.
   */
  misreads?: {
    field: RowReviewFlag['field'];
    expected: string;
    read: string;
  }[];
}

/** The placeholder roster of the halo3 captures' 14 distinct gamertags. */
interface RosterFixture {
  name: string;
  entries: RosterEntry[];
}

const fixturesDir = path.join(__dirname, 'fixtures');
const rosterFile = 'roster.fixture.json';
const fixtureFiles = fs
  .readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.fixture.json') && f !== rosterFile)
  .sort();
const placeholderRoster = (
  JSON.parse(
    fs.readFileSync(path.join(fixturesDir, rosterFile), 'utf8'),
  ) as RosterFixture
).entries;

function readFixture(file: string): ScoreboardFixture {
  return JSON.parse(
    fs.readFileSync(path.join(fixturesDir, file), 'utf8'),
  ) as ScoreboardFixture;
}

test('scoreboard fixtures: directory has at least one fixture', () => {
  assert.ok(
    fixtureFiles.length > 0,
    'expected one or more *.fixture.json files',
  );
});

/**
 * The expected rows with each misread value replaced by the text Textract
 * read, after checking that the fixture flags every misread row.
 */
function asRead(fixture: ScoreboardFixture, file: string): CsvRow[] {
  const rows = fixture.expectedRows.map((row) => ({ ...row }));
  for (const misread of fixture.misreads ?? []) {
    const matches = rows.filter(
      (row) => row[misread.field] === misread.expected,
    );
    assert.equal(
      matches.length,
      1,
      `${file}: misread "${misread.expected}" must match one expected row`,
    );
    assert.ok(
      matches[0].reviewFlags?.some((flag) => flag.field === misread.field),
      `${file}: misread "${misread.expected}" must be flagged for review`,
    );
    matches[0][misread.field] = misread.read;
  }
  return rows;
}

function without(rows: CsvRow[], fields: (keyof CsvRow)[]) {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).filter(
        ([field]) => !fields.includes(field as keyof CsvRow),
      ),
    ),
  );
}

for (const file of fixtureFiles) {
  const fixture = readFixture(file);
  const run = () =>
    processScoreboardImage(fixture.blocks, fixture.rowColors).rows;
  const known = fixture.knownIssue;

  if (!known) {
    test(`scoreboard fixture: ${fixture.name}`, () => {
      assert.deepEqual(
        run(),
        asRead(fixture, file),
        `${file} should match expected rows`,
      );
    });
    continue;
  }

  test(`scoreboard fixture: ${fixture.name}, except ${known.fields.join(', ')}`, () => {
    assert.ok(known.issue && known.fields.length > 0, `${file} knownIssue`);
    assert.deepEqual(
      without(run(), known.fields),
      without(asRead(fixture, file), known.fields),
      `${file} should match expected rows outside ${known.fields.join(', ')}`,
    );
  });
  test(
    `scoreboard fixture: ${fixture.name}`,
    { todo: `known mismatch, ${known.issue}` },
    () => {
      assert.deepEqual(run(), asRead(fixture, file));
    },
  );
}

interface ExtractedFixture {
  result: ExtractTextOutput;
  parserRows: CsvRow[];
  observedTexts: string[];
  manifest: { versions: Record<string, string> };
  completion: {
    metrics: {
      playerMatchCounts: { exact: number; resolved: number; unmatched: number };
    };
  };
}

/** Runs one fixture through `runExtraction` against the given roster entries. */
async function extractFixture(
  fixture: ScoreboardFixture,
  entries: RosterEntry[],
): Promise<ExtractedFixture> {
  const image = Buffer.from(fixture.name);
  const writes: Array<{ key: string; value: unknown }> = [];
  let id = 0;
  const result = await runExtraction(
    {
      source: {
        screenshotId: 'screen-1',
        submissionId: 'submission-1',
        bucket: 'evidence',
        key: 'submissions/submission-1/screenshots/screen-1/source/original',
        attachmentName: 'scoreboard.png',
        contentType: 'image/png',
        sha256: createHash('sha256').update(image).digest('hex'),
        acquisitionType: 'SCREENSHOT',
        widthPx: 1920,
        heightPx: 1080,
      },
    },
    {
      getImage: async () => image,
      inspectImage: async () => ({ format: 'png', width: 1920, height: 1080 }),
      analyze: async () => ({
        $metadata: {},
        Blocks: fixture.blocks as unknown as Block[],
      }),
      calculateRowColors: async () => fixture.rowColors,
      writeJson: async (bucket, key, value) => {
        writes.push({ key, value });
        return { bucket, key };
      },
      publishExtractionMetrics() {},
      readRoster: async () => ({
        reference: {
          namespace: 'stable',
          rosterVersion: entries.length,
          rosterSha256: 'a'.repeat(64),
          snapshot: {
            bucket: 'evidence',
            key: `roster/versions/${String(entries.length).padStart(10, '0')}.json`,
          },
        },
        entries,
      }),
      id: () => `id-${++id}`,
      timestamp: () => '2026-01-01T00:00:00.000Z',
      clockMs: () => 0,
      build: { gitSha: 'commit-sha', environment: 'TEST' },
    },
  );
  const written = (suffix: string) =>
    writes.find((write) => write.key.endsWith(suffix))?.value;
  const observations = written('/normalized/observations.json') as {
    parser: { rows: CsvRow[] };
    cells: { observedText: string }[];
  };
  return {
    result,
    parserRows: observations.parser.rows,
    observedTexts: observations.cells.map((cell) => cell.observedText),
    manifest: written('/manifest.json') as ExtractedFixture['manifest'],
    completion: written('/completion.json') as ExtractedFixture['completion'],
  };
}

function withoutResolution(rows: CsvRow[]): CsvRow[] {
  return rows.map((row) => {
    const copy = { ...row };
    delete copy.playerResolution;
    return copy;
  });
}

function exact(entry: RosterEntry, runnerUpDistance: number) {
  return {
    status: 'EXACT',
    asRead: entry.gamertag,
    gamertagId: entry.gamertagId,
    gamertag: entry.gamertag,
    keyDistance: 0,
    runnerUpDistance,
    textDistance: 0,
    errorTypes: [],
    unmatchedReason: null,
  } satisfies PlayerResolution;
}

function rosterEntry(gamertag: string): RosterEntry {
  const entry = placeholderRoster.find((item) => item.gamertag === gamertag);
  assert.ok(entry, `${rosterFile} holds ${gamertag}`);
  return entry;
}

test('roster fixture: 14 placeholder gamertags with 14 distinct gamertag IDs', () => {
  assert.equal(placeholderRoster.length, 14);
  assert.equal(
    new Set(placeholderRoster.map((entry) => entry.gamertagId)).size,
    14,
  );
  assert.equal(
    new Set(placeholderRoster.map((entry) => entry.gamertag)).size,
    14,
  );
});

for (const file of fixtureFiles) {
  const fixture = readFixture(file);
  test(`roster resolution keeps every value as read: ${fixture.name}`, async () => {
    const withRoster = await extractFixture(fixture, placeholderRoster);
    const withoutRoster = await extractFixture(fixture, []);
    const parsed = processScoreboardImage(
      fixture.blocks,
      fixture.rowColors,
    ).rows;

    // Names and review flags in `parser.rows` stay as the parser read them.
    assert.deepEqual(withoutResolution(withRoster.parserRows), parsed);
    assert.deepEqual(withoutResolution(withoutRoster.parserRows), parsed);
    // Every row records a resolution of its own name as read.
    assert.deepEqual(
      withRoster.parserRows.map((row) => row.playerResolution?.asRead),
      parsed.map((row) => row.player),
    );
    // Cell text does not depend on the roster.
    assert.deepEqual(withRoster.observedTexts, withoutRoster.observedTexts);
    // The output rows carry no resolution, so no roster gamertag enters
    // workflow state.
    assert.deepEqual(withRoster.result.rows, parsed);
    assert.ok(
      withRoster.result.rows.every((row) => !('playerResolution' in row)),
    );
    assert.equal(
      withRoster.manifest.versions.rosterMatcherVersion,
      'roster-matcher-v1',
    );
  });
}

test('roster resolution: halo3 two-team capture 1 matches all 8 names exactly', async () => {
  const run = await extractFixture(
    readFixture('halo3-two-team-capture-1.fixture.json'),
    placeholderRoster,
  );
  assert.deepEqual(
    run.parserRows.map((row) => row.playerResolution),
    [
      'Player01 A',
      'Player02',
      'Player03',
      'Player04',
      'Player05',
      'Player06',
      'Player07',
      'Player08',
    ].map((gamertag) =>
      exact(rosterEntry(gamertag), gamertag === 'Player01 A' ? 2 : 1),
    ),
  );
  assert.deepEqual(run.completion.metrics.playerMatchCounts, {
    exact: 8,
    resolved: 0,
    unmatched: 0,
  });
});

test('roster resolution: halo3 two-team capture 2 resolves both misreads', async () => {
  const run = await extractFixture(
    readFixture('halo3-two-team-capture-2.fixture.json'),
    placeholderRoster,
  );
  const resolved = (
    asRead: string,
    gamertag: string,
    errorType: CellErrorType,
  ): PlayerResolution => ({
    status: 'RESOLVED',
    asRead,
    gamertagId: rosterEntry(gamertag).gamertagId,
    gamertag,
    keyDistance: 0,
    runnerUpDistance: 1,
    textDistance: 1,
    errorTypes: [errorType],
    unmatchedReason: null,
  });
  assert.deepEqual(
    run.parserRows.map((row) => row.playerResolution),
    [
      exact(rosterEntry('Player09'), 1),
      resolved('PIayer05', 'Player05', 'GLYPH_SUBSTITUTION'),
      exact(rosterEntry('Player10 B C'), 2),
      resolved('Player 06', 'Player06', 'EXTRA_CHARACTERS'),
      exact(rosterEntry('Player11'), 1),
      exact(rosterEntry('Player12'), 1),
      exact(rosterEntry('Player13'), 1),
      exact(rosterEntry('Player14'), 1),
    ],
  );
  assert.deepEqual(run.completion.metrics.playerMatchCounts, {
    exact: 6,
    resolved: 2,
    unmatched: 0,
  });
});

test('roster resolution: PIayer05 is ambiguous without Player05 on the roster', async () => {
  const run = await extractFixture(
    readFixture('halo3-two-team-capture-2.fixture.json'),
    placeholderRoster.filter((entry) => entry.gamertag !== 'Player05'),
  );
  const row = run.parserRows.find((item) => item.player === 'PIayer05');
  assert.equal(row?.playerResolution?.status, 'UNMATCHED');
  assert.equal(row?.playerResolution?.unmatchedReason, 'AMBIGUOUS');
  assert.equal(row?.playerResolution?.gamertag, null);
  assert.equal(row?.playerResolution?.keyDistance, 1);
});
