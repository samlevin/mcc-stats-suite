import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { log, type LogLevel } from '../src/lib/log';

const LEVELS: LogLevel[] = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR'];

function written(
  t: TestContext,
  environment: NodeJS.ProcessEnv,
): Array<{ level: string; message: string; key?: string }> {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  for (const level of LEVELS) {
    log(level, `${level} message`, { key: 'value' }, environment);
  }
  t.mock.restoreAll();
  return lines.map(
    (line) => JSON.parse(line) as { level: string; message: string },
  );
}

test('log writes one JSON line per record with its details', (t) => {
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  log('WARN', 'Something happened', { count: 2 }, {});
  t.mock.restoreAll();
  assert.deepEqual(lines, [
    JSON.stringify({ level: 'WARN', message: 'Something happened', count: 2 }),
  ]);
});

test('INFO is the default threshold', (t) => {
  for (const environment of [
    {},
    { AWS_LAMBDA_LOG_LEVEL: '' },
    { AWS_LAMBDA_LOG_LEVEL: 'VERBOSE' },
  ]) {
    assert.deepEqual(
      written(t, environment).map(({ level }) => level),
      ['INFO', 'WARN', 'ERROR'],
    );
  }
});

test('records below AWS_LAMBDA_LOG_LEVEL are dropped', (t) => {
  const cases: Array<[string, LogLevel[]]> = [
    ['TRACE', ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR']],
    ['DEBUG', ['DEBUG', 'INFO', 'WARN', 'ERROR']],
    ['INFO', ['INFO', 'WARN', 'ERROR']],
    ['WARN', ['WARN', 'ERROR']],
    ['error', ['ERROR']],
    ['FATAL', []],
  ];
  for (const [threshold, expected] of cases) {
    assert.deepEqual(
      written(t, { AWS_LAMBDA_LOG_LEVEL: threshold }).map(({ level }) => level),
      expected,
      threshold,
    );
  }
});

test('log reads AWS_LAMBDA_LOG_LEVEL from the process environment by default', (t) => {
  const previous = process.env.AWS_LAMBDA_LOG_LEVEL;
  process.env.AWS_LAMBDA_LOG_LEVEL = 'ERROR';
  t.after(() => {
    if (previous === undefined) delete process.env.AWS_LAMBDA_LOG_LEVEL;
    else process.env.AWS_LAMBDA_LOG_LEVEL = previous;
  });
  const lines: string[] = [];
  t.mock.method(console, 'log', (line: string) => lines.push(line));
  log('INFO', 'dropped');
  log('ERROR', 'kept');
  t.mock.restoreAll();
  assert.deepEqual(
    lines.map((line) => (JSON.parse(line) as { message: string }).message),
    ['kept'],
  );
});
