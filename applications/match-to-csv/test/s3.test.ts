import t from 'tap';
import { namespacedObjectKey } from '../src/lib/s3';

t.test('namespacedObjectKey keeps shared deployment keys unchanged', (t) => {
  delete process.env.OBJECT_PREFIX;
  t.equal(namespacedObjectKey('matches/123/summary.csv'), 'matches/123/summary.csv');
  t.end();
});

t.test('namespacedObjectKey isolates personal deployment artifacts', (t) => {
  process.env.OBJECT_PREFIX = 'instances/sam';
  t.equal(
    namespacedObjectKey('matches/123/summary.csv'),
    'instances/sam/matches/123/summary.csv',
  );
  delete process.env.OBJECT_PREFIX;
  t.end();
});
