import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  CsvRow,
  WriteExtractedCsvOutput,
  WriteGamertagCsvsInput,
  WriteGamertagCsvsOutput,
} from '@mcc/contracts';
import { GAMERTAG_PATTERN } from '@mcc/roster';
import { exportDate, rowsToGamertagCsv } from '../lib/csv';
import { log } from '../lib/log';
import { bodyToBuffer, namespacedObjectKey } from '../lib/s3';

const s3 = new S3Client({});

export interface WriteGamertagCsvsDependencies {
  /** Reads and parses one JSON object, a run's `extracted-table.json`. */
  getJson(bucket: string, key: string): Promise<unknown>;
  /** Writes one object with `If-None-Match: *`. */
  putObject(
    bucket: string,
    key: string,
    body: string,
    contentType: string,
  ): Promise<void>;
}

const defaultDependencies: WriteGamertagCsvsDependencies = {
  async getJson(bucket, key) {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    return JSON.parse(
      (await bodyToBuffer(object.Body)).toString('utf8'),
    ) as unknown;
  },
  async putObject(bucket, key, body, contentType) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: '*',
      }),
    );
  },
};

export async function handler(
  event: WriteGamertagCsvsInput,
): Promise<WriteGamertagCsvsOutput> {
  return writeGamertagCsvs(event, defaultDependencies);
}

const CSV_SUFFIX = '/export/extracted.csv';
const TABLE_SUFFIX = '/export/extracted-table.json';

/**
 * Writes one legacy-spreadsheet CSV per roster gamertag of a submission (spec
 * 1.1 §8.6.1) under `submissions/{submissionId}/export/gamertags/`. It reads
 * each run's `extracted-table.json`, in the order of `event.exports`, and
 * keeps the rows whose `playerResolution` is `EXACT` or `RESOLVED`. Gamertags
 * appear only in the files it writes: errors, logs and the output carry run
 * IDs, row positions and counts.
 */
export async function writeGamertagCsvs(
  event: WriteGamertagCsvsInput,
  dependencies: WriteGamertagCsvsDependencies,
): Promise<WriteGamertagCsvsOutput> {
  if (!/^[A-Za-z0-9-]+$/.test(event.submissionId)) {
    throw invalidInput('Submission ID has an unexpected form');
  }
  exportDate(event.matchDate);
  const submissionPrefix = namespacedObjectKey(
    `submissions/${event.submissionId}`,
  );
  const prefix = `${submissionPrefix}/export/gamertags/`;
  const buckets = new Set(event.exports.map((item) => item.bucket));
  if (buckets.size > 1) {
    throw invalidInput('Run exports name more than one bucket');
  }
  for (const item of event.exports) {
    checkExportKey(item, submissionPrefix);
  }

  const tables = await Promise.all(
    event.exports.map((item) => readRows(item, dependencies)),
  );
  // Insertion order follows the first row of each gamertag, and each list
  // keeps screenshot order, then table order within a screenshot.
  const rowsByGamertag = new Map<string, CsvRow[]>();
  tables.forEach((rows, index) => {
    rows.forEach((row, rowIndex) => {
      const gamertag = matchedGamertag(row, event.exports[index], rowIndex);
      if (gamertag === undefined) return;
      const list = rowsByGamertag.get(gamertag) ?? [];
      list.push(row);
      rowsByGamertag.set(gamertag, list);
    });
  });

  const bucket = event.exports[0]?.bucket ?? '';
  let rowCount = 0;
  const files = [...rowsByGamertag].map(([gamertag, rows]) => {
    rowCount += rows.length;
    return {
      key: `${prefix}${gamertagObjectName(gamertag)}`,
      body: rowsToGamertagCsv(event.matchDate, rows),
    };
  });
  await Promise.all(
    files.map((file, index) =>
      putOnce(dependencies, bucket, file, `${index + 1} of ${files.length}`),
    ),
  );

  const output: WriteGamertagCsvsOutput = {
    submissionId: event.submissionId,
    prefix,
    fileCount: files.length,
    rowCount,
  };
  log('INFO', 'Gamertag CSVs written', {
    ...output,
    exportCount: event.exports.length,
  });
  return output;
}

/**
 * The per-gamertag export file name for a roster gamertag (spec 1.1 §5.1).
 * Letters and digits stay, a space becomes `_` and `#` becomes `-`. Roster
 * gamertags match `GAMERTAG_PATTERN` (spec 1.2 §4.3) and so never hold `_` or
 * `-`, which makes the name unique per gamertag and safe in S3 keys and URLs.
 * Gamertags are also unique ignoring case, so two names never differ only in
 * case. Any other value is refused with an error that does not name it.
 */
export function gamertagObjectName(gamertag: string): string {
  if (!GAMERTAG_PATTERN.test(gamertag)) {
    const error = new Error('A roster gamertag has an unexpected form');
    error.name = 'InvalidGamertagError';
    throw error;
  }
  return `${gamertag.replace(/ /g, '_').replace('#', '-')}.csv`;
}

/**
 * Accepts only a run export of this submission, so the step never reads
 * another submission's runs or another namespace's evidence.
 */
function checkExportKey(
  item: WriteExtractedCsvOutput,
  submissionPrefix: string,
): void {
  const runPrefix = item.key.endsWith(CSV_SUFFIX)
    ? item.key.slice(0, -CSV_SUFFIX.length)
    : '';
  const parts = runPrefix.startsWith(`${submissionPrefix}/screenshots/`)
    ? runPrefix.slice(submissionPrefix.length + 1).split('/')
    : [];
  if (
    parts.length !== 4 ||
    parts[1] === '' ||
    parts[2] !== 'runs' ||
    parts[3] !== item.runId
  ) {
    throw invalidInput(
      `Export of run ${item.runId} is not a run export of this submission`,
    );
  }
}

/** Reads the rows of the run's `extracted-table.json`. */
async function readRows(
  item: WriteExtractedCsvOutput,
  dependencies: WriteGamertagCsvsDependencies,
): Promise<CsvRow[]> {
  const table = (await dependencies.getJson(
    item.bucket,
    `${item.key.slice(0, -CSV_SUFFIX.length)}${TABLE_SUFFIX}`,
  )) as { schemaVersion?: unknown; runId?: unknown; rows?: unknown } | null;
  if (
    table?.schemaVersion !== 'extracted-table/v1' ||
    table.runId !== item.runId ||
    !Array.isArray(table.rows)
  ) {
    throw tableMismatch(
      `Extracted table of run ${item.runId} is not that run's extracted-table/v1`,
    );
  }
  return table.rows as CsvRow[];
}

/**
 * The roster gamertag of an `EXACT` or `RESOLVED` row. `UNMATCHED` rows and
 * rows without a `playerResolution` give none.
 */
function matchedGamertag(
  row: CsvRow,
  item: WriteExtractedCsvOutput,
  rowIndex: number,
): string | undefined {
  const resolution = row.playerResolution;
  if (
    !resolution ||
    (resolution.status !== 'EXACT' && resolution.status !== 'RESOLVED')
  ) {
    return undefined;
  }
  if (typeof resolution.gamertag !== 'string') {
    throw tableMismatch(
      `Row ${rowIndex + 1} of run ${item.runId} is matched without a gamertag`,
    );
  }
  return resolution.gamertag;
}

function invalidInput(message: string): Error {
  const error = new Error(message);
  error.name = 'InvalidGamertagExportInputError';
  return error;
}

function tableMismatch(message: string): Error {
  const error = new Error(message);
  error.name = 'ExtractedTableMismatchError';
  return error;
}

/**
 * Writes one file create-only. Any other failure is rethrown under its own
 * name, so the workflow's retries still match it, but with a message that
 * leaves out the key: an S3 or KMS message can quote the resource, and the
 * key names the gamertag.
 */
async function putOnce(
  dependencies: WriteGamertagCsvsDependencies,
  bucket: string,
  file: { key: string; body: string },
  position: string,
): Promise<void> {
  try {
    await dependencies.putObject(bucket, file.key, file.body, 'text/csv');
  } catch (error) {
    // A retried step finds the files an earlier attempt wrote (spec 1.1 §6.4).
    if (isPreconditionFailure(error)) return;
    const name =
      error instanceof Error && error.name ? error.name : 'StorageError';
    const sanitized = new Error(
      `Writing gamertag CSV ${position} failed with ${name}`,
    );
    sanitized.name = name;
    throw sanitized;
  }
}

function isPreconditionFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    '$metadata' in error &&
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata
      ?.httpStatusCode === 412
  );
}
