import t from 'tap';
import { compareNormalizedRuns } from '../src/lambdas/compare-runs';

t.test('comparison reports only changed physical cells', (t) => {
  const baseline = { runId: 'before', cells: [{ tableLocation: { rowIndex: 2, columnIndex: 1 }, observedText: 'I9', confidence: 91 }, { tableLocation: { rowIndex: 2, columnIndex: 2 }, observedText: 'Spartan', confidence: 99 }] };
  const candidate = { runId: 'after', cells: [{ tableLocation: { rowIndex: 2, columnIndex: 1 }, observedText: '19', confidence: 99 }, { tableLocation: { rowIndex: 2, columnIndex: 2 }, observedText: 'Spartan', confidence: 99 }] };
  const result = compareNormalizedRuns(baseline, candidate);
  t.equal(result.summary.changedCellCount, 1);
  t.same(result.changes[0], { coordinate: '2:1', before: 'I9', after: '19', beforeConfidence: 91, afterConfidence: 99 });
  t.end();
});
