import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  CsvRow,
  ExtractTextOutput,
  PlayerResolution,
  RosterReference,
} from '@mcc/contracts';
import {
  writeExtractedCsv,
  type WriteExtractedCsvDependencies,
} from '../src/lambdas/write-extracted-csv';

const runPrefix = 'submissions/submission-1/screenshots/screen-1/runs/run-1';

const roster: RosterReference = {
  namespace: 'stable',
  rosterVersion: 4,
  rosterSha256: 'b'.repeat(64),
  snapshot: { bucket: 'evidence', key: 'roster/versions/0000000004.json' },
};

const row: CsvRow = {
  team: 'Red',
  player: 'PIayer05',
  score: '10',
  kills: '5',
  assists: '2',
  deaths: '1',
  win: 1,
  loss: 0,
};

const resolved: PlayerResolution = {
  status: 'RESOLVED',
  asRead: 'PIayer05',
  gamertagId: 'entry-5',
  gamertag: 'Player05',
  keyDistance: 0,
  runnerUpDistance: 1,
  textDistance: 1,
  errorTypes: ['GLYPH_SUBSTITUTION'],
  unmatchedReason: null,
};

const event: ExtractTextOutput = {
  runId: 'run-1',
  source: {
    screenshotId: 'screen-1',
    submissionId: 'submission-1',
    bucket: 'evidence',
    key: 'submissions/submission-1/screenshots/screen-1/source/original',
    attachmentName: 'scoreboard.png',
    contentType: 'image/png',
    sha256: 'hash',
    acquisitionType: 'SCREENSHOT',
    widthPx: 1920,
    heightPx: 1080,
  },
  rows: [row],
  normalizedArtifact: {
    bucket: 'evidence',
    key: `${runPrefix}/normalized/observations.json`,
  },
  roster,
};

/** Normalized observations as `extract-text` writes them, round-tripped through JSON. */
function observations(overrides: Record<string, unknown> = {}): unknown {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 'normalized-ocr/v2',
      runId: 'run-1',
      screenshotId: 'screen-1',
      roster,
      blocks: [],
      parser: {
        version: 'scoreboard-parser-v5',
        rows: [{ ...row, playerResolution: resolved }],
        rowColors: [],
      },
      ...overrides,
    }),
  );
}

function dependencies(
  writes: Map<string, string>,
  document: unknown = observations(),
  reads: string[] = [],
): WriteExtractedCsvDependencies {
  return {
    async getJson(bucket, key) {
      reads.push(`${bucket}/${key}`);
      return document;
    },
    async putObject(_bucket, key, body) {
      writes.set(key, body);
    },
  };
}

test('export writes the CSV and structured table under the run', async () => {
  const writes = new Map<string, string>();
  const result = await writeExtractedCsv(event, dependencies(writes));

  assert.deepEqual(result, {
    runId: 'run-1',
    rowCount: 1,
    bucket: 'evidence',
    key: `${runPrefix}/export/extracted.csv`,
  });
  assert.deepEqual([...writes.keys()].sort(), [
    `${runPrefix}/export/extracted-table.json`,
    `${runPrefix}/export/extracted.csv`,
  ]);
});

test('export reads resolutions from the normalized observations', async () => {
  const writes = new Map<string, string>();
  const reads: string[] = [];
  await writeExtractedCsv(event, dependencies(writes, observations(), reads));

  assert.deepEqual(reads, [
    `evidence/${runPrefix}/normalized/observations.json`,
  ]);
  assert.equal(
    writes.get(`${runPrefix}/export/extracted.csv`),
    '"Team","Player","Score","Kills","Assists","Deaths","Win","Loss","PlayerMatch"\n' +
      '"Red","Player05","10","5","2","1","1","0","RESOLVED"\n',
  );
  const table = JSON.parse(
    writes.get(`${runPrefix}/export/extracted-table.json`) ?? '{}',
  ) as unknown;
  assert.deepEqual(table, {
    schemaVersion: 'extracted-table/v1',
    runId: 'run-1',
    roster,
    // The structured table keeps the name as read beside its resolution.
    rows: [{ ...row, playerResolution: resolved }],
    normalizedArtifact: event.normalizedArtifact,
  });
});

test('export fails when the normalized observations belong to another run', async () => {
  const writes = new Map<string, string>();
  await assert.rejects(
    writeExtractedCsv(
      event,
      dependencies(writes, observations({ runId: 'run-2' })),
    ),
    {
      name: 'NormalizedObservationsMismatchError',
      message: /different run/,
    },
  );
  assert.equal(writes.size, 0);
});

test('export fails when the roster reference differs from the input', async () => {
  for (const [label, document, input] of [
    [
      'another version',
      observations({ roster: { ...roster, rosterVersion: 5 } }),
      event,
    ],
    [
      'no reference in the observations',
      observations({ roster: undefined }),
      event,
    ],
    [
      'no reference in the input',
      observations(),
      { ...event, roster: undefined },
    ],
  ] as const) {
    const writes = new Map<string, string>();
    await assert.rejects(
      writeExtractedCsv(input, dependencies(writes, document)),
      {
        name: 'NormalizedObservationsMismatchError',
        message: /different roster reference/,
      },
      label,
    );
    assert.equal(writes.size, 0, label);
  }
});

test('export fails when the normalized observations hold no parser rows', async () => {
  for (const document of [observations({ parser: {} }), null]) {
    await assert.rejects(
      writeExtractedCsv(event, dependencies(new Map(), document)),
      { name: 'NormalizedObservationsMismatchError' },
    );
  }
});

test('a run without resolutions renders an empty PlayerMatch', async () => {
  const writes = new Map<string, string>();
  const input: ExtractTextOutput = { ...event, roster: undefined };
  await writeExtractedCsv(
    input,
    dependencies(
      writes,
      observations({
        roster: undefined,
        parser: { version: 'scoreboard-parser-v5', rows: [row], rowColors: [] },
      }),
    ),
  );

  assert.match(
    writes.get(`${runPrefix}/export/extracted.csv`) ?? '',
    /\n"Red","PIayer05","10","5","2","1","1","0",""\n$/,
  );
  const table = JSON.parse(
    writes.get(`${runPrefix}/export/extracted-table.json`) ?? '{}',
  ) as { roster?: unknown; rows?: unknown };
  assert.ok(!('roster' in table));
  assert.deepEqual(table.rows, [row]);
});

test('export resumes when one immutable artifact already exists', async () => {
  let collisionReported = false;
  const result = await writeExtractedCsv(event, {
    ...dependencies(new Map()),
    async putObject(_bucket, key) {
      if (key.endsWith('.csv')) {
        collisionReported = true;
        throw { $metadata: { httpStatusCode: 412 } };
      }
    },
  });

  assert.equal(collisionReported, true);
  assert.equal(result.rowCount, 1);
});

test('export does not hide storage failures', async () => {
  await assert.rejects(
    writeExtractedCsv(event, {
      ...dependencies(new Map()),
      async putObject() {
        throw new Error('storage unavailable');
      },
    }),
    /storage unavailable/,
  );
});
