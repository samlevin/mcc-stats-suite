import { mock } from 'node:test';

/**
 * Captures the records `log()` writes to stdout, one string per record
 * without its newline. Every other write, such as the test runner's own
 * output, still reaches stdout. Call `restore` when the test ends.
 */
export function captureLogLines(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout) as (
    ...args: unknown[]
  ) => boolean;
  const mocked = mock.method(
    process.stdout,
    'write',
    (chunk: unknown, ...rest: unknown[]): boolean => {
      if (typeof chunk === 'string' && chunk.startsWith('{"level":')) {
        lines.push(chunk.replace(/\n$/, ''));
        return true;
      }
      return write(chunk, ...rest);
    },
  );
  return { lines, restore: () => mocked.mock.restore() };
}

/** A parsed `log()` record without the `timestamp` that changes per call. */
export function withoutTimestamp(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const copy = { ...record };
  delete copy.timestamp;
  return copy;
}
