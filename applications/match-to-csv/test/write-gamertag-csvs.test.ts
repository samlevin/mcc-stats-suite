import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type {
  CsvRow,
  PlayerResolution,
  WriteExtractedCsvOutput,
  WriteGamertagCsvsInput,
} from '@mcc/contracts';
import {
  gamertagObjectName,
  writeGamertagCsvs,
  type WriteGamertagCsvsDependencies,
} from '../src/lambdas/write-gamertag-csvs';
import { publishStageEvent, type StageEvent } from '../src/lib/metrics';
import { captureLogLines, withoutTimestamp } from './support/log-lines';

const submissionPrefix = 'submissions/submission-1';
const exportPrefix = `${submissionPrefix}/export/gamertags/`;

function runExport(
  screenshot: string,
  runId: string,
  prefix = submissionPrefix,
): WriteExtractedCsvOutput {
  return {
    runId,
    rowCount: 0,
    bucket: 'evidence',
    key: `${prefix}/screenshots/${screenshot}/runs/${runId}/export/extracted.csv`,
  };
}

function tableKey(item: WriteExtractedCsvOutput): string {
  return item.key.replace(/extracted\.csv$/, 'extracted-table.json');
}

function resolution(
  status: PlayerResolution['status'],
  gamertag: string | null,
): PlayerResolution {
  return {
    status,
    asRead: gamertag ?? 'Unknown 1',
    gamertagId: gamertag ? `entry-${gamertag}` : null,
    gamertag,
    keyDistance: status === 'UNMATCHED' ? null : 0,
    runnerUpDistance: null,
    textDistance: status === 'RESOLVED' ? 1 : status === 'EXACT' ? 0 : null,
    errorTypes: status === 'RESOLVED' ? ['GLYPH_SUBSTITUTION'] : [],
    unmatchedReason: status === 'UNMATCHED' ? 'NO_CANDIDATE' : null,
  };
}

function row(
  player: string,
  stats: [kills: string, assists: string, deaths: string],
  win: boolean,
  playerResolution?: PlayerResolution,
): CsvRow {
  return {
    team: win ? 'Red' : 'Blue',
    player,
    score: '10',
    kills: stats[0],
    assists: stats[1],
    deaths: stats[2],
    win: win ? 1 : 0,
    loss: win ? 0 : 1,
    ...(playerResolution ? { playerResolution } : {}),
  };
}

const first = runExport('screen-1', 'run-1');
const second = runExport('screen-2', 'run-2');

/** Two screenshots of one session, with placeholder gamertags only. */
const tables = new Map<string, CsvRow[]>([
  [
    tableKey(first),
    [
      row('Player01', ['12', '3', '4'], true, resolution('EXACT', 'Player01')),
      row(
        'PIayer 02',
        ['8', '5', '6'],
        true,
        resolution('RESOLVED', 'Player 02'),
      ),
      row('Stranger', ['7', '1', '9'], false, resolution('UNMATCHED', null)),
      row(
        'Player03#7',
        ['5', '0', '11'],
        false,
        resolution('EXACT', 'Player03#7'),
      ),
    ],
  ],
  [
    tableKey(second),
    [
      row(
        'Player 02',
        ['10', '2', '3'],
        false,
        resolution('EXACT', 'Player 02'),
      ),
      row('Player01', ['9', '4', '7'], false, resolution('EXACT', 'Player01')),
      row('Unresolved', ['6', '6', '6'], true),
    ],
  ],
]);

const event: WriteGamertagCsvsInput = {
  submissionId: 'submission-1',
  matchDate: '2026-03-07',
  exports: [first, second],
};

const trace = {
  executionId:
    'arn:aws:states:us-east-1:000000000000:execution:match-to-csv-dev:example',
  retryCount: 0,
  workflow: 'INGEST',
} as const;

/** The first reading of the test clock. Each later reading is 400 ms on. */
const CLOCK_START = Date.parse('2026-03-07T21:05:00Z');

let stageEvents: StageEvent[] = [];

function dependencies(
  writes: Map<string, string>,
  documents: Map<string, unknown> = new Map(
    [...tables].map(([key, rows]) => [key, table(key, rows)]),
  ),
): WriteGamertagCsvsDependencies {
  return {
    async getJson(_bucket, key) {
      return documents.get(key) ?? null;
    },
    async putObject(_bucket, key, body, contentType) {
      assert.equal(contentType, 'text/csv');
      writes.set(key, body);
    },
    publishStageEvent(stageEvent) {
      stageEvents.push(stageEvent);
    },
    now: clock(),
  };
}

function clock(): () => number {
  let next = CLOCK_START;
  return () => {
    const current = next;
    next += 400;
    return current;
  };
}

/** `extracted-table.json` as `write-extracted-csv` writes it. */
function table(key: string, rows: CsvRow[]): unknown {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 'extracted-table/v1',
      runId: /\/runs\/([^/]+)\//.exec(key)?.[1],
      rows,
    }),
  );
}

let logLines: string[] = [];
let restoreStdout = () => {};
beforeEach(() => {
  ({ lines: logLines, restore: restoreStdout } = captureLogLines());
  stageEvents = [];
  delete process.env.OBJECT_PREFIX;
});
afterEach(() => {
  restoreStdout();
  delete process.env.OBJECT_PREFIX;
});

test('writes one file per roster gamertag, in screenshot order, with the match date', async () => {
  const writes = new Map<string, string>();
  const result = await writeGamertagCsvs(event, dependencies(writes));

  assert.deepEqual(Object.fromEntries(writes), {
    [`${exportPrefix}Player01.csv`]: '3/7/2026,12,3,4,1,\n3/7/2026,9,4,7,,1\n',
    [`${exportPrefix}Player_02.csv`]: '3/7/2026,8,5,6,1,\n3/7/2026,10,2,3,,1\n',
    [`${exportPrefix}Player03-7.csv`]: '3/7/2026,5,0,11,,1\n',
  });
  assert.deepEqual(result, {
    submissionId: 'submission-1',
    prefix: exportPrefix,
    fileCount: 3,
    rowCount: 5,
  });
});

test('trace context and receivedAt do not change the export', async () => {
  const plain = new Map<string, string>();
  const traced = new Map<string, string>();
  const plainResult = await writeGamertagCsvs(event, dependencies(plain));
  const tracedResult = await writeGamertagCsvs(
    {
      ...event,
      receivedAt: '2026-03-07T21:00:00Z',
      trace,
    },
    dependencies(traced),
  );

  assert.deepEqual(tracedResult, plainResult);
  assert.deepEqual(Object.fromEntries(traced), Object.fromEntries(plain));
});

test('reads each run export of the submission from its extracted table', async () => {
  const reads: string[] = [];
  const base = dependencies(new Map());
  await writeGamertagCsvs(event, {
    ...base,
    async getJson(bucket, key) {
      reads.push(`${bucket}/${key}`);
      return base.getJson(bucket, key);
    },
  });

  assert.deepEqual(reads.sort(), [
    `evidence/${tableKey(first)}`,
    `evidence/${tableKey(second)}`,
  ]);
});

test('the order of the exports decides the order of the lines', async () => {
  const writes = new Map<string, string>();
  await writeGamertagCsvs(
    { ...event, exports: [second, first] },
    dependencies(writes),
  );

  assert.equal(
    writes.get(`${exportPrefix}Player01.csv`),
    '3/7/2026,9,4,7,,1\n3/7/2026,12,3,4,1,\n',
  );
});

test('UNMATCHED rows and rows without a resolution appear in no file', async () => {
  const writes = new Map<string, string>();
  await writeGamertagCsvs(event, dependencies(writes));

  const contents = [...writes.values()].join('');
  // Only the UNMATCHED row has 7 kills and only the unresolved row 6.
  assert.doesNotMatch(contents, /,7,1,9,/);
  assert.doesNotMatch(contents, /,6,6,6,/);
  assert.equal(contents.split('\n').length - 1, 5);
});

test('a submission without a matched row writes no file', async () => {
  const writes = new Map<string, string>();
  const only = runExport('screen-1', 'run-1');
  const result = await writeGamertagCsvs(
    { ...event, exports: [only] },
    dependencies(
      writes,
      new Map([
        [
          tableKey(only),
          table(tableKey(only), [
            row(
              'Stranger',
              ['1', '2', '3'],
              true,
              resolution('UNMATCHED', null),
            ),
            row('Unresolved', ['4', '5', '6'], false),
          ]),
        ],
      ]),
    ),
  );

  assert.equal(writes.size, 0);
  assert.deepEqual(result, {
    submissionId: 'submission-1',
    prefix: exportPrefix,
    fileCount: 0,
    rowCount: 0,
  });
});

test('every line of every file carries the submission match date', async () => {
  for (const [matchDate, rendered] of [
    ['2026-12-31', '12/31/2026'],
    ['2026-01-01', '1/1/2026'],
    ['2026-10-09', '10/9/2026'],
  ] as const) {
    const writes = new Map<string, string>();
    await writeGamertagCsvs({ ...event, matchDate }, dependencies(writes));
    for (const body of writes.values()) {
      for (const line of body.slice(0, -1).split('\n')) {
        assert.equal(line.split(',')[0], rendered, matchDate);
        assert.equal(line.split(',').length, 6, matchDate);
      }
    }
  }
});

test('an invalid match date fails before any read or write', async () => {
  const writes = new Map<string, string>();
  let read = false;
  await assert.rejects(
    writeGamertagCsvs(
      { ...event, matchDate: '3/7/2026' },
      {
        ...dependencies(writes),
        async getJson() {
          read = true;
          return null;
        },
      },
    ),
    /Match date is not YYYY-MM-DD/,
  );
  assert.equal(read, false);
  assert.equal(writes.size, 0);
});

test('file names keep letters and digits and encode spaces and #', () => {
  assert.equal(gamertagObjectName('Player01'), 'Player01.csv');
  assert.equal(gamertagObjectName('Player 02'), 'Player_02.csv');
  assert.equal(gamertagObjectName('A B C'), 'A_B_C.csv');
  assert.equal(gamertagObjectName('Player03#7'), 'Player03-7.csv');
  assert.equal(gamertagObjectName('Player 04#1234'), 'Player_04-1234.csv');
});

test('different gamertags never share a file name', () => {
  const gamertags = [
    'Player1',
    'Player 1',
    'Player  1',
    'Player#1',
    'Player 1#1',
    'Player1#1',
    'Player11',
    'player1',
    'PLAYER1',
    'Player#11',
    'Player1#11',
    'Player 11',
    '1',
    '1#1',
    '11',
    ' 1',
    'a'.repeat(16),
    `${'a'.repeat(16)}#9999`,
  ];
  const names = gamertags.map(gamertagObjectName);
  assert.equal(new Set(names).size, gamertags.length);
  for (const name of names) {
    // Safe in S3 keys and URLs without escaping.
    assert.match(name, /^[A-Za-z0-9_-]+\.csv$/);
    assert.equal(encodeURIComponent(name), name);
  }
});

test('a gamertag outside the roster pattern is refused without naming it', () => {
  for (const gamertag of [
    '',
    'Player_01',
    'Player-01',
    'Player/01',
    '../Player01',
    'Player01#',
    'Player01#12345',
    'a'.repeat(17),
    'Pläyer01',
  ]) {
    assert.throws(
      () => gamertagObjectName(gamertag),
      (error: Error) =>
        error.name === 'InvalidGamertagError' &&
        (gamertag === '' || !error.message.includes(gamertag)),
      JSON.stringify(gamertag),
    );
  }
});

test('a retried step treats existing files as already written', async () => {
  const attempted: string[] = [];
  const result = await writeGamertagCsvs(event, {
    ...dependencies(new Map()),
    async putObject(_bucket, key) {
      attempted.push(key);
      throw Object.assign(new Error('PreconditionFailed'), {
        name: 'PreconditionFailed',
        $metadata: { httpStatusCode: 412 },
      });
    },
  });

  assert.equal(attempted.length, 3);
  assert.equal(result.fileCount, 3);
  assert.equal(result.rowCount, 5);
  assert.equal(stageEvents.length, 1);
  assert.equal(stageEvents[0].outcome, 'OK');
  assert.deepEqual(stageEvents[0].properties, {
    fileCount: 3,
    rowCount: 5,
    exportCount: 2,
    completedSubmissionId: 'submission-1',
  });
});

test('storage failures surface under their name without the key', async () => {
  await assert.rejects(
    writeGamertagCsvs(event, {
      ...dependencies(new Map()),
      async putObject(bucket, key) {
        throw Object.assign(
          new Error(`not authorized on resource ${bucket}/${key}`),
          { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } },
        );
      },
    }),
    (error: Error) =>
      error.name === 'AccessDenied' &&
      /Writing gamertag CSV \d of 3 failed with AccessDenied/.test(
        error.message,
      ) &&
      !/Player|gamertags\//.test(error.message),
  );
});

test('an ephemeral stack reads and writes only under its namespace', async () => {
  process.env.OBJECT_PREFIX = 'ephemeral/tester';
  const prefix = `ephemeral/tester/${submissionPrefix}`;
  const ephemeralFirst = runExport('screen-1', 'run-1', prefix);
  const writes = new Map<string, string>();
  const result = await writeGamertagCsvs(
    { ...event, exports: [ephemeralFirst] },
    dependencies(
      writes,
      new Map([
        [
          tableKey(ephemeralFirst),
          table(tableKey(ephemeralFirst), tables.get(tableKey(first)) ?? []),
        ],
      ]),
    ),
  );

  assert.equal(result.prefix, `${prefix}/export/gamertags/`);
  assert.deepEqual([...writes.keys()].sort(), [
    `${prefix}/export/gamertags/Player01.csv`,
    `${prefix}/export/gamertags/Player03-7.csv`,
    `${prefix}/export/gamertags/Player_02.csv`,
  ]);

  // A stable-namespace export is not this ephemeral stack's to read.
  await assert.rejects(writeGamertagCsvs(event, dependencies(new Map())), {
    name: 'InvalidGamertagExportInputError',
  });
});

test('exports outside the submission fail before any read or write', async () => {
  const outside: [string, WriteExtractedCsvOutput][] = [
    ['another submission', runExport('screen-1', 'run-1', 'submissions/other')],
    ['another run ID', { ...first, runId: 'run-9' }],
    [
      'not a run export',
      {
        ...first,
        key: `${submissionPrefix}/screenshots/screen-1/source/original`,
      },
    ],
    ['a nested path', runExport('screen-1/runs/run-0/x', 'run-1')],
    [
      'an empty screenshot',
      {
        ...first,
        key: `${submissionPrefix}/screenshots//runs/run-1/export/extracted.csv`,
      },
    ],
  ];
  for (const [label, item] of outside) {
    const writes = new Map<string, string>();
    let read = false;
    await assert.rejects(
      writeGamertagCsvs(
        { ...event, exports: [item] },
        {
          ...dependencies(writes),
          async getJson() {
            read = true;
            return null;
          },
        },
      ),
      { name: 'InvalidGamertagExportInputError' },
      label,
    );
    assert.equal(read, false, label);
    assert.equal(writes.size, 0, label);
  }
});

test('an unexpected submission ID or a second bucket fails', async () => {
  for (const input of [
    { ...event, submissionId: '../submission-1' },
    { ...event, submissionId: '' },
    { ...event, exports: [first, { ...second, bucket: 'other' }] },
  ]) {
    await assert.rejects(writeGamertagCsvs(input, dependencies(new Map())), {
      name: 'InvalidGamertagExportInputError',
    });
  }
});

test('an extracted table of another run or schema fails before any write', async () => {
  for (const document of [
    null,
    { schemaVersion: 'extracted-table/v1', runId: 'run-9', rows: [] },
    { schemaVersion: 'extracted-table/v2', runId: 'run-1', rows: [] },
    { schemaVersion: 'extracted-table/v1', runId: 'run-1' },
  ]) {
    const writes = new Map<string, string>();
    const documents = new Map<string, unknown>([
      [tableKey(first), document],
      [
        tableKey(second),
        table(tableKey(second), tables.get(tableKey(second)) ?? []),
      ],
    ]);
    await assert.rejects(
      writeGamertagCsvs(event, dependencies(writes, documents)),
      { name: 'ExtractedTableMismatchError' },
    );
    assert.equal(writes.size, 0);
  }
});

test('a matched row without a gamertag fails without naming a player', async () => {
  const writes = new Map<string, string>();
  const documents = new Map<string, unknown>([
    [
      tableKey(first),
      table(tableKey(first), [
        row('Player01', ['1', '2', '3'], true, {
          ...resolution('EXACT', 'Player01'),
          gamertag: null,
        }),
      ]),
    ],
  ]);
  await assert.rejects(
    writeGamertagCsvs(
      { ...event, exports: [first] },
      dependencies(writes, documents),
    ),
    (error: Error) =>
      error.name === 'ExtractedTableMismatchError' &&
      error.message === 'Row 1 of run run-1 is matched without a gamertag',
  );
  assert.equal(writes.size, 0);
});

test('no gamertag or file name reaches the output or the log', async () => {
  const result = await writeGamertagCsvs(event, dependencies(new Map()));

  assert.equal(logLines.length, 1);
  const record = JSON.parse(logLines[0]) as Record<string, unknown>;
  assert.equal(typeof record.timestamp, 'string');
  assert.deepEqual(withoutTimestamp(record), {
    level: 'INFO',
    message: 'Gamertag CSVs written',
    submissionId: 'submission-1',
    prefix: exportPrefix,
    fileCount: 3,
    rowCount: 5,
    exportCount: 2,
  });
  const visible = JSON.stringify(result) + logLines.join('\n');
  for (const gamertag of ['Player01', 'Player 02', 'Player03#7']) {
    assert.ok(!visible.includes(gamertag), gamertag);
    assert.ok(!visible.includes(gamertagObjectName(gamertag)), gamertag);
  }
  assert.ok(!visible.includes('.csv'));
});

test('a completed export writes one OK stage event with its counts', async () => {
  const result = await writeGamertagCsvs(
    event,
    dependencies(new Map()),
    'request-1',
  );

  assert.deepEqual(stageEvents, [
    {
      stage: 'write-gamertag-csvs',
      outcome: 'OK',
      durationMs: 400,
      ids: { submissionId: 'submission-1' },
      trace: undefined,
      requestId: 'request-1',
      properties: {
        fileCount: result.fileCount,
        rowCount: result.rowCount,
        exportCount: 2,
        completedSubmissionId: 'submission-1',
      },
      metrics: { GamertagCsvsWritten: 3, SubmissionsCompleted: 1 },
    },
  ]);
});

test('an OK event measures end-to-end latency from receivedAt', async () => {
  await writeGamertagCsvs(
    { ...event, receivedAt: '2026-03-07T21:00:00Z', trace },
    dependencies(new Map()),
  );

  assert.equal(stageEvents.length, 1);
  const [stageEvent] = stageEvents;
  assert.deepEqual(stageEvent.trace, trace);
  assert.equal(stageEvent.properties.endToEndMs, 300_400);
  assert.deepEqual(stageEvent.metrics, {
    GamertagCsvsWritten: 3,
    SubmissionsCompleted: 1,
    EndToEndLatency: 300_400,
  });
});

test('a missing or malformed receivedAt leaves out end-to-end latency', async () => {
  for (const receivedAt of [
    undefined,
    '',
    'yesterday',
    '2026-02-30T00:00:00Z',
  ]) {
    stageEvents = [];
    await writeGamertagCsvs({ ...event, receivedAt }, dependencies(new Map()));
    assert.equal(stageEvents.length, 1);
    assert.ok(!('endToEndMs' in stageEvents[0].properties), receivedAt);
    assert.ok(!('EndToEndLatency' in stageEvents[0].metrics), receivedAt);
  }
});

test('a failure writes one ERROR stage event before the error is rethrown', async () => {
  let failed = false;
  await assert.rejects(
    writeGamertagCsvs(
      { ...event, trace },
      {
        ...dependencies(new Map()),
        async putObject(_bucket, key) {
          // The first file is stored; the other two fail.
          if (!key.endsWith('Player01.csv')) {
            failed = true;
            throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
          }
        },
      },
      'request-1',
    ),
    (error: Error) => {
      // The event is already written when the error reaches the caller.
      assert.equal(stageEvents.length, 1);
      return error.name === 'AccessDenied';
    },
  );

  assert.ok(failed);
  assert.deepEqual(stageEvents, [
    {
      stage: 'write-gamertag-csvs',
      outcome: 'ERROR',
      durationMs: 400,
      ids: { submissionId: 'submission-1' },
      trace,
      requestId: 'request-1',
      errorName: 'AccessDenied',
      properties: { fileCount: 1, rowCount: 2, exportCount: 2 },
      metrics: {},
    },
  ]);
});

test('an input failure writes an ERROR event with zero files', async () => {
  for (const [input, ids] of [
    [{ ...event, matchDate: '3/7/2026' }, { submissionId: 'submission-1' }],
    [{ ...event, submissionId: '../submission-1' }, {}],
  ] as const) {
    stageEvents = [];
    await assert.rejects(writeGamertagCsvs(input, dependencies(new Map())));
    assert.equal(stageEvents.length, 1);
    assert.equal(stageEvents[0].outcome, 'ERROR');
    assert.deepEqual(stageEvents[0].ids, ids);
    assert.deepEqual(stageEvents[0].properties, {
      fileCount: 0,
      rowCount: 0,
      exportCount: 2,
    });
  }
});

test('a publisher failure is logged and never fails the invocation', async () => {
  const publisher = (): void => {
    throw new TypeError('cannot write');
  };
  const result = await writeGamertagCsvs(event, {
    ...dependencies(new Map()),
    publishStageEvent: publisher,
  });
  assert.equal(result.fileCount, 3);

  await assert.rejects(
    writeGamertagCsvs(
      { ...event, matchDate: '3/7/2026' },
      { ...dependencies(new Map()), publishStageEvent: publisher },
    ),
    /Match date is not YYYY-MM-DD/,
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
      stage: 'write-gamertag-csvs',
      errorName: 'TypeError',
    },
    {
      level: 'ERROR',
      message: 'Stage event not written',
      stage: 'write-gamertag-csvs',
      errorName: 'TypeError',
    },
  ]);
});

test('published stage events carry the metrics and never a gamertag or file name', async () => {
  for (const environment of [{}, { EMF_METRICS_ENABLED: 'false' }]) {
    const lines: string[] = [];
    const publishing = (input: WriteGamertagCsvsInput) =>
      writeGamertagCsvs(input, {
        ...dependencies(new Map()),
        publishStageEvent(stageEvent) {
          publishStageEvent(
            stageEvent,
            (line) => lines.push(line),
            environment,
            CLOCK_START,
          );
        },
      });
    await publishing({ ...event, receivedAt: '2026-03-07T21:00:00Z', trace });
    await assert.rejects(
      publishing({
        ...event,
        exports: [first, { ...second, runId: 'Player01' }],
      }),
    );

    const records = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    assert.deepEqual(
      records.map((record) => [record.Stage, record.outcome]),
      [
        ['write-gamertag-csvs', 'OK'],
        ['write-gamertag-csvs', 'ERROR'],
      ],
    );
    const [ok, failed] = records;
    assert.equal(ok.completedSubmissionId, 'submission-1');
    assert.ok(!('completedSubmissionId' in failed));
    if (environment.EMF_METRICS_ENABLED === 'false') {
      assert.ok(records.every((record) => !('_aws' in record)));
      assert.ok(!('GamertagCsvsWritten' in ok));
    } else {
      assert.deepEqual(
        (ok._aws as { CloudWatchMetrics: unknown[] }).CloudWatchMetrics,
        [
          {
            Namespace: 'MCC/MatchToCsv',
            Dimensions: [['Stage']],
            Metrics: [
              { Name: 'GamertagCsvsWritten', Unit: 'Count' },
              { Name: 'SubmissionsCompleted', Unit: 'Count' },
              { Name: 'EndToEndLatency', Unit: 'Milliseconds' },
            ],
          },
        ],
      );
      assert.equal(ok.GamertagCsvsWritten, 3);
      assert.equal(ok.SubmissionsCompleted, 1);
      assert.equal(ok.EndToEndLatency, 300_400);
      assert.equal(failed.StageErrors, 1);
    }

    const visible = lines.join('');
    for (const gamertag of ['Player 02', 'Player03#7']) {
      assert.ok(!visible.includes(gamertag), gamertag);
      assert.ok(!visible.includes(gamertagObjectName(gamertag)), gamertag);
    }
    assert.ok(!visible.includes('Player01.csv'));
    assert.ok(!visible.includes('.csv'));
  }
});
