export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';

/**
 * Severity of each level Lambda accepts in `AWS_LAMBDA_LOG_LEVEL`. `FATAL` is
 * a valid threshold even though this module never writes at that level.
 */
const LEVEL_SEVERITY: Record<LogLevel | 'FATAL', number> = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  FATAL: 5,
};

const DEFAULT_LEVEL = 'INFO';

/**
 * The lowest severity written, from `AWS_LAMBDA_LOG_LEVEL`, which Lambda sets
 * from the function's application log level. An unset or unknown value means
 * `INFO`.
 */
function thresholdSeverity(environment: NodeJS.ProcessEnv): number {
  const configured = environment.AWS_LAMBDA_LOG_LEVEL?.trim().toUpperCase();
  return configured !== undefined && Object.hasOwn(LEVEL_SEVERITY, configured)
    ? LEVEL_SEVERITY[configured as keyof typeof LEVEL_SEVERITY]
    : LEVEL_SEVERITY[DEFAULT_LEVEL];
}

/**
 * Writes one JSON record per line straight to stdout, or nothing when `level`
 * is below `AWS_LAMBDA_LOG_LEVEL`. Under the JSON log format the Lambda
 * runtime wraps `console.log` output in its own record at `INFO`, with the
 * line as a string in `message`, where Logs Insights cannot query the
 * record's fields. Under the text log format it prefixes the line with a
 * timestamp and request ID. A direct stdout write reaches CloudWatch as
 * written under both formats. Under the JSON format Lambda reads the record's
 * level from `level` only when `timestamp` is a valid RFC 3339 time, and
 * otherwise treats the record as `INFO`, so every record carries one.
 */
export function log(
  level: LogLevel,
  message: string,
  details: Record<string, unknown> = {},
  write: (line: string) => void = (line) => process.stdout.write(line),
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (LEVEL_SEVERITY[level] < thresholdSeverity(environment)) return;
  const timestamp = new Date().toISOString();
  write(`${JSON.stringify({ level, message, ...details, timestamp })}\n`);
}
