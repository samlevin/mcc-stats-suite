import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  manifestKeyForNormalized,
  materializeExamples,
  splitForScreenshot,
} from '../src/lambdas/materialize-training-data';

test('dataset splits are stable and depend only on screenshot identity and seed', () => {
  const first = splitForScreenshot('screenshot-1', 'seed');
  assert.equal(splitForScreenshot('screenshot-1', 'seed'), first);
  assert.equal(
    splitForScreenshot('screenshot-1', 'seed'),
    first,
    'replayed runs cannot cross partitions',
  );
  assert.ok(['TRAIN', 'VALIDATION', 'TEST'].includes(first));
});

test('dataset splitter uses all three partitions over a representative population', () => {
  const counts = { TRAIN: 0, VALIDATION: 0, TEST: 0 };
  for (let index = 0; index < 2_000; index += 1) {
    counts[splitForScreenshot(`screenshot-${index}`, 'seed')] += 1;
  }
  assert.ok(counts.TRAIN > 1_400 && counts.TRAIN < 1_800);
  assert.ok(counts.VALIDATION > 100 && counts.VALIDATION < 300);
  assert.ok(counts.TEST > 100 && counts.TEST < 300);
});

test('materializer joins cells, tokens, validation, versions, and source provenance', () => {
  const examples = materializeExamples(
    'dataset-1',
    'TRAIN',
    { bucket: 'evidence', key: 'run/normalized/observations.json' },
    {
      schemaVersion: 'normalized-ocr/v2',
      runId: 'run-1',
      screenshotId: 'screenshot-1',
      cells: [
        {
          cellObservationId: 'cell-1',
          screenshotId: 'screenshot-1',
          observedText: '19',
          tokenObservationIds: ['token-1'],
        },
      ],
      tokens: [{ tokenObservationId: 'token-1', text: '19' }],
      validation: [{ cellObservationId: 'cell-1', valid: true }],
    },
    {
      versions: { pipelineVersion: '1.0.0' },
      build: { gitSha: 'commit' },
      inputArtifact: { sha256: 'source-hash' },
    },
  );

  assert.equal(examples.length, 1);
  assert.equal(examples[0].labelStatus, 'UNLABELED');
  assert.equal(examples[0].tokens[0].text, '19');
  assert.equal(examples[0].validation?.valid, true);
  assert.equal(examples[0].processingVersions?.pipelineVersion, '1.0.0');
  assert.equal(examples[0].sourceArtifact?.sha256, 'source-hash');
});

test('manifest path is derived from a normalized run artifact', () => {
  assert.equal(
    manifestKeyForNormalized('runs/1/normalized/observations.json'),
    'runs/1/manifest.json',
  );
  assert.throws(() => manifestKeyForNormalized('runs/1/other.json'));
});
