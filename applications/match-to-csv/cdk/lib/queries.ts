/**
 * The Logs Insights queries in spec 1.3 §8. Dev and prod save each one as a
 * query definition named `<resourcePrefix>/<id>`, and the dashboard runs Q2
 * and Q7. Developers paste them from the spec into an ephemeral stack's logs.
 */

/**
 * Which log groups a query reads: the four stage-event function groups, those
 * plus the ingest workflow group, or every function group.
 */
export type QueryLogGroups = 'stages' | 'stagesAndWorkflow' | 'functions';

export interface StackQuery {
  id: 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5' | 'Q6' | 'Q7';
  purpose: string;
  logGroups: QueryLogGroups;
  queryString: string;
}

const pipeline = (...commands: string[]): string => commands.join('\n| ');

export const QUERIES = [
  {
    id: 'Q1',
    purpose: 'Trace one submission or execution',
    logGroups: 'stages',
    queryString: pipeline(
      'filter event = "stage.completed" and (submissionId = "<id>" or executionId = "<execution ARN>")',
      'sort @timestamp asc',
      'fields @timestamp, Stage, workflow, outcome, screenshotId, runId, retryCount, durationMs, errorName, ErrorClass, rejectionCodes, attachmentRejectionCodes, fileCount, xrayTraceId',
    ),
  },
  {
    id: 'Q2',
    purpose: 'Status of each ingest execution',
    logGroups: 'stagesAndWorkflow',
    queryString: pipeline(
      'filter (event = "stage.completed" and workflow = "INGEST") or type in ["ExecutionFailed", "ExecutionTimedOut", "ExecutionAborted"]',
      'fields coalesce(executionId, execution_arn) as execution',
      'stats max(screenshotCount) as expected, count_distinct(exportedScreenshotId) as exported, count(completedSubmissionId) as completed, max(fileCount) as gamertagCsvs, count(rejectionCodes) as rejected, count(execution_arn) as ended, min(@timestamp) as firstSeen, max(@timestamp) as lastSeen by execution',
      'sort lastSeen desc',
    ),
  },
  {
    id: 'Q3',
    purpose: 'Stage funnel',
    logGroups: 'stages',
    queryString: pipeline(
      'filter event = "stage.completed"',
      'stats count_distinct(executionId) as executions, count_distinct(screenshotId) as screenshots by Stage, workflow, outcome',
    ),
  },
  {
    id: 'Q4',
    purpose: 'Per-stage latency',
    logGroups: 'stages',
    queryString: pipeline(
      'filter event = "stage.completed" and outcome = "OK"',
      'stats pct(durationMs, 50) as p50, pct(durationMs, 95) as p95, max(durationMs) as worst, pct(endToEndMs, 95) as e2eP95 by Stage',
    ),
  },
  {
    id: 'Q5',
    purpose: 'Failed attempts and rejections',
    logGroups: 'stages',
    queryString: pipeline(
      'filter event = "stage.completed" and (outcome != "OK" or ispresent(attachmentRejectionCodes))',
      'stats count() as events, count_distinct(executionId) as executions by Stage, outcome, ErrorClass, errorName, rejectionCodes, attachmentRejectionCodes',
      'sort events desc',
    ),
  },
  {
    id: 'Q6',
    purpose: 'Cold starts and memory',
    logGroups: 'functions',
    queryString: pipeline(
      'filter type = "platform.report"',
      'stats count(record.metrics.initDurationMs) as coldStarts, max(record.metrics.maxMemoryUsedMB / record.metrics.memorySizeMB) as memoryPeak, pct(record.metrics.durationMs, 95) as p95 by @log',
    ),
  },
  {
    id: 'Q7',
    purpose: 'Errors per hour',
    logGroups: 'stages',
    queryString: pipeline(
      'filter event = "stage.completed" and outcome = "ERROR"',
      'stats count() as errors by bin(1h) as hour, Stage, ErrorClass, errorName',
      'sort hour desc, errors desc',
    ),
  },
] as const satisfies readonly StackQuery[];

export type QueryId = (typeof QUERIES)[number]['id'];

export function query(id: QueryId): StackQuery {
  return QUERIES.find((candidate) => candidate.id === id)!;
}
