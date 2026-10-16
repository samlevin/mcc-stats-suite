import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import type { Block } from '@aws-sdk/client-textract';
import {
  runExtraction,
  type ExtractTextDependencies,
} from '../src/lambdas/extract-text';
import type {
  RowColor,
  ScoreboardParseResult,
} from '../src/lib/scoreboard-logic';

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

function dependencies(
  writes: Array<{ key: string; value: any }>,
  analyze: ExtractTextDependencies['analyze'],
  image: Buffer = Buffer.from('image'),
  publishedRowCounts: number[] = [],
): ExtractTextDependencies {
  let id = 0;
  return {
    async getImage() {
      return image;
    },
    async inspectImage() {
      return { format: 'png', width: 1920, height: 1080 };
    },
    analyze,
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
    id: () => `id-${++id}`,
    timestamp: () => '2026-01-01T00:00:00.000Z',
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

/** Textract blocks for a PLAYERS/SCORE table with two player rows. */
function scoreboardBlocks(): Block[] {
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
        Relationships: [{ Type: 'CHILD', Ids: [`word-${row}-${column}`] }],
      },
      { Id: `word-${row}-${column}`, BlockType: 'WORD', Text: text },
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
  assert.equal(parser.version, 'scoreboard-parser-v5');
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
  assert.deepEqual(parser.rows, result.rows);
  assert.ok(!('noRowsReason' in parser));
});
