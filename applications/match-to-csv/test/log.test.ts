import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { log, type LogLevel } from '../src/lib/log';

// Keyed by LogLevel so the compiler fails here when a level is added.
const LEVELS = Object.keys({
  TRACE: true,
  DEBUG: true,
  INFO: true,
  WARN: true,
  ERROR: true,
} satisfies Record<LogLevel, true>) as LogLevel[];

// Every value Lambda sets in AWS_LAMBDA_LOG_LEVEL, with the levels it keeps.
const LAMBDA_LEVELS: Array<[string, LogLevel[]]> = [
  ['TRACE', ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR']],
  ['DEBUG', ['DEBUG', 'INFO', 'WARN', 'ERROR']],
  ['INFO', ['INFO', 'WARN', 'ERROR']],
  ['WARN', ['WARN', 'ERROR']],
  ['ERROR', ['ERROR']],
  ['FATAL', []],
];

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

test('records below each Lambda log level are dropped', (t) => {
  for (const [threshold, expected] of LAMBDA_LEVELS) {
    assert.deepEqual(
      written(t, { AWS_LAMBDA_LOG_LEVEL: threshold }).map(({ level }) => level),
      expected,
      threshold,
    );
  }
});

test('FATAL drops every log level', (t) => {
  assert.deepEqual(written(t, { AWS_LAMBDA_LOG_LEVEL: 'FATAL' }), []);
});

test('AWS_LAMBDA_LOG_LEVEL is read case-insensitively', (t) => {
  for (const [threshold, expected] of LAMBDA_LEVELS) {
    const mixed = threshold.charAt(0) + threshold.slice(1).toLowerCase();
    for (const value of [threshold.toLowerCase(), mixed]) {
      assert.deepEqual(
        written(t, { AWS_LAMBDA_LOG_LEVEL: value }).map(({ level }) => level),
        expected,
        value,
      );
    }
  }
});

test('an unset, empty, or unknown AWS_LAMBDA_LOG_LEVEL means INFO', (t) => {
  const environments: NodeJS.ProcessEnv[] = [
    {},
    { AWS_LAMBDA_LOG_LEVEL: undefined },
    { AWS_LAMBDA_LOG_LEVEL: '' },
    { AWS_LAMBDA_LOG_LEVEL: '   ' },
    { AWS_LAMBDA_LOG_LEVEL: 'VERBOSE' },
    { AWS_LAMBDA_LOG_LEVEL: 'WARNING' },
    { AWS_LAMBDA_LOG_LEVEL: 'OFF' },
    { AWS_LAMBDA_LOG_LEVEL: '3' },
  ];
  for (const environment of environments) {
    assert.deepEqual(
      written(t, environment).map(({ level }) => level),
      ['INFO', 'WARN', 'ERROR'],
      JSON.stringify(environment),
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
