/** CloudWatch namespace for the metrics the match-to-csv Lambdas publish. */
export const METRIC_NAMESPACE = 'MCC/MatchToCsv';
/** Dimension that scopes every metric to the Lambda function that emitted it. */
export const FUNCTION_NAME_DIMENSION = 'FunctionName';
/** Rows extracted from one screenshot. */
export const EXTRACTED_ROWS_METRIC = 'ExtractedRows';
/** 1 when a screenshot's extraction succeeded with no rows, otherwise 0. */
export const ZERO_ROW_EXTRACTIONS_METRIC = 'ZeroRowExtractions';

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
 * Writes the record straight to stdout. The Lambda runtime prefixes
 * `console.log` lines with a timestamp and request ID, and CloudWatch does
 * not extract metrics from a prefixed line.
 */
export function publishExtractionMetrics(
  rowCount: number,
  write: (line: string) => void = (line) => process.stdout.write(line),
  environment: NodeJS.ProcessEnv = process.env,
  timestamp: number = Date.now(),
): void {
  const record = extractionMetricRecord(
    environment.AWS_LAMBDA_FUNCTION_NAME ?? 'local',
    rowCount,
    timestamp,
  );
  write(`${JSON.stringify(record)}\n`);
}
