import t from 'tap';
import {
  manifestKeyForNormalized,
  materializeExamples,
  splitForScreenshot,
} from '../src/lambdas/materialize-training-data';

t.test('dataset splits are stable and depend only on screenshot identity and seed', (t) => {
  const first = splitForScreenshot('screenshot-1', 'seed');
  t.equal(splitForScreenshot('screenshot-1', 'seed'), first);
  t.equal(splitForScreenshot('screenshot-1', 'seed'), first, 'replayed runs cannot cross partitions');
  t.ok(['TRAIN', 'VALIDATION', 'TEST'].includes(first));
  t.end();
});

t.test('dataset splitter uses all three partitions over a representative population', (t) => {
  const counts = { TRAIN: 0, VALIDATION: 0, TEST: 0 };
  for (let index = 0; index < 2_000; index += 1) {
    counts[splitForScreenshot(`screenshot-${index}`, 'seed')] += 1;
  }
  t.ok(counts.TRAIN > 1_400 && counts.TRAIN < 1_800);
  t.ok(counts.VALIDATION > 100 && counts.VALIDATION < 300);
  t.ok(counts.TEST > 100 && counts.TEST < 300);
  t.end();
});

t.test('materializer joins cells, tokens, validation, versions, and source provenance', (t) => {
  const examples = materializeExamples(
    'dataset-1',
    'TRAIN',
    { bucket: 'evidence', key: 'run/normalized/observations.json' },
    {
      schemaVersion: 'normalized-ocr/v2',
      runId: 'run-1',
      screenshotId: 'screenshot-1',
      cells: [{
        cellObservationId: 'cell-1',
        screenshotId: 'screenshot-1',
        observedText: '19',
        tokenObservationIds: ['token-1'],
      }],
      tokens: [{ tokenObservationId: 'token-1', text: '19' }],
      validation: [{ cellObservationId: 'cell-1', valid: true }],
    },
    {
      versions: { pipelineVersion: '1.0.0' },
      build: { gitSha: 'commit' },
      inputArtifact: { sha256: 'source-hash' },
    },
  );

  t.equal(examples.length, 1);
  t.equal(examples[0].labelStatus, 'UNLABELED');
  t.equal(examples[0].tokens[0].text, '19');
  t.equal(examples[0].validation?.valid, true);
  t.equal(examples[0].processingVersions?.pipelineVersion, '1.0.0');
  t.equal(examples[0].sourceArtifact?.sha256, 'source-hash');
  t.end();
});

t.test('manifest path is derived from a normalized run artifact', (t) => {
  t.equal(
    manifestKeyForNormalized('runs/1/normalized/observations.json'),
    'runs/1/manifest.json',
  );
  t.throws(() => manifestKeyForNormalized('runs/1/other.json'));
  t.end();
});
