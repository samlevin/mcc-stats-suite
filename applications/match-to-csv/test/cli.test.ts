import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = (name: string): string =>
  path.resolve(__dirname, `../scripts/${name}.ts`);
function run(name: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', script(name), ...args],
    {
      encoding: 'utf8',
      env: { PATH: '/nonexistent' },
    },
  );
}

test('fixture utility help and invalid input cause no output-directory or fixture writes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-fixture-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'output');
  for (const name of ['capture-textract', 'reduce-capture']) {
    for (const flag of ['-h', '--help']) {
      const result = run(name, [flag]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Usage:/);
      assert.equal(result.stderr, '');
    }
    const unknown = run(name, ['--unknown', output]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown option --unknown/);
    assert.equal(fs.existsSync(output), false);
  }
  for (const args of [
    ['--capture'],
    [
      '--capture=missing',
      '--mapping=missing',
      '--name=x',
      '-o',
      output,
      '--output=other',
    ],
  ]) {
    const result = run('reduce-capture', args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires a value|more than once/);
    assert.equal(fs.existsSync(output), false);
  }
});

test('fixture reduction accepts equals values and its output alias', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-fixture-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const capture = path.join(directory, 'capture.json');
  const mapping = path.join(directory, 'mapping.json');
  const output = path.join(directory, 'fixture.json');
  fs.writeFileSync(
    capture,
    JSON.stringify({ rowColors: [], response: { Blocks: [] } }),
  );
  fs.writeFileSync(
    mapping,
    JSON.stringify({ names: { Original: 'Replacement' }, clanTags: {} }),
  );
  const result = run('reduce-capture', [
    `--capture=${capture}`,
    `--mapping=${mapping}`,
    '--name=--help',
    `-o=${output}`,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const fixture: unknown = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.deepEqual(fixture, {
    name: '--help',
    blocks: [],
    rowColors: [],
    expectedRows: [],
  });
});
