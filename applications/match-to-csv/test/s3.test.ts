import assert from 'node:assert/strict';
import { test } from 'node:test';
import { namespacedObjectKey, processingRunPrefix } from '../src/lib/s3';

test('namespacedObjectKey keeps stable deployment keys unchanged', () => {
  delete process.env.OBJECT_PREFIX;
  assert.equal(
    namespacedObjectKey('matches/123/summary.csv'),
    'matches/123/summary.csv',
  );
});

test('namespacedObjectKey isolates personal deployment artifacts', () => {
  process.env.OBJECT_PREFIX = 'ephemeral/tester';
  assert.equal(
    namespacedObjectKey('matches/123/summary.csv'),
    'ephemeral/tester/matches/123/summary.csv',
  );
  delete process.env.OBJECT_PREFIX;
});

test('processingRunPrefix follows the stored source key namespace', () => {
  assert.equal(
    processingRunPrefix(
      {
        screenshotId: 'screen',
        submissionId: 'submission',
        bucket: 'evidence',
        key: 'ephemeral/tester/submissions/submission/screenshots/screen/source/original',
        attachmentName: 'image.png',
        contentType: 'image/png',
        sha256: 'hash',
        acquisitionType: 'SCREENSHOT',
        widthPx: 1920,
        heightPx: 1080,
      },
      'run',
    ),
    'ephemeral/tester/submissions/submission/screenshots/screen/runs/run',
  );
});
