import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import type {
  AttachmentRejectionCode,
  ProcessEmailInput,
  ProcessEmailOutput,
  RejectedAttachment,
  S3ObjectReference,
  SourceScreenshot,
  SubmissionRejectionCode,
} from '@mcc/contracts';
import { simpleParser } from 'mailparser';
import sharp from 'sharp';
import { bodyToBuffer, namespacedObjectKey, safeObjectName } from '../lib/s3';
import { log } from '../lib/log';
import { evidenceId, now, putJson, sha256 } from '../lib/evidence';
import { MAX_IMAGE_BYTES } from '../lib/image-limits';
import { REPLY_LOCAL_PART } from '../lib/reply-address';

const s3 = new S3Client({});
const ssm = new SSMClient({});
const ses = new SESv2Client({});
const MIN_IMAGE_WIDTH = 640;
const MIN_IMAGE_HEIGHT = 360;

interface ParsedAttachment {
  content: Uint8Array;
  contentType: string;
  filename?: string;
  contentDisposition?: string;
  cid?: string;
}

interface HeaderLine {
  key: string;
  line: string;
}

interface ParsedEmail {
  messageId?: string;
  subject?: string;
  /** Header lines in message order; SES prepends its verdict headers. */
  headerLines?: readonly HeaderLine[];
  /** Addresses in the `From` header. */
  fromAddresses?: string[];
  /** The plain-text body. */
  text?: string;
  attachments: ParsedAttachment[];
}

/** A plain-text email that `process-email` sends through SES. */
export interface ReplyMessage {
  from: string;
  to: string[];
  subject: string;
  body: string;
  headers: Array<{ name: string; value: string }>;
}

/**
 * Verdicts SES adds when the receipt rule enables scanning. Null means the
 * header is absent.
 */
export interface SesVerdicts {
  spam: string | null;
  virus: string | null;
  spf: string | null;
  dkim: string | null;
}

export interface SenderAllowlistDecision {
  /**
   * NOT_CONFIGURED when the deployment names no parameter, the parameter does
   * not exist, or it lists no addresses. NOT_CONFIGURED and DENIED both reject
   * the message with SENDER_NOT_ALLOWED.
   */
  status: 'NOT_CONFIGURED' | 'ALLOWED' | 'DENIED';
  parameterName: string | null;
  fromAddresses: string[];
}

export interface RecipientDecision {
  /**
   * NOT_CONFIGURED for stable stacks, whose recipient the foundation's shared
   * receipt rule already fixes. Ephemeral stacks are ALLOWED or DENIED.
   */
  status: 'NOT_CONFIGURED' | 'ALLOWED' | 'DENIED';
  /** Envelope recipients from the Received header SES added. */
  recipients: string[];
}

export interface SubmissionScreening {
  sesVerdicts: SesVerdicts;
  senderAllowlist: SenderAllowlistDecision;
  recipientCheck: RecipientDecision;
  rejectionCodes: SubmissionRejectionCode[];
}

const VERDICT_HEADERS: Record<keyof SesVerdicts, string> = {
  spam: 'x-ses-spam-verdict',
  virus: 'x-ses-virus-verdict',
  spf: 'x-ses-spf-verdict',
  dkim: 'x-ses-dkim-verdict',
};

interface ImageMetadata {
  format?: string;
  width?: number;
  height?: number;
  space?: string;
  hasAlpha?: boolean;
  orientation?: number;
  depth?: string;
}

export interface ProcessEmailDependencies {
  getRawEmail(input: ProcessEmailInput): Promise<Buffer>;
  parseEmail(rawEmail: Buffer): Promise<ParsedEmail>;
  /** Allowed sender addresses, or undefined when the parameter does not exist. */
  getSenderAllowlist(parameterName: string): Promise<string[] | undefined>;
  /** A String parameter's value, or undefined when it does not exist. */
  getParameter(parameterName: string): Promise<string | undefined>;
  inspectImage(content: Buffer): Promise<ImageMetadata>;
  sendEmail(message: ReplyMessage): Promise<void>;
  putObject(
    reference: S3ObjectReference,
    body: Buffer,
    contentType: string,
  ): Promise<void>;
  writeJson(
    bucket: string,
    key: string,
    value: unknown,
  ): Promise<S3ObjectReference>;
  id(): string;
  timestamp(): string;
}

/**
 * Parses raw MIME. `text` holds only text/plain parts: HTML is never converted
 * to text, so an HTML-only body has no match date.
 */
export async function parseEmail(rawEmail: Buffer): Promise<ParsedEmail> {
  const parsed = await simpleParser(rawEmail, { skipHtmlToText: true });
  return {
    messageId: parsed.messageId,
    subject: parsed.subject,
    headerLines: parsed.headerLines,
    fromAddresses: (parsed.from?.value ?? []).flatMap((entry) =>
      entry.address ? [entry.address] : [],
    ),
    text: parsed.text,
    attachments: parsed.attachments,
  };
}

const defaultDependencies: ProcessEmailDependencies = {
  async getRawEmail(input) {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
    return bodyToBuffer(object.Body);
  },
  parseEmail,
  async getSenderAllowlist(parameterName) {
    const value = await readParameter(parameterName);
    return value === undefined ? undefined : parseSenderAllowlist(value);
  },
  getParameter: (parameterName) => readParameter(parameterName),
  async inspectImage(content) {
    return sharp(content, { failOn: 'none' }).metadata();
  },
  async sendEmail(message) {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: message.from,
        Destination: { ToAddresses: message.to },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: message.body, Charset: 'UTF-8' } },
            Headers:
              message.headers.length > 0
                ? message.headers.map(({ name, value }) => ({
                    Name: name,
                    Value: value,
                  }))
                : undefined,
          },
        },
      }),
    );
  },
  async putObject(reference, body, contentType) {
    await s3.send(
      new PutObjectCommand({
        Bucket: reference.bucket,
        Key: reference.key,
        Body: body,
        ContentType: contentType,
        IfNoneMatch: '*',
      }),
    );
  },
  writeJson: putJson,
  id: evidenceId,
  timestamp: now,
};

/** How long a warm Lambda reuses a parameter value it has read. */
const PARAMETER_CACHE_MS = 60_000;

/**
 * Returns a reader for String parameters that caches each value, including a
 * missing parameter, for `ttlMs`, so a burst of messages does not repeat the
 * same SSM reads. A change reaches warm Lambdas within `ttlMs`. Errors are not
 * cached.
 */
export function createParameterReader(
  getValue: (parameterName: string) => Promise<string | undefined>,
  ttlMs = PARAMETER_CACHE_MS,
  clock: () => number = Date.now,
): (parameterName: string) => Promise<string | undefined> {
  const cache = new Map<
    string,
    { value: string | undefined; expires: number }
  >();
  return async (parameterName) => {
    const cached = cache.get(parameterName);
    if (cached && cached.expires > clock()) return cached.value;
    const value = await getValue(parameterName);
    cache.set(parameterName, { value, expires: clock() + ttlMs });
    return value;
  };
}

const readParameter = createParameterReader(async (parameterName) => {
  try {
    const response = await ssm.send(
      new GetParameterCommand({ Name: parameterName }),
    );
    return response.Parameter?.Value ?? '';
  } catch (error) {
    if (error instanceof Error && error.name === 'ParameterNotFound') {
      return undefined;
    }
    if (error instanceof Error && error.name === 'AccessDeniedException') {
      // Ephemeral roles are capped by the local CDK bootstrap's boundary, and
      // a boundary that does not allow ssm:GetParameter denies every read.
      throw Object.assign(
        new Error(
          `Cannot read SSM parameter ${parameterName}: ${error.message}. For an ephemeral stack, re-run the local CDK bootstrap (docs/self-hosting/20-bootstrap-cdk.md) so its boundary allows ssm:GetParameter.`,
          { cause: error },
        ),
        { name: error.name },
      );
    }
    throw error;
  }
});

export async function handler(
  event: ProcessEmailInput,
): Promise<ProcessEmailOutput> {
  return processEmail(event, defaultDependencies);
}

export async function processEmail(
  event: ProcessEmailInput,
  dependencies: ProcessEmailDependencies,
): Promise<ProcessEmailOutput> {
  const evidenceBucket = requiredEnvironment('EVIDENCE_BUCKET');
  const receivedAt = readReceivedAt(event.receivedAt);
  log('INFO', 'Processing raw email', {
    bucket: event.bucket,
    key: event.key,
  });

  const parsed = await dependencies.parseEmail(
    await dependencies.getRawEmail(event),
  );
  // Read every parameter before writing evidence, so a transient SSM error
  // fails the invocation cleanly and a retry starts from scratch.
  const allowlistParameter = process.env.SENDER_ALLOWLIST_PARAMETER || null;
  const [allowlist, expectedRecipient] = await Promise.all([
    allowlistParameter
      ? dependencies.getSenderAllowlist(allowlistParameter)
      : undefined,
    readExpectedRecipient(dependencies),
  ]);
  const screening = screenSubmission(
    parsed,
    allowlistParameter,
    allowlist,
    expectedRecipient,
  );
  const matchDate = parseMatchDate(parsed.text);
  // The date is checked only once screening passes, so the reply below never
  // goes to a message that screening rejected.
  const submissionRejectionCodes: SubmissionRejectionCode[] =
    screening.rejectionCodes.length > 0
      ? screening.rejectionCodes
      : matchDate === undefined
        ? ['MATCH_DATE_INVALID']
        : [];
  const submissionId = dependencies.id();
  const submissionPrefix = namespacedObjectKey(`submissions/${submissionId}`);
  const screenshots: SourceScreenshot[] = [];
  const rejectedAttachments: RejectedAttachment[] = [];

  await dependencies.writeJson(
    evidenceBucket,
    `${submissionPrefix}/ingestion.json`,
    {
      schemaVersion: 'email-submission/v1',
      submissionId,
      rawEmail: { bucket: event.bucket, key: event.key },
      messageId: parsed.messageId,
      subject: parsed.subject,
      matchDate: matchDate ?? null,
      receivedAt: dependencies.timestamp(),
      attachmentCount: parsed.attachments.length,
      sesVerdicts: screening.sesVerdicts,
      senderAllowlist: screening.senderAllowlist,
      recipientCheck: screening.recipientCheck,
    },
  );

  try {
    // A screened-out message, or one without a valid match date, stores and
    // analyzes nothing; the raw MIME stays.
    const attachments =
      submissionRejectionCodes.length === 0 ? parsed.attachments : [];
    for (const [index, attachment] of attachments.entries()) {
      const attachmentName = safeObjectName(
        attachment.filename ?? `attachment-${index + 1}`,
      );
      const content = Buffer.from(attachment.content);

      if (!attachment.contentType.toLowerCase().startsWith('image/')) {
        rejectedAttachments.push({
          attachmentIndex: index,
          attachmentName,
          contentType: attachment.contentType,
          fileSizeBytes: content.byteLength,
          rejectionCodes: ['NOT_AN_IMAGE'],
        });
        continue;
      }

      const screenshotId = dependencies.id();
      const screenshotPrefix = `${submissionPrefix}/screenshots/${screenshotId}`;
      const source: S3ObjectReference = {
        bucket: evidenceBucket,
        key: `${screenshotPrefix}/source/original`,
      };
      await dependencies.putObject(source, content, attachment.contentType);

      let metadata: ImageMetadata = {};
      let metadataError: unknown;
      try {
        metadata = await dependencies.inspectImage(content);
      } catch (error) {
        metadataError = error;
      }

      const rejectionCodes = attachmentRejectionCodes(
        content,
        metadata,
        metadataError,
      );
      const screenshot: SourceScreenshot = {
        screenshotId,
        submissionId,
        ...source,
        attachmentName,
        contentType: attachment.contentType,
        sha256: sha256(content),
        acquisitionType: 'SCREENSHOT',
        widthPx: metadata.width ?? 0,
        heightPx: metadata.height ?? 0,
        ...(receivedAt === undefined ? {} : { receivedAt }),
      };

      await dependencies.writeJson(
        evidenceBucket,
        `${screenshotPrefix}/source/metadata.json`,
        {
          schemaVersion: 'source-screenshot/v1',
          ...screenshot,
          fileSizeBytes: content.byteLength,
          originalFilename: attachment.filename,
          contentDisposition: attachment.contentDisposition,
          contentId: attachment.cid,
          uploadedAt: dependencies.timestamp(),
          processingStatus:
            rejectionCodes.length === 0 ? 'ACCEPTED' : 'REJECTED',
          rejectionCodes,
          metadata,
          metadataError: metadataError
            ? errorSummary(metadataError)
            : undefined,
        },
      );

      if (rejectionCodes.length > 0) {
        rejectedAttachments.push({
          attachmentIndex: index,
          attachmentName,
          contentType: attachment.contentType,
          fileSizeBytes: content.byteLength,
          rejectionCodes,
          source,
        });
      } else {
        screenshots.push(screenshot);
      }
    }

    const rejectionCodes: SubmissionRejectionCode[] =
      submissionRejectionCodes.length > 0
        ? submissionRejectionCodes
        : screenshots.length === 0
          ? ['NO_PROCESSABLE_SCREENSHOTS']
          : [];
    const accepted = rejectionCodes.length === 0;
    const completedAt = dependencies.timestamp();
    await dependencies.writeJson(
      evidenceBucket,
      `${submissionPrefix}/completion.json`,
      {
        schemaVersion: 'email-submission-completion/v1',
        submissionId,
        status: accepted ? 'SUCCEEDED' : 'REJECTED',
        completedAt,
        acceptedScreenshotCount: screenshots.length,
        rejectedAttachments,
        rejectionCodes,
      },
    );
    await submissionEvent(
      dependencies,
      evidenceBucket,
      submissionPrefix,
      submissionId,
      accepted ? 'SUBMISSION_ACCEPTED' : 'SUBMISSION_REJECTED',
      {
        acceptedScreenshotCount: screenshots.length,
        rejectedAttachmentCount: rejectedAttachments.length,
        rejectionCodes,
        sesVerdicts: screening.sesVerdicts,
        senderAllowlist: screening.senderAllowlist,
        recipientCheck: screening.recipientCheck,
      },
    );

    if (submissionRejectionCodes.length > 0) {
      if (submissionRejectionCodes.includes('MATCH_DATE_INVALID')) {
        await replyMatchDateInvalid(
          dependencies,
          parsed,
          screening.senderAllowlist,
          submissionId,
        );
      }
      throw new SubmissionRejectedError(submissionRejectionCodes);
    }
    if (!accepted) throw new NoProcessableScreenshotsError();
  } catch (error) {
    if (!(error instanceof SubmissionRejectedError)) {
      const failure = errorSummary(error);
      await Promise.all([
        dependencies.writeJson(
          evidenceBucket,
          `${submissionPrefix}/completion.json`,
          {
            schemaVersion: 'email-submission-completion/v1',
            submissionId,
            status: 'FAILED',
            completedAt: dependencies.timestamp(),
            acceptedScreenshotCount: screenshots.length,
            rejectedAttachments,
            error: failure,
          },
        ),
        submissionEvent(
          dependencies,
          evidenceBucket,
          submissionPrefix,
          submissionId,
          'SUBMISSION_FAILED',
          { error: failure },
        ),
      ]).catch((recordError) => {
        log('ERROR', 'Unable to record submission failure', {
          submissionId,
          error: errorSummary(recordError),
        });
      });
    }
    throw error;
  }

  log('INFO', 'Raw email processed', {
    submissionId,
    screenshotCount: screenshots.length,
    rejectedAttachmentCount: rejectedAttachments.length,
  });
  return {
    status: 'ACCEPTED',
    submissionId,
    matchDate: matchDate as string,
    screenshots,
    rejectedAttachments,
    ...(receivedAt === undefined ? {} : { receivedAt }),
  };
}

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

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Reads the first valid `M/D/YYYY` calendar date in a plain-text body, with
 * optional leading zeros. Candidates touching a digit or slash are ignored.
 * Returns `YYYY-MM-DD`, or undefined when no valid date is found.
 */
export function parseMatchDate(text: string | undefined): string | undefined {
  const candidates = (text ?? '').matchAll(
    /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4})(?![\d/])/g,
  );
  for (const match of candidates) {
    const [month, day, year] = match.slice(1).map(Number);
    const leapYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const lastDay =
      month === 2 && leapYear ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
    if (day < 1 || day > lastDay) continue;
    return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return undefined;
}

const MATCH_DATE_REPLY_BODY = [
  'Your email was not processed because no valid match date was found in its plain-text body. Include the date as M/D/YYYY, such as 10/17/2026. The first valid date in the body is used. Surrounding text and signatures are allowed.',
  '',
  'Please send it again to the submission address with a valid match date in the body. Replies to this no-reply address are not read.',
  '',
].join('\n');

/**
 * The error reply to a message without a valid match date: from
 * `noreply@<domain>`, threaded under the original message when its ID is a
 * well-formed `<id>`.
 */
export function matchDateReply(
  email: Pick<ParsedEmail, 'messageId' | 'subject'>,
  to: string[],
  domain: string,
): ReplyMessage {
  const subject = (email.subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  const messageId = email.messageId?.trim();
  const threaded =
    messageId !== undefined &&
    messageId.length <= 870 &&
    /^<[\x21-\x3b\x3d\x3f-\x7e]+>$/.test(messageId);
  return {
    from: `${REPLY_LOCAL_PART}@${domain}`,
    to,
    subject: subject ? `Re: ${subject}` : 'Re:',
    body: MATCH_DATE_REPLY_BODY,
    headers: threaded
      ? [
          { name: 'In-Reply-To', value: messageId },
          { name: 'References', value: messageId },
        ]
      : [],
  };
}

/**
 * Sends the match date error reply to the sender. Only allowlisted senders get
 * one, so a reply goes only to an address on the allowlist. A failed send is
 * logged and leaves the recorded rejection unchanged. No log line holds an
 * address or email content.
 */
async function replyMatchDateInvalid(
  dependencies: ProcessEmailDependencies,
  email: ParsedEmail,
  senderAllowlist: SenderAllowlistDecision,
  submissionId: string,
): Promise<void> {
  if (senderAllowlist.status !== 'ALLOWED') {
    log('WARN', 'Match date reply not sent: sender not allowlisted', {
      submissionId,
    });
    return;
  }
  const domain = process.env.REPLY_FROM_DOMAIN;
  if (!domain) {
    log('ERROR', 'Match date reply not sent: REPLY_FROM_DOMAIN is not set', {
      submissionId,
    });
    return;
  }
  try {
    await dependencies.sendEmail(
      matchDateReply(email, senderAllowlist.fromAddresses, domain),
    );
    log('INFO', 'Match date reply sent', { submissionId });
  } catch (error) {
    // SES error messages can name addresses, so only the error name is logged.
    log('ERROR', 'Unable to send the match date reply', {
      submissionId,
      error: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

/**
 * An ephemeral stack names its alias and domain parameters and its own name.
 * Its receipt rule keeps the alias and domain from its last deploy, so the
 * recipient is checked against the values the foundation publishes now.
 * Returns undefined for a stable stack, which checks no recipient, and null
 * when either parameter does not exist, which denies every message.
 */
async function readExpectedRecipient(
  dependencies: ProcessEmailDependencies,
): Promise<string | null | undefined> {
  const aliasParameter = process.env.EMAIL_ALIAS_PARAMETER;
  const domainParameter = process.env.EMAIL_DOMAIN_PARAMETER;
  const subaddress = process.env.RECIPIENT_SUBADDRESS;
  if (!aliasParameter && !domainParameter && !subaddress) return undefined;
  if (!aliasParameter || !domainParameter || !subaddress) {
    throw new Error(
      'EMAIL_ALIAS_PARAMETER, EMAIL_DOMAIN_PARAMETER, and RECIPIENT_SUBADDRESS must be set together',
    );
  }
  const [alias, domain] = await Promise.all([
    dependencies.getParameter(aliasParameter),
    dependencies.getParameter(domainParameter),
  ]);
  return alias && domain ? `${alias}+${subaddress}@${domain}` : null;
}

/**
 * Decides whether a message may be processed at all. A FAIL spam or virus
 * verdict rejects it, and so does a sender allowlist that does not list every
 * `From` address. A missing parameter (undefined `allowlist`), an allowlist
 * with no addresses, or no parameter name rejects every message. For an
 * ephemeral stack, so does a message whose SES recipients do not include the
 * current `<alias>+<name>@<domain>`: undefined `expectedRecipient` skips that
 * check, and null denies every message. SPF and DKIM verdicts are recorded,
 * not enforced.
 */
export function screenSubmission(
  email: Pick<ParsedEmail, 'headerLines' | 'fromAddresses'>,
  allowlistParameter: string | null,
  allowlist: string[] | undefined,
  expectedRecipient?: string | null,
): SubmissionScreening {
  const sesVerdicts = parseSesVerdicts(email.headerLines ?? []);
  const fromAddresses = (email.fromAddresses ?? []).map((address) =>
    address.trim().toLowerCase(),
  );
  const rejectionCodes: SubmissionRejectionCode[] = [];
  if (sesVerdicts.spam === 'FAIL') rejectionCodes.push('SPAM_VERDICT_FAILED');
  if (sesVerdicts.virus === 'FAIL') rejectionCodes.push('VIRUS_VERDICT_FAILED');

  const allowed = new Set(
    (allowlist ?? [])
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
  const status: SenderAllowlistDecision['status'] =
    allowlistParameter === null || allowed.size === 0
      ? 'NOT_CONFIGURED'
      : fromAddresses.length > 0 &&
          fromAddresses.every((address) => allowed.has(address))
        ? 'ALLOWED'
        : 'DENIED';
  if (status !== 'ALLOWED') rejectionCodes.push('SENDER_NOT_ALLOWED');

  const recipients = parseSesRecipients(email.headerLines ?? []);
  let recipientStatus: RecipientDecision['status'] = 'NOT_CONFIGURED';
  if (expectedRecipient !== undefined) {
    // SES lists only recipients that a rule in the set accepted, so a rule
    // left on an old alias or domain never lists the current address. Other
    // recipients, such as the shared address or another stack, are expected.
    recipientStatus =
      expectedRecipient !== null &&
      recipients.includes(expectedRecipient.toLowerCase())
        ? 'ALLOWED'
        : 'DENIED';
    if (recipientStatus === 'DENIED') {
      rejectionCodes.push('RECIPIENT_NOT_ALLOWED');
    }
  }

  return {
    sesVerdicts,
    senderAllowlist: {
      status,
      parameterName: allowlistParameter,
      fromAddresses,
    },
    recipientCheck: { status: recipientStatus, recipients },
    rejectionCodes,
  };
}

/**
 * Reads the envelope recipients from the `for` clause of the first (topmost)
 * Received header, which SES prepends when it accepts the message, as in
 * `Received: from ... by inbound-smtp.<region>.amazonaws.com with SMTP id ...
 * for alias+name@example.com; <date>`. The clause is read only at the end of
 * the header, just before the date, so text the sending server chose earlier
 * in the header, such as its HELO name, cannot supply it. Comments and
 * anything that is not an address are ignored. Returns no recipients when the
 * header or the clause is missing.
 */
export function parseSesRecipients(
  headerLines: readonly HeaderLine[],
): string[] {
  const value = topmostHeaderValue(headerLines, 'received');
  if (value === undefined) return [];
  const end = value.lastIndexOf(';');
  // The greedy prefix makes the last ` for ` win.
  const clause = /^.*\sfor\s+(.+?)\s*$/is.exec(
    ` ${end === -1 ? value : value.slice(0, end)}`,
  )?.[1];
  if (clause === undefined) return [];
  return clause
    .replace(/\([^)]*\)/g, ' ')
    .split(/[\s,]+/)
    .map((entry) => entry.replace(/^<|>$/g, '').toLowerCase())
    .filter((entry) => /^[^@<>]+@[^@<>]+$/.test(entry));
}

/**
 * The unfolded value of the first (topmost) header with this lowercase name.
 * SES prepends its own headers, so a copy the sender wrote further down cannot
 * override it.
 */
function topmostHeaderValue(
  headerLines: readonly HeaderLine[],
  name: string,
): string | undefined {
  const line = headerLines.find(
    (candidate) => candidate.key.toLowerCase() === name,
  )?.line;
  return line
    ?.slice(line.indexOf(':') + 1)
    .replace(/\r?\n[ \t]+/g, ' ')
    .trim();
}

/**
 * Reads each verdict from its first (topmost) header. SES prepends its own
 * headers, so a copy the sender wrote further down cannot override it.
 */
export function parseSesVerdicts(
  headerLines: readonly HeaderLine[],
): SesVerdicts {
  const verdicts: SesVerdicts = {
    spam: null,
    virus: null,
    spf: null,
    dkim: null,
  };
  for (const name of Object.keys(VERDICT_HEADERS) as Array<keyof SesVerdicts>) {
    const value = topmostHeaderValue(headerLines, VERDICT_HEADERS[name]);
    if (value !== undefined) verdicts[name] = value.toUpperCase();
  }
  return verdicts;
}

/** Splits a parameter value on commas and whitespace into lowercase addresses. */
export function parseSenderAllowlist(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.toLowerCase())
    .filter((entry) => entry.length > 0);
}

export function attachmentRejectionCodes(
  content: Buffer,
  metadata: ImageMetadata,
  metadataError?: unknown,
): AttachmentRejectionCode[] {
  const codes: AttachmentRejectionCode[] = [];
  if (metadataError) codes.push('UNREADABLE_IMAGE');
  if (metadata.format && !['png', 'jpeg', 'jpg'].includes(metadata.format)) {
    codes.push('UNSUPPORTED_IMAGE_FORMAT');
  }
  if (content.byteLength > MAX_IMAGE_BYTES) codes.push('IMAGE_TOO_LARGE');
  if (
    metadata.width != null &&
    metadata.height != null &&
    (metadata.width < MIN_IMAGE_WIDTH || metadata.height < MIN_IMAGE_HEIGHT)
  ) {
    codes.push('IMAGE_TOO_SMALL');
  }
  if (!metadataError && !metadata.format) codes.push('UNREADABLE_IMAGE');
  return codes;
}

async function submissionEvent(
  dependencies: ProcessEmailDependencies,
  bucket: string,
  prefix: string,
  submissionId: string,
  type: string,
  detail: unknown,
): Promise<S3ObjectReference> {
  const occurredAt = dependencies.timestamp();
  return dependencies.writeJson(
    bucket,
    `${prefix}/events/${occurredAt}-${dependencies.id()}.json`,
    {
      schemaVersion: 'submission-event/v1',
      submissionId,
      type,
      occurredAt,
      detail,
    },
  );
}

function errorSummary(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { name: 'UnknownError', message: String(error) };
}

/** A recorded rejection: the workflow fails, but not as a FAILED submission. */
class SubmissionRejectedError extends Error {
  constructor(rejectionCodes: SubmissionRejectionCode[]) {
    super(`Submission rejected: ${rejectionCodes.join(', ')}`);
    this.name = 'SubmissionRejectedError';
  }
}

class NoProcessableScreenshotsError extends SubmissionRejectedError {
  constructor() {
    super(['NO_PROCESSABLE_SCREENSHOTS']);
    this.message = 'Email contains no processable screenshot attachments';
    this.name = 'NoProcessableScreenshotsError';
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
