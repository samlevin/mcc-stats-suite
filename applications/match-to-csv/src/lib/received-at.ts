const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Returns `receivedAt` from the workflow input when it is an ISO 8601
 * timestamp, such as the `$.time` of the S3 event. The value is untrusted, so
 * anything else is dropped rather than copied into evidence or rejected.
 */
export function readReceivedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) return undefined;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const calendarDate =
    date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return calendarDate && Number.isFinite(Date.parse(value)) ? value : undefined;
}
