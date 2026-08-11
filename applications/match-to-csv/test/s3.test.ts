import t from 'tap';
import {
  namespacedObjectKey,
  processingRunPrefix,
} from '../src/lib/s3';

t.test('namespacedObjectKey keeps stable deployment keys unchanged', (t) => {
  delete process.env.OBJECT_PREFIX;
  t.equal(namespacedObjectKey('matches/123/summary.csv'), 'matches/123/summary.csv');
  t.end();
});

t.test('namespacedObjectKey isolates personal deployment artifacts', (t) => {
  process.env.OBJECT_PREFIX = 'ephemeral/tester';
  t.equal(
    namespacedObjectKey('matches/123/summary.csv'),
    'ephemeral/tester/matches/123/summary.csv',
  );
  delete process.env.OBJECT_PREFIX;
  t.end();
});

t.test('processingRunPrefix follows the stored source key namespace', (t) => {
  t.equal(
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
  t.end();
});
