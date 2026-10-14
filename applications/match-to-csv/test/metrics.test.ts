import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractionMetricRecord,
  publishExtractionMetrics,
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
