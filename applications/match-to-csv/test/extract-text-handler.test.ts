import t from 'tap';
import type { S3ObjectReference } from '@mcc/contracts';
import { createHash } from 'node:crypto';
import {
  runExtraction,
  type ExtractTextDependencies,
} from '../src/lambdas/extract-text';

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
): ExtractTextDependencies {
  let id = 0;
  return {
    async getImage() {
      return Buffer.from('image');
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
      return { bucket, key } as S3ObjectReference;
    },
    id: () => `id-${++id}`,
    timestamp: () => '2026-01-01T00:00:00.000Z',
    build: { gitSha: 'commit-sha', environment: 'TEST' },
  };
}

t.test('runExtraction records a complete successful run', async (t) => {
  const writes: Array<{ key: string; value: any }> = [];
  const result = await runExtraction(
    { source },
    dependencies(writes, async () => ({
      $metadata: { requestId: 'request-id' },
      Blocks: [],
    })),
  );

  t.equal(result.runId, 'id-1');
  t.match(result.normalizedArtifact.key, /^ephemeral\/tester\//);
  t.ok(
    writes.some(
      (write) =>
        write.key.endsWith('/manifest.json') &&
        write.value.build.gitSha === 'commit-sha',
    ),
  );
  const requestIndex = writes.findIndex((write) => write.key.endsWith('/textract/request.json'));
  const responseIndex = writes.findIndex((write) => write.key.endsWith('/textract/raw-response.json'));
  t.ok(requestIndex >= 0 && requestIndex < responseIndex, 'request is recorded before provider invocation completes');
  t.ok(
    writes.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.status === 'SUCCEEDED',
    ),
  );
  t.ok(writes.some((write) => write.value.type === 'RUN_SUCCEEDED'));
});

t.test('runExtraction records provider failures and rethrows them', async (t) => {
  const writes: Array<{ key: string; value: any }> = [];
  const providerError = new Error('try again');
  providerError.name = 'Textract.ThrottlingException';

  await t.rejects(
    runExtraction(
      { source },
      dependencies(writes, async () => {
        throw providerError;
      }),
    ),
    { name: 'Textract.ThrottlingException' },
  );

  t.ok(writes.some((write) => write.key.endsWith('/textract/request.json')));
  t.ok(
    writes.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.status === 'FAILED',
    ),
  );
  t.ok(writes.some((write) => write.value.type === 'RUN_FAILED'));
});

t.test('runExtraction refuses a source whose bytes do not match its hash', async (t) => {
  const writes: Array<{ key: string; value: any }> = [];
  await t.rejects(
    runExtraction(
      { source: { ...source, sha256: 'different' } },
      dependencies(writes, async () => {
        throw new Error('provider must not be called');
      }),
    ),
    { name: 'SourceHashMismatchError' },
  );
  t.ok(
    writes.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.error.name === 'SourceHashMismatchError',
    ),
  );
});
