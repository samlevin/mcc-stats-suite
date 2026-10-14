import assert from 'node:assert/strict';
import { test } from 'node:test';
import { version as lockedEsbuild } from 'esbuild/package.json';
import {
  BUNDLING_IMAGE,
  bundlingOptions,
  bundlingRuntime,
  checkLocalEsbuild,
  localEsbuildVersion,
} from '../cdk/lib/bundling';

test('Docker bundling installs the locked esbuild', () => {
  for (const includeSharp of [true, false]) {
    assert.equal(
      bundlingOptions(includeSharp, true).esbuildVersion,
      lockedEsbuild,
    );
  }
});

test('only Sharp functions force Docker bundling, and only when bundling', () => {
  assert.deepEqual(bundlingOptions(true, true).nodeModules, ['sharp']);
  assert.equal(bundlingOptions(true, true).forceDockerBundling, true);
  assert.equal(bundlingOptions(true, false).forceDockerBundling, false);
  assert.equal(bundlingOptions(false, true).forceDockerBundling, false);
  assert.equal(bundlingOptions(false, true).nodeModules, undefined);
});

test('local bundling under npm scripts finds the locked esbuild', () => {
  assert.equal(localEsbuildVersion(), lockedEsbuild);
});

test('synthesis fails when local esbuild differs from the locked version', () => {
  assert.doesNotThrow(() => checkLocalEsbuild(lockedEsbuild));
  assert.doesNotThrow(() => checkLocalEsbuild(undefined));
  assert.throws(
    () => checkLocalEsbuild('0.21.5'),
    /Local esbuild 0\.21\.5 differs/,
  );
});

test('the bundling image is pinned by digest on the Node.js 22 runtime', () => {
  assert.match(
    BUNDLING_IMAGE,
    /^public\.ecr\.aws\/sam\/build-nodejs22\.x@sha256:[0-9a-f]{64}$/,
  );
  assert.equal(bundlingRuntime.name, 'nodejs22.x');
  assert.equal(bundlingRuntime.bundlingImage.image, BUNDLING_IMAGE);
});
