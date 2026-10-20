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
 * Writes one self-formatted JSON line, or nothing when `level` is below
 * `AWS_LAMBDA_LOG_LEVEL`.
 */
export function log(
  level: LogLevel,
  message: string,
  details: Record<string, unknown> = {},
  environment: NodeJS.ProcessEnv = process.env,
): void {
  if (LEVEL_SEVERITY[level] < thresholdSeverity(environment)) return;
  console.log(JSON.stringify({ level, message, ...details }));
}
