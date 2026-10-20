import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  breakdownRecords,
  errorClass,
  extractionMetricRecord,
  publishExtractionMetrics,
  publishStageEvent,
  STAGE_METRIC_UNITS,
  stageEventRecord,
  type ErrorClass,
  type StageEvent,
} from '../src/lib/metrics';

test('extraction records use CloudWatch embedded metric format', () => {
  assert.deepEqual(
    extractionMetricRecord('match-to-csv-dev-ExtractText', 0, 1234),
    {
      _aws: {
        Timestamp: 1234,
        CloudWatchMetrics: [
          {
            Namespace: 'MCC/MatchToCsv',
            Dimensions: [['FunctionName']],
            Metrics: [
              { Name: 'ExtractedRows', Unit: 'Count' },
              { Name: 'ZeroRowExtractions', Unit: 'Count' },
            ],
          },
        ],
      },
      FunctionName: 'match-to-csv-dev-ExtractText',
      ExtractedRows: 0,
      ZeroRowExtractions: 1,
    },
  );
  const populated = extractionMetricRecord('fn', 8, 1234);
  assert.equal(populated.ExtractedRows, 8);
  assert.equal(populated.ZeroRowExtractions, 0);
});

test('published records are one unprefixed JSON line per extraction', () => {
  const lines: string[] = [];
  publishExtractionMetrics(
    3,
    (line) => lines.push(line),
    { AWS_LAMBDA_FUNCTION_NAME: 'match-to-csv-prod-ExtractText' },
    5678,
  );
  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'));
  assert.equal(lines[0].indexOf('\n'), lines[0].length - 1);
  const record = JSON.parse(lines[0]) as {
    FunctionName: string;
    ExtractedRows: number;
    _aws: { Timestamp: number };
  };
  assert.equal(record.FunctionName, 'match-to-csv-prod-ExtractText');
  assert.equal(record.ExtractedRows, 3);
  assert.equal(record._aws.Timestamp, 5678);
});

const XRAY_HEADER =
  'Root=1-5759e988-bd862e3fe1be46a994272793;Parent=53995c3f42cd8ad8;Sampled=1';
const ENVIRONMENT = {
  _X_AMZN_TRACE_ID: XRAY_HEADER,
  GIT_SHA: '0123abc',
  DEPLOYMENT_ENVIRONMENT: 'DEV',
};
const TRACE = {
  executionId: 'arn:aws:states:us-east-1:000000000000:execution:ingest:run-1',
  retryCount: 0,
  workflow: 'INGEST' as const,
};

function extractEvent(overrides: Partial<StageEvent> = {}): StageEvent {
  return {
    stage: 'extract',
    outcome: 'OK',
    durationMs: 2410,
    ids: { submissionId: 'sub-1', screenshotId: 'shot-1', runId: 'run-1' },
    trace: TRACE,
    requestId: 'request-1',
    properties: {
      acquisitionType: 'SCREENSHOT',
      rowCount: 8,
      reviewRequiredCells: 3,
      meanConfidence: 97.4,
      textractMs: 1830,
    },
    metrics: {
      OcrMeanConfidence: 97.4,
      TextractLatency: 1830,
      ReviewRequiredCells: 3,
    },
    ...overrides,
  };
}

interface Directive {
  Namespace: string;
  Dimensions: string[][];
  Metrics: Array<{ Name: string; Unit: string }>;
}

function directives(record: Record<string, unknown>): Directive[] {
  return (record._aws as { CloudWatchMetrics: Directive[] }).CloudWatchMetrics;
}

function captured(
  event: StageEvent,
  environment: NodeJS.ProcessEnv = ENVIRONMENT,
): Array<Record<string, unknown>> {
  const lines: string[] = [];
  publishStageEvent(event, (line) => lines.push(line), environment, 1234);
  for (const line of lines) {
    assert.ok(line.endsWith('\n'));
    assert.equal(line.indexOf('\n'), line.length - 1);
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ALLOWED_DIMENSIONS = new Set([
  'Stage',
  'ErrorClass',
  'Reason',
  'MatchStatus',
]);

test('stage events match the §6 record with metrics in one Stage directive', () => {
  assert.deepEqual(
    stageEventRecord(extractEvent(), {
      environment: ENVIRONMENT,
      timestamp: 1234,
    }),
    {
      _aws: {
        Timestamp: 1234,
        CloudWatchMetrics: [
          {
            Namespace: 'MCC/MatchToCsv',
            Dimensions: [['Stage']],
            Metrics: [
              { Name: 'TextractLatency', Unit: 'Milliseconds' },
              { Name: 'OcrMeanConfidence', Unit: 'Percent' },
              { Name: 'ReviewRequiredCells', Unit: 'Count' },
            ],
          },
        ],
      },
      event: 'stage.completed',
      schemaVersion: 'stage-event/v1',
      Stage: 'extract',
      workflow: 'INGEST',
      executionId: TRACE.executionId,
      retryCount: 0,
      outcome: 'OK',
      env: 'DEV',
      gitSha: '0123abc',
      submissionId: 'sub-1',
      screenshotId: 'shot-1',
      runId: 'run-1',
      xrayTraceId: '1-5759e988-bd862e3fe1be46a994272793',
      requestId: 'request-1',
      durationMs: 2410,
      acquisitionType: 'SCREENSHOT',
      rowCount: 8,
      reviewRequiredCells: 3,
      meanConfidence: 97.4,
      textractMs: 1830,
      TextractLatency: 1830,
      OcrMeanConfidence: 97.4,
      ReviewRequiredCells: 3,
    },
  );
});

test('ERROR events add StageErrors in a second directive keyed by ErrorClass only', () => {
  const record = stageEventRecord(
    extractEvent({
      outcome: 'ERROR',
      errorName: 'ThrottlingException',
      metrics: { TextractLatency: 40 },
    }),
    { environment: ENVIRONMENT, timestamp: 1234 },
  );
  assert.deepEqual(directives(record), [
    {
      Namespace: 'MCC/MatchToCsv',
      Dimensions: [['Stage']],
      Metrics: [{ Name: 'TextractLatency', Unit: 'Milliseconds' }],
    },
    {
      Namespace: 'MCC/MatchToCsv',
      Dimensions: [['Stage', 'ErrorClass']],
      Metrics: [{ Name: 'StageErrors', Unit: 'Count' }],
    },
  ]);
  assert.equal(record.errorName, 'ThrottlingException');
  assert.equal(record.ErrorClass, 'TEXTRACT_THROTTLED');
  assert.equal(record.StageErrors, 1);

  const errorOnly = stageEventRecord(
    {
      stage: 'process-email',
      outcome: 'ERROR',
      durationMs: 12,
      ids: {},
      trace: TRACE,
      errorName: 'SomethingNew',
      properties: {},
      metrics: {},
    },
    { environment: {}, timestamp: 1234 },
  );
  assert.deepEqual(directives(errorOnly), [
    {
      Namespace: 'MCC/MatchToCsv',
      Dimensions: [['Stage', 'ErrorClass']],
      Metrics: [{ Name: 'StageErrors', Unit: 'Count' }],
    },
  ]);
  assert.equal(errorOnly.errorName, 'SomethingNew');
  assert.equal(errorOnly.ErrorClass, 'OTHER');
  assert.equal(errorOnly.executionId, TRACE.executionId);
  assert.ok(!('submissionId' in errorOnly));
});

test('error fields and StageErrors appear only on ERROR events', () => {
  for (const outcome of ['OK', 'REJECTED'] as const) {
    const record = stageEventRecord(
      extractEvent({ outcome, errorName: 'ThrottlingException' }),
      { environment: ENVIRONMENT, timestamp: 1234 },
    );
    assert.ok(!('errorName' in record));
    assert.ok(!('ErrorClass' in record));
    assert.ok(!('StageErrors' in record));
    for (const directive of directives(record)) {
      assert.deepEqual(directive.Dimensions, [['Stage']]);
      assert.ok(directive.Metrics.every(({ Name }) => Name !== 'StageErrors'));
    }
  }
});

test('errorClass follows the §7.3 table and maps any other name to OTHER', () => {
  const table: Record<ErrorClass, string[]> = {
    TEXTRACT_THROTTLED: [
      'ThrottlingException',
      'ProvisionedThroughputExceededException',
      'LimitExceededException',
    ],
    TEXTRACT: [
      'InternalServerError',
      'InvalidParameterException',
      'BadDocumentException',
      'UnsupportedDocumentException',
      'DocumentTooLargeException',
    ],
    IMAGE: ['ImageTooLargeError', 'UnsupportedImageFormatError'],
    ROSTER: [
      'RosterConfigurationError',
      'RosterIntegrityError',
      'RosterSnapshotMismatchError',
      'RosterSnapshotConflictError',
    ],
    INTEGRITY: [
      'SourceHashMismatchError',
      'NormalizedObservationsMismatchError',
      'ExtractedTableMismatchError',
      'InvalidGamertagError',
      'InvalidGamertagExportInputError',
    ],
    CONFIGURATION: ['ParameterNotFound', 'AccessDeniedException'],
    STORAGE: ['StorageError', 'NoSuchKey', 'NoSuchBucket'],
    OTHER: [],
  };
  for (const [expected, names] of Object.entries(table)) {
    for (const name of names) assert.equal(errorClass(name), expected, name);
  }
  for (const name of [
    'Error',
    'TypeError',
    '',
    'toString',
    'constructor',
    '__proto__',
    'throttlingexception',
  ]) {
    assert.equal(errorClass(name), 'OTHER', name);
  }
});

test('absent and malformed fields are omitted rather than written as null', () => {
  const record = stageEventRecord(
    {
      stage: 'write-csv',
      outcome: 'OK',
      durationMs: 5,
      ids: { submissionId: 'sub-1', screenshotId: undefined },
      trace: {
        executionId: '',
        retryCount: -1,
        workflow: 'OTHER',
      } as unknown as StageEvent['trace'],
      properties: {
        rowCount: 4,
        missing: undefined as unknown as string,
        notANumber: Number.NaN,
        empty: '',
      },
      metrics: { CsvWritten: 1, GamertagCsvsWritten: undefined },
    },
    {
      environment: {
        _X_AMZN_TRACE_ID: 'Root=not-a-trace;Sampled=0',
        GIT_SHA: '',
      },
      timestamp: 1234,
    },
  );
  assert.deepEqual(
    Object.keys(record).sort(),
    [
      'CsvWritten',
      'Stage',
      '_aws',
      'durationMs',
      'event',
      'outcome',
      'rowCount',
      'schemaVersion',
      'submissionId',
    ].sort(),
  );
  assert.ok(!JSON.stringify(record).includes('null'));

  const partial = stageEventRecord(
    extractEvent({
      trace: {
        executionId: 'arn:execution',
        retryCount: 1.5,
        workflow: 'REPLAY',
      },
    }),
    { environment: {}, timestamp: 1234 },
  );
  assert.equal(partial.workflow, 'REPLAY');
  assert.equal(partial.executionId, 'arn:execution');
  assert.ok(!('retryCount' in partial));
  assert.ok(!('xrayTraceId' in partial));
  assert.ok(!('env' in partial));
  assert.ok(!('gitSha' in partial));

  const untraced = stageEventRecord(extractEvent({ trace: undefined }), {
    environment: {},
    timestamp: 1234,
  });
  for (const key of ['workflow', 'executionId', 'retryCount']) {
    assert.ok(!(key in untraced), key);
  }
});

test('a record with no metric value has no _aws block', () => {
  const record = stageEventRecord(extractEvent({ metrics: {} }), {
    environment: ENVIRONMENT,
    timestamp: 1234,
  });
  assert.ok(!('_aws' in record));
  assert.equal(record.event, 'stage.completed');
});

test('properties cannot replace fields, metrics or dimensions the module sets', () => {
  const record = stageEventRecord(
    extractEvent({
      properties: {
        event: 'forged',
        Stage: 'write-csv',
        outcome: 'ERROR',
        submissionId: 'forged',
        ErrorClass: 'IMAGE',
        StageErrors: 5,
        OcrMeanConfidence: 1,
        PlayerRows: 9,
        Reason: 'forged',
        rejectionCodes: 'forged',
        rowCount: 8,
      },
      metrics: {},
    }),
    { environment: { EMF_METRICS_ENABLED: 'false' }, timestamp: 1234 },
  );
  assert.deepEqual(
    {
      event: record.event,
      Stage: record.Stage,
      outcome: record.outcome,
      submissionId: record.submissionId,
      rowCount: record.rowCount,
    },
    {
      event: 'stage.completed',
      Stage: 'extract',
      outcome: 'OK',
      submissionId: 'sub-1',
      rowCount: 8,
    },
  );
  for (const key of [
    'ErrorClass',
    'StageErrors',
    'OcrMeanConfidence',
    'PlayerRows',
    'Reason',
    'rejectionCodes',
  ]) {
    assert.ok(!(key in record), key);
  }
});

test('rejection codes are distinct, sorted and comma-joined', () => {
  const record = stageEventRecord(
    {
      stage: 'process-email',
      outcome: 'REJECTED',
      durationMs: 30,
      ids: { submissionId: 'sub-1' },
      properties: { attachmentCount: 3, rejectedAttachmentCount: 3 },
      metrics: { SubmissionsRejected: 1 },
      breakdowns: {
        submissionRejectionReasons: [
          'SPAM_VERDICT_FAILED',
          'SENDER_NOT_ALLOWED',
          'SPAM_VERDICT_FAILED',
        ],
        attachmentRejectionReasons: {
          UNREADABLE_IMAGE: 1,
          IMAGE_TOO_LARGE: 2,
          NOT_AN_IMAGE: 0,
        },
      },
    },
    { environment: ENVIRONMENT, timestamp: 1234 },
  );
  assert.equal(record.rejectionCodes, 'SENDER_NOT_ALLOWED,SPAM_VERDICT_FAILED');
  assert.equal(
    record.attachmentRejectionCodes,
    'IMAGE_TOO_LARGE,UNREADABLE_IMAGE',
  );

  const accepted = stageEventRecord(extractEvent({ breakdowns: {} }), {
    environment: ENVIRONMENT,
    timestamp: 1234,
  });
  assert.ok(!('rejectionCodes' in accepted));
  assert.ok(!('attachmentRejectionCodes' in accepted));
});

test('breakdown records hold one Reason or MatchStatus value and are skipped for zero', () => {
  const records = breakdownRecords(
    {
      stage: 'process-email',
      outcome: 'REJECTED',
      durationMs: 30,
      ids: { submissionId: 'sub-1', screenshotId: 'shot-1', runId: 'run-1' },
      trace: TRACE,
      requestId: 'request-1',
      properties: { attachmentCount: 2 },
      metrics: { SubmissionsRejected: 1 },
      breakdowns: {
        submissionRejectionReasons: [
          'SPAM_VERDICT_FAILED',
          'MATCH_DATE_INVALID',
          'SPAM_VERDICT_FAILED',
        ],
        attachmentRejectionReasons: { NOT_AN_IMAGE: 2, IMAGE_TOO_SMALL: 0 },
        playerRows: { EXACT: 5, RESOLVED: 0, UNMATCHED: 1 },
      },
    },
    1234,
  );
  const breakdown = (
    dimension: string,
    value: string,
    metric: string,
    count: number,
  ) => ({
    _aws: {
      Timestamp: 1234,
      CloudWatchMetrics: [
        {
          Namespace: 'MCC/MatchToCsv',
          Dimensions: [['Stage', dimension]],
          Metrics: [{ Name: metric, Unit: 'Count' }],
        },
      ],
    },
    event: 'metric.breakdown',
    Stage: 'process-email',
    [dimension]: value,
    [metric]: count,
  });
  assert.deepEqual(records, [
    breakdown('Reason', 'MATCH_DATE_INVALID', 'SubmissionsRejected', 1),
    breakdown('Reason', 'SPAM_VERDICT_FAILED', 'SubmissionsRejected', 1),
    breakdown('Reason', 'NOT_AN_IMAGE', 'AttachmentsRejected', 2),
    breakdown('MatchStatus', 'EXACT', 'PlayerRows', 5),
    breakdown('MatchStatus', 'UNMATCHED', 'PlayerRows', 1),
  ]);
  assert.deepEqual(breakdownRecords(extractEvent(), 1234), []);
  assert.deepEqual(
    breakdownRecords(
      extractEvent({
        breakdowns: {
          submissionRejectionReasons: [],
          attachmentRejectionReasons: { NOT_AN_IMAGE: 0 },
          playerRows: { EXACT: 0, RESOLVED: 0, UNMATCHED: 0 },
        },
      }),
      1234,
    ),
    [],
  );
});

test('published records use only allowed dimensions and the injected writer', () => {
  const records = captured(
    extractEvent({
      outcome: 'ERROR',
      errorName: 'RosterIntegrityError',
      breakdowns: {
        playerRows: { EXACT: 3, UNMATCHED: 2 },
        attachmentRejectionReasons: { IMAGE_TOO_LARGE: 1 },
        submissionRejectionReasons: ['SENDER_NOT_ALLOWED'],
      },
    }),
  );
  assert.equal(records.length, 5);
  assert.equal(records[0].event, 'stage.completed');
  assert.equal(records[0].ErrorClass, 'ROSTER');
  assert.ok(
    records.slice(1).every((record) => record.event === 'metric.breakdown'),
  );
  for (const record of records) {
    for (const directive of directives(record)) {
      assert.equal(directive.Namespace, 'MCC/MatchToCsv');
      assert.equal(directive.Dimensions.length, 1);
      for (const dimension of directive.Dimensions[0]) {
        assert.ok(ALLOWED_DIMENSIONS.has(dimension), dimension);
      }
    }
  }
  const stageErrorDirectives = records
    .flatMap(directives)
    .filter((directive) =>
      directive.Metrics.some(({ Name }) => Name === 'StageErrors'),
    );
  assert.deepEqual(
    stageErrorDirectives.map((directive) => directive.Dimensions),
    [[['Stage', 'ErrorClass']]],
  );
  for (const record of records.slice(1)) {
    for (const id of [
      'submissionId',
      'screenshotId',
      'runId',
      'executionId',
      'requestId',
      'xrayTraceId',
      'workflow',
      'errorName',
    ]) {
      assert.ok(!(id in record), id);
    }
  }
});

test('with EMF_METRICS_ENABLED unset, both existing extraction metrics are still written', () => {
  for (const environment of [
    {},
    { EMF_METRICS_ENABLED: 'true' },
    { EMF_METRICS_ENABLED: 'FALSE' },
  ]) {
    const lines: string[] = [];
    publishExtractionMetrics(0, (line) => lines.push(line), environment, 99);
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(record.ExtractedRows, 0);
    assert.equal(record.ZeroRowExtractions, 1);
    assert.deepEqual(
      directives(record)[0].Metrics.map(({ Name }) => Name),
      ['ExtractedRows', 'ZeroRowExtractions'],
    );
    const stageRecords = captured(
      extractEvent({ breakdowns: { playerRows: { EXACT: 1 } } }),
      environment,
    );
    assert.equal(stageRecords.length, 2);
    assert.ok(stageRecords.every((stageRecord) => '_aws' in stageRecord));
  }
});

test('with EMF_METRICS_ENABLED false, nothing carries metrics', () => {
  const environment = { ...ENVIRONMENT, EMF_METRICS_ENABLED: 'false' };
  const records = captured(
    extractEvent({
      outcome: 'ERROR',
      errorName: 'ImageTooLargeError',
      breakdowns: {
        playerRows: { EXACT: 3 },
        submissionRejectionReasons: ['SENDER_NOT_ALLOWED'],
        attachmentRejectionReasons: { IMAGE_TOO_LARGE: 1 },
      },
    }),
    environment,
  );
  assert.equal(records.length, 1);
  const [record] = records;
  assert.ok(!('_aws' in record));
  for (const metric of [
    ...Object.keys(STAGE_METRIC_UNITS),
    'StageErrors',
    'PlayerRows',
    'AttachmentsRejected',
  ]) {
    assert.ok(!(metric in record), metric);
  }
  assert.equal(record.errorName, 'ImageTooLargeError');
  assert.equal(record.ErrorClass, 'IMAGE');
  assert.equal(record.meanConfidence, 97.4);
  assert.equal(record.rejectionCodes, 'SENDER_NOT_ALLOWED');

  const lines: string[] = [];
  publishExtractionMetrics(4, (line) => lines.push(line), environment, 99);
  assert.deepEqual(lines, []);
});

test('publishStageEvent writes each record to stdout by default', (t) => {
  const writes: string[] = [];
  t.mock.method(process.stdout, 'write', (chunk: string) => {
    writes.push(chunk);
    return true;
  });
  publishStageEvent(
    extractEvent({ breakdowns: { playerRows: { RESOLVED: 2 } } }),
    undefined,
    {},
  );
  t.mock.restoreAll();
  assert.equal(writes.length, 2);
  assert.equal(
    (JSON.parse(writes[0]) as { event: string }).event,
    'stage.completed',
  );
  assert.equal(
    (JSON.parse(writes[1]) as { event: string }).event,
    'metric.breakdown',
  );
});
