import t from 'tap';
import { version as lockedEsbuild } from 'esbuild/package.json';
import {
  bundlingOptions,
  checkLocalEsbuild,
  localEsbuildVersion,
} from '../cdk/lib/bundling';

t.test('Docker bundling installs the locked esbuild', (t) => {
  for (const includeSharp of [true, false]) {
    t.equal(bundlingOptions(includeSharp, true).esbuildVersion, lockedEsbuild);
  }
  t.end();
});

t.test(
  'only Sharp functions force Docker bundling, and only when bundling',
  (t) => {
    t.same(bundlingOptions(true, true).nodeModules, ['sharp']);
    t.equal(bundlingOptions(true, true).forceDockerBundling, true);
    t.equal(bundlingOptions(true, false).forceDockerBundling, false);
    t.equal(bundlingOptions(false, true).forceDockerBundling, false);
    t.equal(bundlingOptions(false, true).nodeModules, undefined);
    t.end();
  },
);

t.test('local bundling under npm scripts finds the locked esbuild', (t) => {
  t.equal(localEsbuildVersion(), lockedEsbuild);
  t.end();
});

t.test(
  'synthesis fails when local esbuild differs from the locked version',
  (t) => {
    t.doesNotThrow(() => checkLocalEsbuild(lockedEsbuild));
    t.doesNotThrow(() => checkLocalEsbuild(undefined));
    t.throws(
      () => checkLocalEsbuild('0.21.5'),
      /Local esbuild 0\.21\.5 differs/,
    );
    t.end();
  },
);
