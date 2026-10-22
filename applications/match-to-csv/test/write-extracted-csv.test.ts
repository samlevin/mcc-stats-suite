import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
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
import { publishStageEvent, type StageEvent } from '../src/lib/metrics';
import { captureLogLines, withoutTimestamp } from './support/log-lines';

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

const trace = {
  executionId:
    'arn:aws:states:us-east-1:000000000000:execution:match-to-csv-dev:example',
  retryCount: 1,
  workflow: 'REPLAY',
} as const;

let stageEvents: StageEvent[] = [];

/** A clock that advances 120 ms on each reading. */
function clock(): () => number {
  let next = 0;
  return () => {
    const current = next;
    next += 120;
    return current;
  };
}

let logLines: string[] = [];
let restoreStdout = () => {};
beforeEach(() => {
  ({ lines: logLines, restore: restoreStdout } = captureLogLines());
  stageEvents = [];
});
afterEach(() => {
  restoreStdout();
});

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
        version: 'scoreboard-parser-v6',
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
    publishStageEvent(stageEvent) {
      stageEvents.push(stageEvent);
    },
    now: clock(),
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
        parser: { version: 'scoreboard-parser-v6', rows: [row], rowColors: [] },
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

test('a stored CSV writes one OK stage event', async () => {
  await writeExtractedCsv(
    { ...event, trace },
    dependencies(new Map()),
    'request-1',
  );

  assert.deepEqual(stageEvents, [
    {
      stage: 'write-csv',
      outcome: 'OK',
      durationMs: 120,
      ids: {
        submissionId: 'submission-1',
        screenshotId: 'screen-1',
        runId: 'run-1',
      },
      trace,
      requestId: 'request-1',
      properties: { rowCount: 1, exportedScreenshotId: 'screen-1' },
      metrics: { CsvWritten: 1 },
    },
  ]);
});

test('a failure writes one ERROR stage event before the error is rethrown', async () => {
  await assert.rejects(
    writeExtractedCsv(
      event,
      dependencies(new Map(), observations({ runId: 'run-2' })),
      'request-1',
    ),
    (error: Error) => {
      // The event is already written when the error reaches the caller.
      assert.equal(stageEvents.length, 1);
      return error.name === 'NormalizedObservationsMismatchError';
    },
  );

  assert.deepEqual(stageEvents, [
    {
      stage: 'write-csv',
      outcome: 'ERROR',
      durationMs: 120,
      ids: {
        submissionId: 'submission-1',
        screenshotId: 'screen-1',
        runId: 'run-1',
      },
      trace: undefined,
      requestId: 'request-1',
      errorName: 'NormalizedObservationsMismatchError',
      properties: {},
      metrics: {},
    },
  ]);
});

test('a publisher failure is logged and never fails the invocation', async () => {
  const publisher = (): void => {
    throw new TypeError('cannot write');
  };
  const result = await writeExtractedCsv(event, {
    ...dependencies(new Map()),
    publishStageEvent: publisher,
  });
  assert.equal(result.rowCount, 1);

  await assert.rejects(
    writeExtractedCsv(event, {
      ...dependencies(new Map(), null),
      publishStageEvent: publisher,
    }),
    { name: 'NormalizedObservationsMismatchError' },
  );

  const errors = logLines
    .map((line) =>
      withoutTimestamp(JSON.parse(line) as Record<string, unknown>),
    )
    .filter((record) => record.level === 'ERROR');
  assert.deepEqual(errors, [
    {
      level: 'ERROR',
      message: 'Stage event not written',
      stage: 'write-csv',
      errorName: 'TypeError',
    },
    {
      level: 'ERROR',
      message: 'Stage event not written',
      stage: 'write-csv',
      errorName: 'TypeError',
    },
  ]);
});

test('published write-csv events carry CsvWritten and never row content', async () => {
  for (const environment of [{}, { EMF_METRICS_ENABLED: 'false' }]) {
    const lines: string[] = [];
    const publishing = (input: ExtractTextOutput, document?: unknown) =>
      writeExtractedCsv(input, {
        ...dependencies(new Map(), document),
        publishStageEvent(stageEvent) {
          publishStageEvent(
            stageEvent,
            (line) => lines.push(line),
            environment,
            0,
          );
        },
      });
    await publishing({ ...event, trace });
    await assert.rejects(publishing(event, null));

    const records = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    assert.deepEqual(
      records.map((record) => [record.Stage, record.outcome]),
      [
        ['write-csv', 'OK'],
        ['write-csv', 'ERROR'],
      ],
    );
    const [ok, failed] = records;
    assert.equal(ok.exportedScreenshotId, 'screen-1');
    assert.equal(ok.workflow, 'REPLAY');
    assert.ok(!('exportedScreenshotId' in failed));
    if (environment.EMF_METRICS_ENABLED === 'false') {
      assert.ok(records.every((record) => !('_aws' in record)));
      assert.ok(!('CsvWritten' in ok));
    } else {
      assert.deepEqual(
        (ok._aws as { CloudWatchMetrics: unknown[] }).CloudWatchMetrics,
        [
          {
            Namespace: 'MCC/MatchToCsv',
            Dimensions: [['Stage']],
            Metrics: [{ Name: 'CsvWritten', Unit: 'Count' }],
          },
        ],
      );
      assert.equal(ok.CsvWritten, 1);
      assert.ok(!('CsvWritten' in failed));
      assert.equal(failed.StageErrors, 1);
      assert.equal(failed.ErrorClass, 'INTEGRITY');
    }

    const visible = lines.join('');
    for (const content of ['PIayer05', 'Player05', 'entry-5', 'Red']) {
      assert.ok(!visible.includes(content), content);
    }
  }
});
