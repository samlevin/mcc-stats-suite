import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtractTextOutput } from '@mcc/contracts';
import { writeExtractedCsv } from '../src/lambdas/write-extracted-csv';

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
  rows: [
    {
      team: 'Red',
      player: 'Spartan',
      score: '10',
      kills: '5',
      assists: '2',
      deaths: '1',
      win: 1,
      loss: 0,
    },
  ],
  normalizedArtifact: {
    bucket: 'evidence',
    key: 'submissions/submission-1/screenshots/screen-1/runs/run-1/normalized/observations.json',
  },
};

test('export writes the CSV and structured table under the run', async () => {
  const writes: Array<{ key: string; contentType: string }> = [];
  const result = await writeExtractedCsv(event, {
    async putObject(_bucket, key, _body, contentType) {
      writes.push({ key, contentType });
    },
  });

  assert.equal(result.rowCount, 1);
  assert.deepEqual(writes.map(({ key }) => key).sort(), [
    'submissions/submission-1/screenshots/screen-1/runs/run-1/export/extracted-table.json',
    'submissions/submission-1/screenshots/screen-1/runs/run-1/export/extracted.csv',
  ]);
});

test('export resumes when one immutable artifact already exists', async () => {
  let collisionReported = false;
  const result = await writeExtractedCsv(event, {
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
      async putObject() {
        throw new Error('storage unavailable');
      },
    }),
    /storage unavailable/,
  );
});
