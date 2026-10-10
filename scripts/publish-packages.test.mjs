import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { publishSharedPackages } from './publish-packages.mjs';

const registry = 'https://npm.pkg.github.com';
const root = resolve(import.meta.dirname, '..');
const readJson = (path) =>
  JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const missing = () =>
  Object.assign(new Error('missing'), {
    stdout: JSON.stringify({ error: { code: 'E404' } }),
  });

test('publishes missing shared versions to GitHub Packages', () => {
  const calls = [];
  publishSharedPackages((command, args) => {
    calls.push([command, ...args]);
    if (args[0] === 'view') throw missing();
  });
  assert.equal(calls.length, 4);
  for (const [index, workspace] of ['contracts', 'cdk-config'].entries()) {
    const { name, version } = readJson(`packages/${workspace}/package.json`);
    assert.deepEqual(calls[index * 2], [
      'npm',
      'view',
      `${name}@${version}`,
      'version',
      '--json',
      '--registry',
      registry,
    ]);
    assert.deepEqual(calls[index * 2 + 1], [
      'npm',
      'publish',
      '--workspace',
      `packages/${workspace}`,
      '--registry',
      registry,
    ]);
  }
});

test('does not republish existing immutable versions', () => {
  let reads = 0;
  publishSharedPackages((_command, args) => {
    assert.equal(args[0], 'view');
    reads++;
  });
  assert.equal(reads, 2);
});

for (const code of ['E401', 'E403', 'ETIMEDOUT']) {
  test(`fails without publishing on ${code}`, () => {
    const failure = Object.assign(new Error(code), {
      stdout: JSON.stringify({ error: { code } }),
    });
    assert.throws(
      () =>
        publishSharedPackages(() => {
          throw failure;
        }),
      (error) => error === failure,
    );
  });
}

test('fails without publishing on invalid registry output', () => {
  const failure = Object.assign(new Error('network'), { stdout: 'not JSON' });
  assert.throws(
    () =>
      publishSharedPackages(() => {
        throw failure;
      }),
    (error) => error === failure,
  );
});

test('propagates publication failures', () => {
  const failure = new Error('publish failed');
  assert.throws(
    () =>
      publishSharedPackages((_command, args) => {
        if (args[0] === 'view') throw missing();
        throw failure;
      }),
    (error) => error === failure,
  );
});

test('release configuration preserves coordinated local dependency versions', () => {
  const config = readJson('release-please-config.json');
  assert.equal(config['separate-pull-requests'], false);
  assert.match(
    readFileSync(resolve(root, '.npmrc'), 'utf8'),
    /^@samlevin:registry=https:\/\/npm\.pkg\.github\.com\s*$/,
  );
  for (const workspace of ['contracts', 'cdk-config']) {
    const pkg = readJson(`packages/${workspace}/package.json`);
    assert.equal(pkg.name, `@samlevin/${workspace}`);
    assert.notEqual(pkg.private, true);
    assert.equal(pkg.publishConfig.registry, registry);
    assert.deepEqual(pkg.files, ['dist']);
    if (workspace === 'cdk-config') assert.ok(pkg.dependencies['@types/node']);
    assert.equal(
      pkg.repository.url,
      'https://github.com/samlevin/mcc-stats-suite.git',
    );
  }
});
