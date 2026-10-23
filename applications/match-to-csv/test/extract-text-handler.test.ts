import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createHash } from 'node:crypto';
import type { Block } from '@aws-sdk/client-textract';
import {
  runExtraction,
  type ExtractTextDependencies,
} from '../src/lambdas/extract-text';
import { publishStageEvent, type StageEvent } from '../src/lib/metrics';
import type {
  CsvRow,
  ProcessingRunInput,
  RosterReference,
} from '@mcc/contracts';
import { RosterIntegrityError } from '@mcc/roster';
import type {
  RowColor,
  ScoreboardParseResult,
} from '../src/lib/scoreboard-logic';
import { captureLogLines, withoutTimestamp } from './support/log-lines';

let stageEvents: StageEvent[] = [];
beforeEach(() => {
  stageEvents = [];
});

const trace = {
  executionId:
    'arn:aws:states:us-east-1:000000000000:execution:match-to-csv-dev:example',
  retryCount: 2,
  workflow: 'INGEST',
} as const;

const source = {
  screenshotId: 'screen-1',
  submissionId: 'submission-1',
  bucket: 'evidence',
  key: 'ephemeral/tester/submissions/submission-1/screenshots/screen-1/source/original',
  attachmentName: 'scoreboard.png',
  contentType: 'image/png',
  sha256: createHash('sha256').update('image').digest('hex'),
  acquisitionType: 'SCREENSHOT' as const,
  widthPx: 1920,
  heightPx: 1080,
};

/** The fields these tests read from a run's recorded documents. */
interface RecordedDocument {
  roster?: RosterReference;
  status?: string;
  parser?: { rows: CsvRow[] };
  error?: { name: string };
  request?: unknown;
  versions?: Record<string, string>;
  metrics?: { playerMatchCounts?: Record<string, number> };
}

function withoutResolution(rows: CsvRow[] = []): CsvRow[] {
  return rows.map((row) => {
    const copy = { ...row };
    delete copy.playerResolution;
    return copy;
  });
}

const roster: RosterReference = {
  namespace: 'ephemeral/tester',
  rosterVersion: 3,
  rosterSha256: 'a'.repeat(64),
  snapshot: {
    bucket: 'evidence',
    key: 'ephemeral/tester/roster/versions/0000000003.json',
  },
};

function dependencies(
  writes: Array<{ key: string; value: any }>,
  analyze: ExtractTextDependencies['analyze'],
  image: Buffer = Buffer.from('image'),
  publishedRowCounts: number[] = [],
  calls: string[] = [],
): ExtractTextDependencies {
  let id = 0;
  return {
    async getImage() {
      return image;
    },
    async inspectImage() {
      return { format: 'png', width: 1920, height: 1080 };
    },
    async analyze(input) {
      calls.push('analyze');
      return analyze(input);
    },
    async readRoster(bucket) {
      calls.push(`roster:${bucket}`);
      return {
        reference: roster,
        entries: [{ gamertagId: 'entry-1', gamertag: 'PlayerOne' }],
      };
    },
    async calculateRowColors() {
      return [];
    },
    async writeJson(bucket, key, value) {
      writes.push({ key, value });
      return { bucket, key };
    },
    publishExtractionMetrics(rowCount) {
      publishedRowCounts.push(rowCount);
    },
    publishStageEvent(stageEvent) {
      stageEvents.push(stageEvent);
    },
    id: () => `id-${++id}`,
    timestamp: () => '2026-01-01T00:00:00.000Z',
    clockMs: () => 0,
    build: { gitSha: 'commit-sha', environment: 'TEST' },
  };
}

test('runExtraction records a complete successful run', async () => {
  const writes: Array<{ key: string; value: any }> = [];
  const publishedRowCounts: number[] = [];
  const result = await runExtraction(
    { source },
    dependencies(
      writes,
      async () => ({
        $metadata: { requestId: 'request-id' },
        Blocks: [],
      }),
      undefined,
      publishedRowCounts,
    ),
  );

  assert.equal(result.runId, 'id-1');
  assert.match(result.normalizedArtifact.key, /^ephemeral\/tester\//);
  assert.ok(
    writes.some(
      (write) =>
        write.key.endsWith('/manifest.json') &&
        write.value.build.gitSha === 'commit-sha',
    ),
  );
  const requestIndex = writes.findIndex((write) =>
    write.key.endsWith('/textract/request.json'),
  );
  const responseIndex = writes.findIndex((write) =>
    write.key.endsWith('/textract/raw-response.json'),
  );
  assert.ok(
    requestIndex >= 0 && requestIndex < responseIndex,
    'request is recorded before provider invocation completes',
  );
  assert.ok(
    writes.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.status === 'SUCCEEDED',
    ),
  );
  assert.ok(writes.some((write) => write.value.type === 'RUN_SUCCEEDED'));
  assert.deepEqual(
    publishedRowCounts,
    [0],
    'a response without a table publishes a zero-row extraction',
  );
});

/** A stored `source/metadata.json`, as a replay reads it back. */
function storedSource(fields: Record<string, unknown> = {}) {
  return JSON.parse(
    JSON.stringify({
      schemaVersion: 'source-screenshot/v1',
      ...source,
      fileSizeBytes: 5,
      processingStatus: 'ACCEPTED',
      rejectionCodes: [],
      ...fields,
    }),
  ) as ProcessingRunInput['source'];
}

test('runExtraction replays a source written before receivedAt existed', async () => {
  const writes: Array<{ key: string; value: any }> = [];
  const input: ProcessingRunInput = { source: storedSource() };
  const result = await runExtraction(
    input,
    dependencies(writes, async () => ({ $metadata: {}, Blocks: [] })),
  );

  assert.equal(result.source.screenshotId, 'screen-1');
  assert.ok(!('receivedAt' in result.source));
  assert.ok(writes.some((write) => write.value.type === 'RUN_SUCCEEDED'));
});

test('runExtraction carries receivedAt on the source it returns', async () => {
  const writes: Array<{ key: string; value: any }> = [];
  const receivedAt = '2026-05-02T18:30:00Z';
  const result = await runExtraction(
    {
      source: storedSource({ receivedAt }),
      trace: {
        executionId:
          'arn:aws:states:us-east-1:000000000000:execution:match-to-csv-dev-replay:example',
        retryCount: 1,
        workflow: 'REPLAY',
      },
    },
    dependencies(writes, async () => ({ $metadata: {}, Blocks: [] })),
  );

  assert.equal(result.source.receivedAt, receivedAt);
  assert.ok(writes.some((write) => write.value.type === 'RUN_SUCCEEDED'));
});

test('runExtraction records provider failures and rethrows them', async () => {
  const writes: Array<{ key: string; value: any }> = [];
  const publishedRowCounts: number[] = [];
  const providerError = new Error('try again');
  providerError.name = 'Textract.ThrottlingException';

  await assert.rejects(
    runExtraction(
      { source },
      dependencies(
        writes,
        async () => {
          throw providerError;
        },
        undefined,
        publishedRowCounts,
      ),
    ),
    { name: 'Textract.ThrottlingException' },
  );

  assert.ok(
    writes.some((write) => write.key.endsWith('/textract/request.json')),
  );
  assert.ok(
    writes.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.status === 'FAILED',
    ),
  );
  assert.ok(writes.some((write) => write.value.type === 'RUN_FAILED'));
  assert.deepEqual(
    publishedRowCounts,
    [],
    'a failed run publishes no row count',
  );
});

test('runExtraction refuses a source whose bytes do not match its hash', async () => {
  const writes: Array<{ key: string; value: any }> = [];
  await assert.rejects(
    runExtraction(
      { source: { ...source, sha256: 'different' } },
      dependencies(writes, async () => {
        throw new Error('provider must not be called');
      }),
    ),
    { name: 'SourceHashMismatchError' },
  );
  assert.ok(
    writes.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.error.name === 'SourceHashMismatchError',
    ),
  );
});

test('runExtraction enforces the 10,000,000-byte Textract limit', async () => {
  const atLimit = Buffer.alloc(10_000_000);
  const overLimit = Buffer.alloc(10_000_001);
  const hash = (image: Buffer) =>
    createHash('sha256').update(image).digest('hex');

  let analyzed = 0;
  await runExtraction(
    { source: { ...source, sha256: hash(atLimit) } },
    dependencies(
      [],
      async () => {
        analyzed += 1;
        return { $metadata: {}, Blocks: [] };
      },
      atLimit,
    ),
  );
  assert.equal(analyzed, 1, 'an image at the limit reaches the provider');

  const writes: Array<{ key: string; value: any }> = [];
  await assert.rejects(
    runExtraction(
      { source: { ...source, sha256: hash(overLimit) } },
      dependencies(
        writes,
        async () => {
          throw new Error('provider must not be called');
        },
        overLimit,
      ),
    ),
    { name: 'ImageTooLargeError' },
  );
  assert.ok(
    !writes.some((write) => write.key.endsWith('/textract/request.json')),
  );
});

/**
 * Textract blocks for a PLAYERS/SCORE table with two player rows. Each cell
 * carries the confidence `confidence` returns for its row and column.
 */
const CELL_CONFIDENCE = 72;

/** A two-row scoreboard; `confidence` sets each `WORD` block's confidence. */
function scoreboardBlocks(
  confidence?: (row: number, column: number) => number,
): Block[] {
  const rows = [
    ['PLAYERS', 'SCORE'],
    ['PlayerOne', '15'],
    ['PlayerTwo', '9'],
  ];
  const cells = rows.flatMap((texts, row) =>
    texts.map((text, column) => ({ text, row: row + 1, column: column + 1 })),
  );
  return [
    {
      Id: 'table',
      BlockType: 'TABLE',
      Relationships: [
        { Type: 'CHILD', Ids: cells.map((c) => `cell-${c.row}-${c.column}`) },
      ],
    },
    ...cells.flatMap(({ text, row, column }): Block[] => [
      {
        Id: `cell-${row}-${column}`,
        BlockType: 'CELL',
        RowIndex: row,
        ColumnIndex: column,
        // A structural confidence under every flag and alarm threshold, as
        // on real Halo 3 captures, which validation must not read.
        Confidence: CELL_CONFIDENCE,
        Relationships: [{ Type: 'CHILD', Ids: [`word-${row}-${column}`] }],
      },
      {
        Id: `word-${row}-${column}`,
        BlockType: 'WORD',
        Text: text,
        Confidence: confidence?.(row, column),
      },
    ]),
  ];
}

async function extractScoreboard(rowColors: RowColor[]) {
  const writes: Array<{ key: string; value: any }> = [];
  const publishedRowCounts: number[] = [];
  const result = await runExtraction(
    { source },
    {
      ...dependencies(
        writes,
        async () => ({ $metadata: {}, Blocks: scoreboardBlocks() }),
        undefined,
        publishedRowCounts,
      ),
      async calculateRowColors() {
        return rowColors;
      },
    },
  );
  const written = (suffix: string): unknown =>
    writes.find((write) => write.key.endsWith(suffix))?.value;
  const observations = written('/normalized/observations.json') as {
    parser: ScoreboardParseResult & { version: string };
  };
  return {
    result,
    publishedRowCounts,
    parser: observations.parser,
    completion: written('/completion.json') as {
      status: string;
      metrics: { extractedRowCount: number };
    },
  };
}

test('runExtraction succeeds with no rows and records why for a board that is not two-team', async () => {
  const { result, publishedRowCounts, parser, completion } =
    await extractScoreboard([
      { rowIndex: 1, r: 30, g: 30, b: 30 },
      { rowIndex: 2, r: 120, g: 120, b: 120 },
      { rowIndex: 3, r: 120, g: 120, b: 120 },
    ]);

  assert.equal(completion.status, 'SUCCEEDED');
  assert.equal(completion.metrics.extractedRowCount, 0);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(publishedRowCounts, [0]);
  assert.equal(parser.version, 'scoreboard-parser-v6');
  assert.deepEqual(parser.rows, []);
  assert.deepEqual(parser.noRowsReason, {
    code: 'UNSUPPORTED_TEAM_LAYOUT',
    colorClusterCount: 1,
  });
});

test('runExtraction records no reason for a two-team board', async () => {
  const { result, parser } = await extractScoreboard([
    { rowIndex: 2, r: 230, g: 20, b: 20 },
    { rowIndex: 3, r: 20, g: 20, b: 230 },
  ]);

  assert.deepEqual(
    result.rows.map((row) => [row.player, row.team, row.win]),
    [
      ['PlayerOne', 'Red', 1],
      ['PlayerTwo', 'Blue', 0],
    ],
  );
  assert.deepEqual(withoutResolution(parser.rows), result.rows);
  assert.ok(!('noRowsReason' in parser));
});

test('runExtraction reads the roster before Textract and records its reference', async (t) => {
  const writes: Array<{ key: string; value: any }> = [];
  const calls: string[] = [];
  const { lines: logLines, restore } = captureLogLines();
  t.after(restore);
  const result = await runExtraction(
    { source },
    {
      ...dependencies(
        writes,
        async () => ({ $metadata: {}, Blocks: scoreboardBlocks() }),
        undefined,
        undefined,
        calls,
      ),
      async calculateRowColors() {
        return [
          { rowIndex: 2, r: 230, g: 20, b: 20 },
          { rowIndex: 3, r: 20, g: 20, b: 230 },
        ];
      },
    },
  );

  assert.deepEqual(calls, ['roster:evidence', 'analyze']);
  const written = (suffix: string) =>
    writes.find((write) => write.key.endsWith(suffix))?.value as
      RecordedDocument | undefined;
  assert.deepEqual(written('/normalized/observations.json')?.roster, roster);
  assert.equal(written('/completion.json')?.status, 'SUCCEEDED');
  assert.deepEqual(written('/completion.json')?.roster, roster);
  assert.deepEqual(result.roster, roster);
  // The output carries only the reference: no roster gamertag enters
  // workflow state, and the names stay as read.
  assert.deepEqual(
    result.rows.map((row) => row.player),
    ['PlayerOne', 'PlayerTwo'],
  );
  assert.ok(result.rows.every((row) => !('playerResolution' in row)));
  const parserRows = written('/normalized/observations.json')?.parser?.rows;
  assert.deepEqual(withoutResolution(parserRows), result.rows);

  // Each parser row records its resolution beside the name as read.
  assert.deepEqual(
    parserRows?.map((row) => [
      row.player,
      row.playerResolution?.status,
      row.playerResolution?.gamertagId,
      row.playerResolution?.unmatchedReason,
    ]),
    [
      ['PlayerOne', 'EXACT', 'entry-1', null],
      ['PlayerTwo', 'UNMATCHED', null, 'NO_CANDIDATE'],
    ],
  );
  assert.equal(
    written('/manifest.json')?.versions?.rosterMatcherVersion,
    'roster-matcher-v1',
  );
  assert.equal(written('/manifest.json')?.versions?.pipelineVersion, '1.1.0');
  const counts = { exact: 1, resolved: 0, unmatched: 1 };
  assert.deepEqual(
    written('/completion.json')?.metrics?.playerMatchCounts,
    counts,
  );
  const processed = logLines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((line) => line.message === 'Screenshot processed');
  assert.deepEqual(
    {
      exact: processed?.exact,
      resolved: processed?.resolved,
      unmatched: processed?.unmatched,
    },
    counts,
  );
  assert.ok(
    logLines.every((line) => !line.includes('PlayerOne')),
    'logs never name a gamertag',
  );
});

test('runExtraction fails a run whose roster cannot be read without calling Textract', async () => {
  const writes: Array<{ key: string; value: any }> = [];
  const calls: string[] = [];
  await assert.rejects(
    runExtraction(
      { source },
      {
        ...dependencies(
          writes,
          async () => {
            throw new Error('provider must not be called');
          },
          undefined,
          undefined,
          calls,
        ),
        async readRoster() {
          calls.push('roster');
          throw new RosterIntegrityError(
            'The change log does not reproduce HEAD version 3',
          );
        },
      },
    ),
    { name: 'RosterIntegrityError' },
  );

  assert.deepEqual(calls, ['roster']);
  assert.ok(
    !writes.some((write) => write.key.includes('/textract/')),
    'no Textract request is recorded',
  );
  const completion = writes.find((write) =>
    write.key.endsWith('/completion.json'),
  )?.value as RecordedDocument | undefined;
  assert.equal(completion?.status, 'FAILED');
  assert.equal(completion?.error?.name, 'RosterIntegrityError');
  assert.equal(completion?.request, undefined);
  assert.ok(writes.some((write) => write.value.type === 'RUN_FAILED'));
});

test('runExtraction checks the source hash before reading the roster', async () => {
  const calls: string[] = [];
  await assert.rejects(
    runExtraction(
      { source: { ...source, sha256: 'different' } },
      dependencies(
        [],
        async () => {
          throw new Error('provider must not be called');
        },
        undefined,
        undefined,
        calls,
      ),
    ),
    { name: 'SourceHashMismatchError' },
  );
  assert.deepEqual(calls, []);
});

/**
 * Dependencies whose clock moves forward on every step, so a measured duration
 * shows which steps it spans. `AnalyzeDocument` takes 1830 ms.
 */
function timedDependencies(
  writes: Array<{ key: string; value: any }>,
  analyze: ExtractTextDependencies['analyze'],
): ExtractTextDependencies {
  let clock = 1_000;
  const base = dependencies(writes, analyze);
  return {
    ...base,
    clockMs: () => clock,
    async getImage(bucket, key) {
      clock += 11;
      return base.getImage(bucket, key);
    },
    async readRoster(bucket) {
      clock += 13;
      return base.readRoster(bucket);
    },
    async analyze(image) {
      clock += 1830;
      return base.analyze(image);
    },
    async writeJson(bucket, key, value) {
      clock += 17;
      return base.writeJson(bucket, key, value);
    },
  };
}

test('runExtraction reports the Textract call, word confidence and matches in one OK event', async () => {
  const writes: Array<{ key: string; value: any }> = [];
  const publishedRowCounts: number[] = [];
  // Header words read at 99, PlayerOne's row at 97 and PlayerTwo's row at 85.
  const confidences = [99, 97, 85];
  const result = await runExtraction(
    { source, trace },
    {
      ...timedDependencies(writes, async () => ({
        $metadata: {},
        Blocks: scoreboardBlocks((row) => confidences[row - 1]),
      })),
      publishExtractionMetrics(rowCount) {
        publishedRowCounts.push(rowCount);
      },
      async calculateRowColors() {
        return [
          { rowIndex: 2, r: 230, g: 20, b: 20 },
          { rowIndex: 3, r: 20, g: 20, b: 230 },
        ];
      },
    },
    'request-1',
  );

  assert.equal(stageEvents.length, 1);
  const [stageEvent] = stageEvents;
  const meanConfidence = (99 * 2 + 97 * 2 + 85 * 2) / 6;
  const completion = writes.find((write) =>
    write.key.endsWith('/completion.json'),
  )?.value as RecordedDocument;
  const counts = completion.metrics?.playerMatchCounts ?? {};
  assert.equal(counts.exact + counts.resolved + counts.unmatched, 2);
  assert.deepEqual(stageEvent, {
    stage: 'extract',
    outcome: 'OK',
    durationMs: stageEvent.durationMs,
    requestId: 'request-1',
    ids: {
      submissionId: 'submission-1',
      screenshotId: 'screen-1',
      runId: result.runId,
    },
    trace,
    properties: {
      acquisitionType: 'SCREENSHOT',
      imageBytes: 5,
      widthPx: 1920,
      heightPx: 1080,
      rowCount: 2,
      reviewRequiredCells: 2,
      meanConfidence,
      textractMs: 1830,
      exactRows: counts.exact,
      resolvedRows: counts.resolved,
      unmatchedRows: counts.unmatched,
    },
    metrics: {
      TextractLatency: 1830,
      OcrMeanConfidence: meanConfidence,
      ReviewRequiredCells: 2,
    },
    breakdowns: {
      playerRows: {
        EXACT: counts.exact,
        RESOLVED: counts.resolved,
        UNMATCHED: counts.unmatched,
      },
    },
  });
  assert.ok(
    stageEvent.durationMs >= 11 + 13 + 1830,
    'the duration spans the whole run',
  );
  const observations = writes.find((write) =>
    write.key.endsWith('/normalized/observations.json'),
  )?.value as {
    cells: Array<{
      confidence: number;
      validation: {
        deterministicReviewRequired: boolean;
        flags: Array<{ code: string; actual?: number }>;
      };
    }>;
  };
  assert.equal(
    observations.cells.filter(
      (cell) => cell.validation.deterministicReviewRequired,
    ).length,
    stageEvent.metrics.ReviewRequiredCells,
    'the count matches the review flags in the normalized artifact',
  );
  assert.deepEqual(
    observations.cells.map((cell) => cell.confidence),
    Array(6).fill(CELL_CONFIDENCE),
    'cells keep the CELL block confidence',
  );
  assert.deepEqual(
    observations.cells.flatMap((cell) => cell.validation.flags),
    [
      { code: 'LOW_TEXTRACT_CONFIDENCE', severity: 'WARNING', actual: 85 },
      { code: 'LOW_TEXTRACT_CONFIDENCE', severity: 'WARNING', actual: 85 },
    ],
  );
  assert.equal(result.rows.length, 2);
  assert.deepEqual(publishedRowCounts, [2]);
});

test('runExtraction measures no confidence for a table without cells', async () => {
  await runExtraction(
    { source },
    timedDependencies([], async () => ({
      $metadata: {},
      Blocks: [{ Id: 'table', BlockType: 'TABLE', Confidence: 98 }],
    })),
  );

  assert.equal(stageEvents.length, 1);
  assert.deepEqual(stageEvents[0].metrics, {
    TextractLatency: 1830,
    ReviewRequiredCells: 0,
  });
  assert.ok(!('meanConfidence' in stageEvents[0].properties));
  assert.deepEqual(stageEvents[0].breakdowns, {
    playerRows: { EXACT: 0, RESOLVED: 0, UNMATCHED: 0 },
  });
});

test('a failed Textract call writes one ERROR event with no measurements', async () => {
  const providerError = new Error('try again');
  providerError.name = 'ThrottlingException';
  await assert.rejects(
    runExtraction(
      { source, trace },
      timedDependencies([], async () => {
        throw providerError;
      }),
      'request-1',
    ),
    (error: Error) => {
      // The event is already written when the error reaches the caller.
      assert.equal(stageEvents.length, 1);
      return error.name === 'ThrottlingException';
    },
  );

  assert.deepEqual(stageEvents, [
    {
      stage: 'extract',
      outcome: 'ERROR',
      durationMs: 17 * 3 + 11 + 13 + 1830 + 17 * 2,
      errorName: 'ThrottlingException',
      requestId: 'request-1',
      ids: {
        submissionId: 'submission-1',
        screenshotId: 'screen-1',
        runId: 'id-1',
      },
      trace,
      properties: {
        acquisitionType: 'SCREENSHOT',
        imageBytes: 5,
        widthPx: 1920,
        heightPx: 1080,
      },
      metrics: {},
    },
  ]);
});

test('an ERROR event keeps the Textract time when a later step fails', async () => {
  await assert.rejects(
    runExtraction(
      { source },
      {
        ...timedDependencies([], async () => ({ $metadata: {}, Blocks: [] })),
        async calculateRowColors() {
          throw new Error('unreadable image');
        },
      },
    ),
    { message: 'unreadable image' },
  );

  assert.equal(stageEvents.length, 1);
  assert.equal(stageEvents[0].outcome, 'ERROR');
  assert.equal(stageEvents[0].errorName, 'Error');
  assert.deepEqual(stageEvents[0].metrics, { TextractLatency: 1830 });
  assert.equal(stageEvents[0].properties.textractMs, 1830);
  assert.ok(!('exactRows' in stageEvents[0].properties));
  assert.equal(stageEvents[0].breakdowns, undefined);
});

test('a failure before the run starts still writes one ERROR event', async () => {
  await assert.rejects(
    runExtraction(
      { source },
      {
        ...dependencies([], async () => ({ $metadata: {}, Blocks: [] })),
        async writeJson() {
          throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
        },
      },
    ),
    { name: 'AccessDenied' },
  );

  assert.equal(stageEvents.length, 1);
  assert.equal(stageEvents[0].outcome, 'ERROR');
  assert.equal(stageEvents[0].errorName, 'AccessDenied');
  assert.deepEqual(stageEvents[0].ids, {
    submissionId: 'submission-1',
    screenshotId: 'screen-1',
    runId: 'id-1',
  });
  assert.deepEqual(stageEvents[0].properties, {
    acquisitionType: 'SCREENSHOT',
  });
});

test('a publisher failure is logged and never fails the extraction', async () => {
  const captured = captureLogLines();
  const publisher = (): void => {
    throw new TypeError('cannot write');
  };
  try {
    const result = await runExtraction(
      { source },
      {
        ...dependencies([], async () => ({ $metadata: {}, Blocks: [] })),
        publishStageEvent: publisher,
      },
    );
    assert.equal(result.rows.length, 0);
    await assert.rejects(
      runExtraction(
        { source: { ...source, sha256: 'different' } },
        {
          ...dependencies([], async () => ({ $metadata: {}, Blocks: [] })),
          publishStageEvent: publisher,
        },
      ),
      { name: 'SourceHashMismatchError' },
    );
  } finally {
    captured.restore();
  }

  const errors = captured.lines
    .map((line) =>
      withoutTimestamp(JSON.parse(line) as Record<string, unknown>),
    )
    .filter((record) => record.message === 'Stage event not written');
  assert.deepEqual(errors, [
    {
      level: 'ERROR',
      message: 'Stage event not written',
      stage: 'extract',
      errorName: 'TypeError',
    },
    {
      level: 'ERROR',
      message: 'Stage event not written',
      stage: 'extract',
      errorName: 'TypeError',
    },
  ]);
});

test('published extract events carry their metrics and never a gamertag or OCR text', async () => {
  for (const environment of [{}, { EMF_METRICS_ENABLED: 'false' }]) {
    const lines: string[] = [];
    const extractionLines: string[] = [];
    await runExtraction(
      { source, trace },
      {
        ...timedDependencies([], async () => ({
          $metadata: {},
          Blocks: scoreboardBlocks(() => 97),
        })),
        publishStageEvent(stageEvent) {
          publishStageEvent(
            stageEvent,
            (line) => lines.push(line),
            environment,
            0,
          );
        },
        publishExtractionMetrics(rowCount) {
          extractionLines.push(String(rowCount));
        },
        async calculateRowColors() {
          return [
            { rowIndex: 2, r: 230, g: 20, b: 20 },
            { rowIndex: 3, r: 20, g: 20, b: 230 },
          ];
        },
      },
    );

    const records = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const [event, ...breakdowns] = records;
    assert.equal(event.Stage, 'extract');
    assert.equal(event.outcome, 'OK');
    assert.deepEqual(extractionLines, ['2'], 'ExtractedRows is still called');
    if (environment.EMF_METRICS_ENABLED === 'false') {
      assert.deepEqual(breakdowns, []);
      assert.ok(!('_aws' in event));
      assert.ok(!('TextractLatency' in event));
    } else {
      assert.deepEqual(
        (event._aws as { CloudWatchMetrics: unknown[] }).CloudWatchMetrics,
        [
          {
            Namespace: 'MCC/MatchToCsv',
            Dimensions: [['Stage']],
            Metrics: [
              { Name: 'TextractLatency', Unit: 'Milliseconds' },
              { Name: 'OcrMeanConfidence', Unit: 'Percent' },
              { Name: 'ReviewRequiredCells', Unit: 'Count' },
            ],
          },
        ],
      );
      assert.ok(breakdowns.length > 0);
      for (const breakdown of breakdowns) {
        assert.equal(breakdown.event, 'metric.breakdown');
        assert.equal(breakdown.Stage, 'extract');
        assert.ok(
          ['EXACT', 'RESOLVED', 'UNMATCHED'].includes(
            breakdown.MatchStatus as string,
          ),
        );
        assert.ok((breakdown.PlayerRows as number) > 0);
      }
      assert.equal(
        breakdowns.reduce(
          (sum, breakdown) => sum + (breakdown.PlayerRows as number),
          0,
        ),
        event.rowCount,
      );
    }

    const visible = lines.join('');
    for (const content of ['PlayerOne', 'PlayerTwo', 'entry-1', 'SCORE']) {
      assert.ok(!visible.includes(content), content);
    }
  }
});
