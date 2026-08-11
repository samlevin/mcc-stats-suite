import t from 'tap';
import { compareNormalizedRuns } from '../src/lambdas/compare-runs';

t.test('comparison reports only changed physical cells', (t) => {
  const baseline = { runId: 'before', cells: [{ tableLocation: { rowIndex: 2, columnIndex: 1 }, observedText: 'I9', confidence: 91 }, { tableLocation: { rowIndex: 2, columnIndex: 2 }, observedText: 'Spartan', confidence: 99 }] };
  const candidate = { runId: 'after', cells: [{ tableLocation: { rowIndex: 2, columnIndex: 1 }, observedText: '19', confidence: 99 }, { tableLocation: { rowIndex: 2, columnIndex: 2 }, observedText: 'Spartan', confidence: 99 }] };
  const result = compareNormalizedRuns(baseline, candidate);
  t.equal(result.summary.changedCellCount, 1);
  t.same(result.changes[0], { coordinate: '0:2:1', before: 'I9', after: '19', beforeConfidence: 91, afterConfidence: 99 });
  t.end();
});

t.test('comparison distinguishes tables and reports confidence-only changes', (t) => {
  const baseline = { runId: 'before', cells: [
    { tableLocation: { tableIndex: 0, rowIndex: 2, columnIndex: 1 }, observedText: '19', confidence: 90 },
    { tableLocation: { tableIndex: 1, rowIndex: 2, columnIndex: 1 }, observedText: '20', confidence: 99 },
  ] };
  const candidate = { runId: 'after', cells: [
    { tableLocation: { tableIndex: 0, rowIndex: 2, columnIndex: 1 }, observedText: '19', confidence: 95 },
    { tableLocation: { tableIndex: 1, rowIndex: 2, columnIndex: 1 }, observedText: '21', confidence: 99 },
  ] };
  const result = compareNormalizedRuns(baseline, candidate);
  t.equal(result.summary.changedCellCount, 2);
  t.same(result.changes.map((change: { coordinate: string }) => change.coordinate).sort(), ['0:2:1', '1:2:1']);
  t.end();
});

t.test('comparison reports added and removed cells', (t) => {
  const result = compareNormalizedRuns(
    { runId: 'before', cells: [{ tableLocation: { tableIndex: 0, rowIndex: 2, columnIndex: 1 }, observedText: 'old', confidence: 90 }] },
    { runId: 'after', cells: [{ tableLocation: { tableIndex: 0, rowIndex: 3, columnIndex: 1 }, observedText: 'new', confidence: 91 }] },
  );
  t.equal(result.summary.changedCellCount, 2);
  t.end();
});
