import assert from 'node:assert/strict';
import { test } from 'node:test';
import { log, type LogLevel } from '../src/lib/log';
import { captureLogLines } from './support/log-lines';

test('log writes one JSON line with every field at the top level', () => {
  const lines: string[] = [];
  log(
    'INFO',
    'Screenshot processed',
    { submissionId: 'submission-1', runId: 'run-1', rowCount: 8 },
    (line) => lines.push(line),
  );

  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  assert.equal(lines[0].indexOf('\n'), lines[0].length - 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    level: 'INFO',
    message: 'Screenshot processed',
    submissionId: 'submission-1',
    runId: 'run-1',
    rowCount: 8,
  });
});

test('log keeps the level of each record', () => {
  const lines: string[] = [];
  for (const level of ['ERROR', 'WARN', 'INFO', 'DEBUG', 'TRACE'] as const) {
    log(level, `${level} message`, {}, (line) => lines.push(line), {
      AWS_LAMBDA_LOG_LEVEL: 'TRACE',
    });
  }

  assert.deepEqual(
    lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    [
      { level: 'ERROR', message: 'ERROR message' },
      { level: 'WARN', message: 'WARN message' },
      { level: 'INFO', message: 'INFO message' },
      { level: 'DEBUG', message: 'DEBUG message' },
      { level: 'TRACE', message: 'TRACE message' },
    ],
  );
});

test('log writes straight to stdout, never through console.log', (t) => {
  const consoleLines: unknown[] = [];
  t.mock.method(console, 'log', (...args: unknown[]) =>
    consoleLines.push(args),
  );
  const captured = captureLogLines();
  try {
    log('ERROR', 'Unable to record processing failure', {
      submissionId: 'submission-1',
      error: 'AccessDenied',
    });
  } finally {
    captured.restore();
  }

  assert.deepEqual(consoleLines, []);
  assert.deepEqual(captured.lines, [
    JSON.stringify({
      level: 'ERROR',
      message: 'Unable to record processing failure',
      submissionId: 'submission-1',
      error: 'AccessDenied',
    }),
  ]);
});

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
  environment: NodeJS.ProcessEnv,
): Array<{ level: string; message: string; key?: string }> {
  const lines: string[] = [];
  for (const level of LEVELS) {
    log(
      level,
      `${level} message`,
      { key: 'value' },
      (line) => lines.push(line),
      environment,
    );
  }
  return lines.map(
    (line) => JSON.parse(line) as { level: string; message: string },
  );
}

test('records below each Lambda log level are dropped', () => {
  for (const [threshold, expected] of LAMBDA_LEVELS) {
    assert.deepEqual(
      written({ AWS_LAMBDA_LOG_LEVEL: threshold }).map(({ level }) => level),
      expected,
      threshold,
    );
  }
});

test('FATAL drops every log level', () => {
  assert.deepEqual(written({ AWS_LAMBDA_LOG_LEVEL: 'FATAL' }), []);
});

test('AWS_LAMBDA_LOG_LEVEL is read case-insensitively', () => {
  for (const [threshold, expected] of LAMBDA_LEVELS) {
    const mixed = threshold.charAt(0) + threshold.slice(1).toLowerCase();
    for (const value of [threshold.toLowerCase(), mixed]) {
      assert.deepEqual(
        written({ AWS_LAMBDA_LOG_LEVEL: value }).map(({ level }) => level),
        expected,
        value,
      );
    }
  }
});

test('an unset, empty, or unknown AWS_LAMBDA_LOG_LEVEL means INFO', () => {
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
      written(environment).map(({ level }) => level),
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
  const captured = captureLogLines();
  try {
    log('INFO', 'dropped');
    log('ERROR', 'kept');
  } finally {
    captured.restore();
  }
  assert.deepEqual(
    captured.lines.map(
      (line) => (JSON.parse(line) as { message: string }).message,
    ),
    ['kept'],
  );
});
