import type {
  AttachmentRejectionCode,
  PlayerMatchStatus,
  SubmissionRejectionCode,
  TraceContext,
} from '@mcc/contracts';
import { log } from './log';

/** CloudWatch namespace for the metrics the match-to-csv Lambdas publish. */
export const METRIC_NAMESPACE = 'MCC/MatchToCsv';
/** Dimension that scopes every metric to the Lambda function that emitted it. */
export const FUNCTION_NAME_DIMENSION = 'FunctionName';
/** Rows extracted from one screenshot. */
export const EXTRACTED_ROWS_METRIC = 'ExtractedRows';
/** 1 when a screenshot's extraction succeeded with no rows, otherwise 0. */
export const ZERO_ROW_EXTRACTIONS_METRIC = 'ZeroRowExtractions';

/** Dimension on every stage metric (spec 1.3 §7.1). */
export const STAGE_DIMENSION = 'Stage';
/** Dimension of `StageErrors`, the §7.3 class of the error name. */
export const ERROR_CLASS_DIMENSION = 'ErrorClass';
/** Dimension of the rejection breakdown records. */
export const REASON_DIMENSION = 'Reason';
/** Dimension of the `PlayerRows` breakdown records. */
export const MATCH_STATUS_DIMENSION = 'MatchStatus';
/** 1 on every `ERROR` stage event, by `Stage` and `ErrorClass`. */
export const STAGE_ERRORS_METRIC = 'StageErrors';

/** The `event` value every stage event carries and every query filters on. */
export const STAGE_EVENT = 'stage.completed';
/** The `event` value of a breakdown record. */
export const BREAKDOWN_EVENT = 'metric.breakdown';
/** The `schemaVersion` of a stage event. */
export const STAGE_EVENT_SCHEMA_VERSION = 'stage-event/v1';

export type Stage =
  'process-email' | 'extract' | 'write-csv' | 'write-gamertag-csvs';
export type StageOutcome = 'OK' | 'REJECTED' | 'ERROR';
export type ErrorClass =
  | 'TEXTRACT_THROTTLED'
  | 'TEXTRACT'
  | 'IMAGE'
  | 'ROSTER'
  | 'INTEGRITY'
  | 'CONFIGURATION'
  | 'STORAGE'
  | 'OTHER';

type MetricUnit = 'Count' | 'Milliseconds' | 'Percent';

/**
 * The §7.2 metrics a stage event carries under the `Stage` dimension, with
 * their units. `StageErrors` and the breakdown metrics are not listed:
 * `publishStageEvent` derives them.
 */
export const STAGE_METRIC_UNITS = {
  SubmissionsAccepted: 'Count',
  SubmissionsRejected: 'Count',
  ScreenshotsAccepted: 'Count',
  MatchDateReplyFailed: 'Count',
  TextractLatency: 'Milliseconds',
  OcrMeanConfidence: 'Percent',
  ReviewRequiredCells: 'Count',
  CsvWritten: 'Count',
  GamertagCsvsWritten: 'Count',
  SubmissionsCompleted: 'Count',
  EndToEndLatency: 'Milliseconds',
} as const satisfies Record<string, MetricUnit>;

export type StageMetricName = keyof typeof STAGE_METRIC_UNITS;

/** One invocation's stage event, before it becomes a record (spec 1.3 §10.1). */
export interface StageEvent {
  stage: Stage;
  outcome: StageOutcome;
  /** Handler wall-clock time. */
  durationMs: number;
  ids: { submissionId?: string; screenshotId?: string; runId?: string };
  /** The workflow's trace context, as received. Malformed fields are dropped. */
  trace?: TraceContext;
  /** `awsRequestId` from the Lambda context. */
  requestId?: string;
  /** The error's `name`, never its message. Written on `ERROR` events only. */
  errorName?: string;
  /**
   * The stage's other §6.1 fields, such as counts and codes. Keys that name a
   * field this module sets, a metric or a dimension are ignored.
   */
  properties: Record<string, string | number>;
  /** The stage's §7.2 metric values. A metric without a value is left out. */
  metrics: Partial<Record<StageMetricName, number>>;
  /**
   * Values written as breakdown records (§7.1 rule 4), one per distinct
   * rejection code and one per non-zero count. They also set the
   * `rejectionCodes` and `attachmentRejectionCodes` fields.
   */
  breakdowns?: {
    submissionRejectionReasons?: SubmissionRejectionCode[];
    attachmentRejectionReasons?: Partial<
      Record<AttachmentRejectionCode, number>
    >;
    playerRows?: Partial<Record<PlayerMatchStatus, number>>;
  };
}

/** What `stageEventRecord` reads besides the event itself. */
export interface StageEventContext {
  /**
   * Supplies `_X_AMZN_TRACE_ID`, `GIT_SHA`, `DEPLOYMENT_ENVIRONMENT` and
   * `EMF_METRICS_ENABLED`.
   */
  environment: NodeJS.ProcessEnv;
  /** EMF `Timestamp`, in epoch milliseconds. */
  timestamp: number;
}

const ERROR_CLASSES: Record<string, ErrorClass> = {
  ThrottlingException: 'TEXTRACT_THROTTLED',
  ProvisionedThroughputExceededException: 'TEXTRACT_THROTTLED',
  LimitExceededException: 'TEXTRACT_THROTTLED',
  InternalServerError: 'TEXTRACT',
  InvalidParameterException: 'TEXTRACT',
  BadDocumentException: 'TEXTRACT',
  UnsupportedDocumentException: 'TEXTRACT',
  DocumentTooLargeException: 'TEXTRACT',
  ImageTooLargeError: 'IMAGE',
  UnsupportedImageFormatError: 'IMAGE',
  RosterConfigurationError: 'ROSTER',
  RosterIntegrityError: 'ROSTER',
  RosterSnapshotMismatchError: 'ROSTER',
  RosterSnapshotConflictError: 'ROSTER',
  SourceHashMismatchError: 'INTEGRITY',
  NormalizedObservationsMismatchError: 'INTEGRITY',
  ExtractedTableMismatchError: 'INTEGRITY',
  InvalidGamertagError: 'INTEGRITY',
  InvalidGamertagExportInputError: 'INTEGRITY',
  ParameterNotFound: 'CONFIGURATION',
  AccessDeniedException: 'CONFIGURATION',
  StorageError: 'STORAGE',
  NoSuchKey: 'STORAGE',
  NoSuchBucket: 'STORAGE',
};

/**
 * The §7.3 class of an error name. A name the table does not list is
 * `OTHER`, so a new error never creates a new metric.
 */
export function errorClass(errorName: string): ErrorClass {
  return Object.hasOwn(ERROR_CLASSES, errorName)
    ? ERROR_CLASSES[errorName]
    : 'OTHER';
}

/**
 * Metrics are on unless `EMF_METRICS_ENABLED` is exactly `false`, which only
 * ephemeral stacks set. Functions deployed without the variable keep
 * publishing.
 */
export function metricsEnabled(environment: NodeJS.ProcessEnv): boolean {
  return environment.EMF_METRICS_ENABLED !== 'false';
}

/** Fields `stageEventRecord` sets itself, which `properties` cannot replace. */
const RESERVED_FIELDS = new Set<string>([
  '_aws',
  'event',
  'schemaVersion',
  STAGE_DIMENSION,
  'workflow',
  'outcome',
  'env',
  'gitSha',
  'submissionId',
  'screenshotId',
  'runId',
  'executionId',
  'retryCount',
  'xrayTraceId',
  'requestId',
  'durationMs',
  'errorName',
  ERROR_CLASS_DIMENSION,
  'rejectionCodes',
  'attachmentRejectionCodes',
  REASON_DIMENSION,
  MATCH_STATUS_DIMENSION,
  STAGE_ERRORS_METRIC,
  'SubmissionsRejected',
  'AttachmentsRejected',
  'PlayerRows',
  ...Object.keys(STAGE_METRIC_UNITS),
]);

const WORKFLOWS: ReadonlySet<unknown> = new Set(['INGEST', 'REPLAY']);
const XRAY_ROOT = /^1-[0-9a-f]{8}-[0-9a-f]{24}$/;

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The `Root=` value of `_X_AMZN_TRACE_ID`, when it is well formed. */
function xrayTraceId(header: string | undefined): string | undefined {
  const root = header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('Root='))
    ?.slice('Root='.length);
  return root !== undefined && XRAY_ROOT.test(root) ? root : undefined;
}

/**
 * The trace fields that are well formed. `trace` comes from the task payload,
 * which a direct invocation can set to anything.
 */
function traceFields(trace: unknown): Record<string, string | number> {
  if (typeof trace !== 'object' || trace === null) return {};
  const { executionId, retryCount, workflow } = trace as Record<
    string,
    unknown
  >;
  return {
    ...(WORKFLOWS.has(workflow) ? { workflow: workflow as string } : {}),
    ...(nonEmptyString(executionId) ? { executionId } : {}),
    ...(typeof retryCount === 'number' &&
    Number.isSafeInteger(retryCount) &&
    retryCount >= 0
      ? { retryCount }
      : {}),
  };
}

/** Distinct values, sorted and joined with `,`, or undefined when empty. */
function joinedCodes(codes: Iterable<string>): string | undefined {
  const sorted = [...new Set(codes)].sort();
  return sorted.length === 0 ? undefined : sorted.join(',');
}

/** Keys of a count map whose value is a positive finite number, sorted. */
function positiveEntries<K extends string>(
  counts: Partial<Record<K, number>> | undefined,
): Array<[K, number]> {
  return (Object.entries(counts ?? {}) as Array<[K, number | undefined]>)
    .filter(
      (entry): entry is [K, number] =>
        typeof entry[1] === 'number' &&
        Number.isFinite(entry[1]) &&
        entry[1] > 0,
    )
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** A non-empty string or a finite number. Anything else is omitted. */
function isValue(value: unknown): value is string | number {
  return (
    nonEmptyString(value) ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * Builds the §6 stage event record. Fields without a value are omitted. Unless
 * `EMF_METRICS_ENABLED` is `false`, it also carries the metric members and an
 * `_aws` block: the stage metrics in one directive with only `[["Stage"]]`,
 * and on an `ERROR` event `StageErrors` in a second directive with only
 * `[["Stage", "ErrorClass"]]`. A record with no metric value has no `_aws`
 * block.
 */
export function stageEventRecord(
  event: StageEvent,
  context: StageEventContext,
): Record<string, unknown> {
  const { environment } = context;
  const failed = event.outcome === 'ERROR';
  const errorName = nonEmptyString(event.errorName)
    ? event.errorName
    : undefined;
  const fields: Record<string, unknown> = {
    event: STAGE_EVENT,
    schemaVersion: STAGE_EVENT_SCHEMA_VERSION,
    [STAGE_DIMENSION]: event.stage,
    ...traceFields(event.trace),
    outcome: event.outcome,
    env: environment.DEPLOYMENT_ENVIRONMENT,
    gitSha: environment.GIT_SHA,
    submissionId: event.ids.submissionId,
    screenshotId: event.ids.screenshotId,
    runId: event.ids.runId,
    xrayTraceId: xrayTraceId(environment._X_AMZN_TRACE_ID),
    requestId: event.requestId,
    durationMs: event.durationMs,
    ...(failed
      ? {
          errorName,
          [ERROR_CLASS_DIMENSION]: errorClass(errorName ?? ''),
        }
      : {}),
    rejectionCodes: joinedCodes(
      event.breakdowns?.submissionRejectionReasons ?? [],
    ),
    attachmentRejectionCodes: joinedCodes(
      positiveEntries(event.breakdowns?.attachmentRejectionReasons).map(
        ([code]) => code,
      ),
    ),
  };
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (isValue(value)) record[key] = value;
  }
  for (const [key, value] of Object.entries(event.properties)) {
    if (!RESERVED_FIELDS.has(key) && isValue(value)) record[key] = value;
  }
  if (!metricsEnabled(environment)) return record;

  const directives: Array<Record<string, unknown>> = [];
  const members: Record<string, number> = {};
  const stageMetrics: Array<{ Name: string; Unit: MetricUnit }> = [];
  for (const name of Object.keys(STAGE_METRIC_UNITS) as StageMetricName[]) {
    const value = event.metrics[name];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    stageMetrics.push({ Name: name, Unit: STAGE_METRIC_UNITS[name] });
    members[name] = value;
  }
  if (stageMetrics.length > 0) {
    directives.push({
      Namespace: METRIC_NAMESPACE,
      Dimensions: [[STAGE_DIMENSION]],
      Metrics: stageMetrics,
    });
  }
  if (failed) {
    directives.push({
      Namespace: METRIC_NAMESPACE,
      Dimensions: [[STAGE_DIMENSION, ERROR_CLASS_DIMENSION]],
      Metrics: [{ Name: STAGE_ERRORS_METRIC, Unit: 'Count' }],
    });
    members[STAGE_ERRORS_METRIC] = 1;
  }
  if (directives.length === 0) return record;
  return {
    _aws: { Timestamp: context.timestamp, CloudWatchMetrics: directives },
    ...record,
    ...members,
  };
}

function breakdownRecord(
  stage: Stage,
  dimension: string,
  dimensionValue: string,
  metric: string,
  value: number,
  timestamp: number,
): Record<string, unknown> {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [[STAGE_DIMENSION, dimension]],
          Metrics: [{ Name: metric, Unit: 'Count' }],
        },
      ],
    },
    event: BREAKDOWN_EVENT,
    [STAGE_DIMENSION]: stage,
    [dimension]: dimensionValue,
    [metric]: value,
  };
}

/**
 * Builds the §7.1 breakdown records for an event: `SubmissionsRejected` once
 * per distinct rejection code, and `AttachmentsRejected` and `PlayerRows` once
 * per non-zero count. Each record holds only its metric, `Stage` and one
 * dimension value, never an ID.
 */
export function breakdownRecords(
  event: StageEvent,
  timestamp: number,
): Record<string, unknown>[] {
  const breakdowns = event.breakdowns ?? {};
  const submissionReasons = [
    ...new Set(breakdowns.submissionRejectionReasons ?? []),
  ].sort();
  return [
    ...submissionReasons.map((reason) =>
      breakdownRecord(
        event.stage,
        REASON_DIMENSION,
        reason,
        'SubmissionsRejected',
        1,
        timestamp,
      ),
    ),
    ...positiveEntries(breakdowns.attachmentRejectionReasons).map(
      ([reason, count]) =>
        breakdownRecord(
          event.stage,
          REASON_DIMENSION,
          reason,
          'AttachmentsRejected',
          count,
          timestamp,
        ),
    ),
    ...positiveEntries(breakdowns.playerRows).map(([status, count]) =>
      breakdownRecord(
        event.stage,
        MATCH_STATUS_DIMENSION,
        status,
        'PlayerRows',
        count,
        timestamp,
      ),
    ),
  ];
}

/**
 * Writes the stage event, then its breakdown records unless
 * `EMF_METRICS_ENABLED` is `false`, one JSON line each. A failure to build or
 * write propagates; the handler catches it and logs it so the invocation
 * still succeeds.
 */
export function publishStageEvent(
  event: StageEvent,
  write: (line: string) => void = (line) => process.stdout.write(line),
  environment: NodeJS.ProcessEnv = process.env,
  timestamp: number = Date.now(),
): void {
  const records = [
    stageEventRecord(event, { environment, timestamp }),
    ...(metricsEnabled(environment) ? breakdownRecords(event, timestamp) : []),
  ];
  for (const record of records) write(`${JSON.stringify(record)}\n`);
}

/**
 * Hands the event to the handler's injected publisher. A failure to build or
 * write it is logged and never fails the invocation (spec 1.3 §3.1).
 */
export function publishWithoutFailing(
  dependencies: { publishStageEvent(event: StageEvent): void },
  event: StageEvent,
): void {
  try {
    dependencies.publishStageEvent(event);
  } catch (error) {
    log('ERROR', 'Stage event not written', {
      stage: event.stage,
      errorName: error instanceof Error ? error.name : 'Error',
    });
  }
}

/**
 * Builds a CloudWatch embedded metric format record for one extraction.
 * CloudWatch Logs turns the record into metrics, so publishing needs no
 * CloudWatch API permission.
 */
export function extractionMetricRecord(
  functionName: string,
  rowCount: number,
  timestamp: number,
): Record<string, unknown> {
  return {
    _aws: {
      Timestamp: timestamp,
      CloudWatchMetrics: [
        {
          Namespace: METRIC_NAMESPACE,
          Dimensions: [[FUNCTION_NAME_DIMENSION]],
          Metrics: [
            { Name: EXTRACTED_ROWS_METRIC, Unit: 'Count' },
            { Name: ZERO_ROW_EXTRACTIONS_METRIC, Unit: 'Count' },
          ],
        },
      ],
    },
    [FUNCTION_NAME_DIMENSION]: functionName,
    [EXTRACTED_ROWS_METRIC]: rowCount,
    [ZERO_ROW_EXTRACTIONS_METRIC]: rowCount === 0 ? 1 : 0,
  };
}

/**
 * Writes the record straight to stdout, or nothing when `EMF_METRICS_ENABLED`
 * is `false`. The Lambda runtime prefixes `console.log` lines with a timestamp
 * and request ID, and CloudWatch does not extract metrics from a prefixed
 * line.
 */
export function publishExtractionMetrics(
  rowCount: number,
  write: (line: string) => void = (line) => process.stdout.write(line),
  environment: NodeJS.ProcessEnv = process.env,
  timestamp: number = Date.now(),
): void {
  if (!metricsEnabled(environment)) return;
  const record = extractionMetricRecord(
    environment.AWS_LAMBDA_FUNCTION_NAME ?? 'local',
    rowCount,
    timestamp,
  );
  write(`${JSON.stringify(record)}\n`);
}
