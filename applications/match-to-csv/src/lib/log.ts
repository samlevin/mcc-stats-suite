export type LogLevel = 'ERROR' | 'WARN' | 'INFO' | 'DEBUG' | 'TRACE';

export function log(
  level: LogLevel,
  message: string,
  details: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, message, ...details }));
}
