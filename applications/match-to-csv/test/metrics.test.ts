import t from 'tap';
import {
  extractionMetricRecord,
  publishExtractionMetrics,
} from '../src/lib/metrics';

t.test('extraction records use CloudWatch embedded metric format', (t) => {
  t.same(extractionMetricRecord('match-to-csv-dev-ExtractText', 0, 1234), {
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
  });
  const populated = extractionMetricRecord('fn', 8, 1234);
  t.equal(populated.ExtractedRows, 8);
  t.equal(populated.ZeroRowExtractions, 0);
  t.end();
});

t.test('published records are one unprefixed JSON line per extraction', (t) => {
  const lines: string[] = [];
  publishExtractionMetrics(
    3,
    (line) => lines.push(line),
    { AWS_LAMBDA_FUNCTION_NAME: 'match-to-csv-prod-ExtractText' },
    5678,
  );
  t.equal(lines.length, 1);
  t.ok(lines[0].endsWith('\n'));
  t.equal(lines[0].indexOf('\n'), lines[0].length - 1);
  const record = JSON.parse(lines[0]) as {
    FunctionName: string;
    ExtractedRows: number;
    _aws: { Timestamp: number };
  };
  t.equal(record.FunctionName, 'match-to-csv-prod-ExtractText');
  t.equal(record.ExtractedRows, 3);
  t.equal(record._aws.Timestamp, 5678);
  t.end();
});
