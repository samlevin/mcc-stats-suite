import assert from 'node:assert/strict';
import test from 'node:test';
import { planLabelSync } from './labels-sync.mjs';

const bug = { name: 'bug', color: 'd73a4a', description: 'Broken' };

test('creates labels missing from the repository', () => {
  const plan = planLabelSync([bug], []);
  assert.deepEqual(plan.create, [bug]);
  assert.deepEqual([plan.update, plan.delete, plan.unchanged], [[], [], []]);
});

test('updates changed description, ignoring color and name case', () => {
  const docs = { name: 'Docs', color: 'ABCDEF', description: 'D' };
  const plan = planLabelSync(
    [bug, docs],
    [
      { ...bug, description: 'Old' },
      { name: 'docs', color: 'abcdef', description: 'D' },
    ],
  );
  assert.deepEqual(plan.update, [{ ...bug, current: 'bug' }]);
  assert.deepEqual(plan.unchanged, [docs]);
  assert.deepEqual(plan.create, []);
});

test('updates a changed color', () => {
  const plan = planLabelSync([bug], [{ ...bug, color: '000000' }]);
  assert.deepEqual(plan.update, [{ ...bug, current: 'bug' }]);
});

test('treats a missing live description as empty', () => {
  const wanted = { name: 'x', color: 'ffffff', description: '' };
  const plan = planLabelSync(
    [wanted],
    [{ name: 'x', color: 'ffffff', description: null }],
  );
  assert.deepEqual(plan.unchanged, [wanted]);
});

test('lists file-absent labels for deletion but never autorelease: pending', () => {
  const plan = planLabelSync(
    [bug],
    [
      bug,
      { name: 'type: task', color: '000000' },
      { name: 'autorelease: pending', color: 'ededed' },
    ],
  );
  assert.deepEqual(
    plan.delete.map((label) => label.name),
    ['type: task'],
  );
  assert.deepEqual(plan.unchanged, [bug]);
});
