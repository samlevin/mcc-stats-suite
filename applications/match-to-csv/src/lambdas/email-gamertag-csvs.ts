import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import type {
  CsvEmailDelivery,
  CsvEmailDeliveryStatus,
  EmailGamertagCsvsInput,
  EmailGamertagCsvsOutput,
} from '@mcc/contracts';
import { exportDate } from '../lib/csv';
import { log } from '../lib/log';
import {
  dynamoRecipientTable,
  readRecipients,
  type LoadedRecipients,
} from '../lib/recipient-source';
import { REPLY_LOCAL_PART } from '../lib/reply-address';
import { bodyToBuffer, namespacedObjectKey } from '../lib/s3';

const s3 = new S3Client({});
const ses = new SESv2Client({});

/** One per-gamertag CSV attached to the results email. */
export interface CsvAttachment {
  fileName: string;
  content: Buffer;
}

/** The results email of one submission. */
export interface CsvEmail {
  from: string;
  to: string[];
  /** The whole MIME message. */
  raw: Buffer;
}

export interface EmailGamertagCsvsDependencies {
  /** Every key under `prefix`, following continuation tokens. */
  listKeys(bucket: string, prefix: string): Promise<string[]>;
  getObject(bucket: string, key: string): Promise<Buffer>;
  /** Writes with `If-None-Match: *`; `EXISTS` on HTTP 412. */
  putIfAbsent(
    bucket: string,
    key: string,
    body: string,
  ): Promise<'CREATED' | 'EXISTS'>;
  /** The active recipients of this stack's recipient list namespace. */
  readRecipients(): Promise<LoadedRecipients>;
  /** Sends one raw email through SES and returns its message ID. */
  sendEmail(email: CsvEmail): Promise<string>;
  now(): string;
}

export interface EmailGamertagCsvsConfiguration {
  bucket: string;
  /** The email domain; the email is sent from `noreply@<domain>`. */
  fromDomain: string;
}

const defaultDependencies = (
  tableName: string,
  namespace: string,
): EmailGamertagCsvsDependencies => ({
  async listKeys(bucket, prefix) {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      keys.push(
        ...(page.Contents ?? []).flatMap((item) =>
          item.Key ? [item.Key] : [],
        ),
      );
      continuationToken = page.IsTruncated
        ? page.NextContinuationToken
        : undefined;
    } while (continuationToken);
    return keys;
  },
  async getObject(bucket, key) {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    return bodyToBuffer(object.Body);
  },
  async putIfAbsent(bucket, key, body) {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: 'application/json',
          IfNoneMatch: '*',
        }),
      );
      return 'CREATED';
    } catch (error) {
      if (httpStatus(error) === 412) return 'EXISTS';
      throw error;
    }
  },
  readRecipients: () =>
    readRecipients(dynamoRecipientTable(tableName), namespace),
  async sendEmail(email) {
    const { MessageId } = await ses.send(
      new SendEmailCommand({
        FromEmailAddress: email.from,
        Destination: { ToAddresses: email.to },
        Content: { Raw: { Data: email.raw } },
      }),
    );
    return MessageId ?? '';
  },
  now: () => new Date().toISOString(),
});

export async function handler(
  event: EmailGamertagCsvsInput,
): Promise<EmailGamertagCsvsOutput> {
  const environment = {
    bucket: process.env.EVIDENCE_BUCKET,
    fromDomain: process.env.EMAIL_FROM_DOMAIN,
    tableName: process.env.RECIPIENTS_TABLE,
    namespace: process.env.RECIPIENTS_NAMESPACE,
  };
  const missing = Object.entries(environment).find(([, value]) => !value);
  if (missing) {
    const error = new Error(`${missing[0]} is not configured`);
    error.name = 'EmailConfigurationError';
    throw error;
  }
  const { bucket, fromDomain, tableName, namespace } = environment as Record<
    keyof typeof environment,
    string
  >;
  return emailGamertagCsvs(
    event,
    { bucket, fromDomain },
    defaultDependencies(tableName, namespace),
  );
}

/**
 * Emails a submission's per-gamertag CSVs to the active entries of the CSV
 * recipient list (spec 1.1 §8.6.2) and records the outcome create-only in
 * the submission's `export/csv-email.json`. It runs after
 * `write-gamertag-csvs`, and fails unless every file that step reported
 * exists. Addresses and gamertags appear only in the email and the attachment
 * names of the record: errors, logs and the output carry counts, versions and
 * IDs.
 */
export async function emailGamertagCsvs(
  event: EmailGamertagCsvsInput,
  configuration: EmailGamertagCsvsConfiguration,
  dependencies: EmailGamertagCsvsDependencies,
): Promise<EmailGamertagCsvsOutput> {
  const { submissionId, gamertagCsvs } = event;
  if (!/^[A-Za-z0-9-]+$/.test(submissionId)) {
    throw invalidInput('Submission ID has an unexpected form');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(event.matchDate)) {
    throw invalidInput('Match date is not YYYY-MM-DD');
  }
  if (
    !Number.isSafeInteger(event.screenshotCount) ||
    event.screenshotCount < 0
  ) {
    throw invalidInput('Screenshot count is not a whole number');
  }
  const submissionPrefix = namespacedObjectKey(`submissions/${submissionId}`);
  const prefix = `${submissionPrefix}/export/gamertags/`;
  if (
    gamertagCsvs?.submissionId !== submissionId ||
    gamertagCsvs.prefix !== prefix ||
    !Number.isSafeInteger(gamertagCsvs.fileCount) ||
    gamertagCsvs.fileCount < 0
  ) {
    throw invalidInput(
      'The gamertag CSV output names another submission or namespace',
    );
  }
  const { bucket } = configuration;
  const key = `${submissionPrefix}/export/csv-email.json`;

  // A retried step finds the record of an earlier attempt and sends nothing.
  const recorded = await readRecord(dependencies, bucket, key);
  if (recorded) return finish(recorded, key, 'already recorded');

  const keys = (
    await withoutKeys(
      dependencies.listKeys(bucket, prefix),
      'Listing gamertag CSVs',
    )
  )
    .filter((item) => /^[^/]+\.csv$/.test(item.slice(prefix.length)))
    .sort();
  if (keys.length !== gamertagCsvs.fileCount) {
    const error = new Error(
      `Found ${keys.length} of ${gamertagCsvs.fileCount} gamertag CSVs`,
    );
    error.name = 'GamertagCsvsMissingError';
    throw error;
  }
  const recipients = await dependencies.readRecipients();
  const attachmentNames = keys.map((item) => item.slice(prefix.length));
  const status: CsvEmailDeliveryStatus =
    keys.length === 0
      ? 'NO_FILES'
      : recipients.entries.length === 0
        ? 'NOT_CONFIGURED'
        : 'SENT';

  let sesMessageId: string | null = null;
  if (status === 'SENT') {
    const attachments = await Promise.all(
      keys.map(async (item, index) => ({
        fileName: attachmentNames[index],
        content: await withoutKeys(
          dependencies.getObject(bucket, item),
          `Reading gamertag CSV ${index + 1} of ${keys.length}`,
        ),
      })),
    );
    const email = csvEmail({
      from: `${REPLY_LOCAL_PART}@${configuration.fromDomain}`,
      to: recipients.entries.map((entry) => entry.address),
      submissionId,
      matchDate: event.matchDate,
      screenshotCount: event.screenshotCount,
      attachments,
    });
    try {
      sesMessageId = await dependencies.sendEmail(email);
    } catch (error) {
      throw sendFailure(error);
    }
  }

  const record: CsvEmailDelivery = {
    schemaVersion: 'csv-email-delivery/v1',
    submissionId,
    status,
    sesMessageId,
    recipientsVersion: recipients.recipientsVersion,
    recipientCount: recipients.entries.length,
    screenshotCount: event.screenshotCount,
    attachments: attachmentNames,
    recordedAt: dependencies.now(),
  };
  const written = await withoutKeys(
    dependencies.putIfAbsent(bucket, key, JSON.stringify(record)),
    'Writing the delivery record',
  );
  if (written === 'EXISTS') {
    // Another attempt recorded its outcome first.
    const existing = await readRecord(dependencies, bucket, key);
    if (existing) return finish(existing, key, 'already recorded');
  }
  return finish(record, key);
}

/**
 * The results email: from `noreply@<domain>` to every recipient, a subject
 * that names the match date as `M/D/YYYY`, a plain-text body with the file
 * and screenshot counts, and each CSV as its own `text/csv` attachment. File
 * names follow `gamertagObjectName`, letters, digits, `_` and `-` only, so
 * they need no encoding in a header.
 */
export function csvEmail(message: {
  from: string;
  to: string[];
  submissionId: string;
  matchDate: string;
  screenshotCount: number;
  attachments: CsvAttachment[];
}): CsvEmail {
  const date = exportDate(message.matchDate);
  const files = message.attachments.length;
  const screenshots = message.screenshotCount;
  // `_` never appears in base64 or in the body text, so the boundary never
  // appears in a part.
  const boundary = `=_mcc_${message.submissionId}`;
  const body = [
    `Gamertag CSVs for the match on ${date}.`,
    '',
    `${files} ${files === 1 ? 'file' : 'files'} from ${screenshots} ${screenshots === 1 ? 'screenshot' : 'screenshots'}. Each file is one player's lines, ready to paste into that player's spreadsheet.`,
    '',
    `Submission ${message.submissionId}`,
    '',
    'Replies to this no-reply address are not read.',
  ];
  const lines = [
    `From: ${message.from}`,
    // One address per folded line keeps every line under the 998-character
    // limit of RFC 5322 §2.1.1, since an address has at most 254.
    `To: ${message.to.join(',\r\n ')}`,
    `Subject: MCC match ${date}: gamertag CSVs`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    ...body,
  ];
  for (const attachment of message.attachments) {
    if (!/^[A-Za-z0-9_-]+\.csv$/.test(attachment.fileName)) {
      throw invalidInput('A gamertag CSV has an unexpected file name');
    }
    lines.push(
      `--${boundary}`,
      `Content-Type: text/csv; charset=UTF-8; name="${attachment.fileName}"`,
      `Content-Disposition: attachment; filename="${attachment.fileName}"`,
      'Content-Transfer-Encoding: base64',
      '',
      ...(attachment.content.toString('base64').match(/.{1,76}/g) ?? []),
    );
  }
  lines.push(`--${boundary}--`, '');
  return {
    from: message.from,
    to: message.to,
    raw: Buffer.from(lines.join('\r\n'), 'utf8'),
  };
}

/** Reads `export/csv-email.json` when it exists. */
async function readRecord(
  dependencies: EmailGamertagCsvsDependencies,
  bucket: string,
  key: string,
): Promise<CsvEmailDelivery | undefined> {
  const keys = await withoutKeys(
    dependencies.listKeys(bucket, key),
    'Listing the delivery record',
  );
  if (!keys.includes(key)) return undefined;
  const body = await withoutKeys(
    dependencies.getObject(bucket, key),
    'Reading the delivery record',
  );
  let record: CsvEmailDelivery | undefined;
  try {
    record = JSON.parse(body.toString('utf8')) as CsvEmailDelivery;
  } catch {
    // A SyntaxError message can quote the document, which names gamertags.
  }
  if (
    record?.schemaVersion !== 'csv-email-delivery/v1' ||
    !Array.isArray(record.attachments)
  ) {
    const error = new Error('The delivery record is not csv-email-delivery/v1');
    error.name = 'CsvEmailDeliveryMismatchError';
    throw error;
  }
  return record;
}

function finish(
  record: CsvEmailDelivery,
  key: string,
  note?: string,
): EmailGamertagCsvsOutput {
  const output: EmailGamertagCsvsOutput = {
    submissionId: record.submissionId,
    status: record.status,
    sesMessageId: record.sesMessageId,
    recipientsVersion: record.recipientsVersion,
    recipientCount: record.recipientCount,
    attachmentCount: record.attachments.length,
    key,
  };
  const message = {
    SENT: 'Gamertag CSV email sent',
    NOT_CONFIGURED: 'Gamertag CSV email not sent: no active recipient',
    NO_FILES: 'Gamertag CSV email not sent: no gamertag CSV',
  }[record.status];
  log(record.status === 'NOT_CONFIGURED' ? 'WARN' : 'INFO', message, {
    ...output,
    ...(note ? { note } : {}),
  });
  return output;
}

function invalidInput(message: string): Error {
  const error = new Error(message);
  error.name = 'InvalidCsvEmailInputError';
  return error;
}

/**
 * Rethrows a storage failure under its own name, so the workflow's retries
 * still match it, with a message that leaves out the key: an S3 or KMS
 * message can quote the resource, and gamertag CSV keys name gamertags.
 */
async function withoutKeys<T>(
  operation: Promise<T>,
  action: string,
): Promise<T> {
  try {
    return await operation;
  } catch (error) {
    const name =
      error instanceof Error && error.name ? error.name : 'StorageError';
    const sanitized = new Error(`${action} failed with ${name}`);
    sanitized.name = name;
    throw sanitized;
  }
}

/**
 * An SES failure, with a message that names only the SES error: SES messages
 * can quote addresses. Throttling and server faults take the names the
 * workflow's retry policy matches (spec 1.1 §6.3), so they are retried; every
 * other failure fails the execution.
 */
function sendFailure(error: unknown): Error {
  const original =
    error instanceof Error && error.name ? error.name : 'EmailError';
  const name =
    original === 'TooManyRequestsException'
      ? 'ThrottlingException'
      : (error as { $fault?: unknown } | null)?.$fault === 'server'
        ? 'InternalServerError'
        : original;
  const sanitized = new Error(
    `Sending the gamertag CSV email failed with ${original}`,
  );
  sanitized.name = name;
  return sanitized;
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)
    ?.$metadata?.httpStatusCode;
}
