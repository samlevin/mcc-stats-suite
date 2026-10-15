import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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

const s3 = new S3Client({});
const ssm = new SSMClient({});
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
  attachments: ParsedAttachment[];
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
  /** NOT_CONFIGURED when the deployment names no parameter or it does not exist. */
  status: 'NOT_CONFIGURED' | 'ALLOWED' | 'DENIED';
  parameterName: string | null;
  fromAddresses: string[];
}

export interface SubmissionScreening {
  sesVerdicts: SesVerdicts;
  senderAllowlist: SenderAllowlistDecision;
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
  inspectImage(content: Buffer): Promise<ImageMetadata>;
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

const defaultDependencies: ProcessEmailDependencies = {
  async getRawEmail(input) {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: input.bucket, Key: input.key }),
    );
    return bodyToBuffer(object.Body);
  },
  async parseEmail(rawEmail) {
    const parsed = await simpleParser(rawEmail);
    return {
      messageId: parsed.messageId,
      subject: parsed.subject,
      headerLines: parsed.headerLines,
      fromAddresses: (parsed.from?.value ?? []).flatMap((entry) =>
        entry.address ? [entry.address] : [],
      ),
      attachments: parsed.attachments,
    };
  },
  async getSenderAllowlist(parameterName) {
    try {
      const response = await ssm.send(
        new GetParameterCommand({ Name: parameterName }),
      );
      return parseSenderAllowlist(response.Parameter?.Value ?? '');
    } catch (error) {
      if (error instanceof Error && error.name === 'ParameterNotFound') {
        return undefined;
      }
      throw error;
    }
  },
  async inspectImage(content) {
    return sharp(content, { failOn: 'none' }).metadata();
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
  log('INFO', 'Processing raw email', {
    bucket: event.bucket,
    key: event.key,
  });

  const parsed = await dependencies.parseEmail(
    await dependencies.getRawEmail(event),
  );
  // Read the allowlist before writing evidence, so a transient SSM error
  // fails the invocation cleanly and a retry starts from scratch.
  const allowlistParameter = process.env.SENDER_ALLOWLIST_PARAMETER || null;
  const allowlist = allowlistParameter
    ? await dependencies.getSenderAllowlist(allowlistParameter)
    : undefined;
  const screening = screenSubmission(parsed, allowlistParameter, allowlist);
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
      rawEmail: event,
      messageId: parsed.messageId,
      subject: parsed.subject,
      receivedAt: dependencies.timestamp(),
      attachmentCount: parsed.attachments.length,
      sesVerdicts: screening.sesVerdicts,
      senderAllowlist: screening.senderAllowlist,
    },
  );

  try {
    // A screened-out message stores and analyzes nothing; the raw MIME stays.
    const attachments =
      screening.rejectionCodes.length === 0 ? parsed.attachments : [];
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
      screening.rejectionCodes.length > 0
        ? screening.rejectionCodes
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
      },
    );

    if (screening.rejectionCodes.length > 0) {
      throw new SubmissionRejectedError(screening.rejectionCodes);
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
  return { submissionId, screenshots, rejectedAttachments };
}

/**
 * Decides whether a message may be processed at all. A FAIL spam or virus
 * verdict rejects it, and so does a configured allowlist that does not list
 * every `From` address. SPF and DKIM verdicts are recorded, not enforced.
 */
export function screenSubmission(
  email: Pick<ParsedEmail, 'headerLines' | 'fromAddresses'>,
  allowlistParameter: string | null,
  allowlist: string[] | undefined,
): SubmissionScreening {
  const sesVerdicts = parseSesVerdicts(email.headerLines ?? []);
  const fromAddresses = (email.fromAddresses ?? []).map((address) =>
    address.trim().toLowerCase(),
  );
  const rejectionCodes: SubmissionRejectionCode[] = [];
  if (sesVerdicts.spam === 'FAIL') rejectionCodes.push('SPAM_VERDICT_FAILED');
  if (sesVerdicts.virus === 'FAIL') rejectionCodes.push('VIRUS_VERDICT_FAILED');

  let status: SenderAllowlistDecision['status'] = 'NOT_CONFIGURED';
  if (allowlist) {
    const allowed = new Set(allowlist.map((entry) => entry.toLowerCase()));
    status =
      fromAddresses.length > 0 &&
      fromAddresses.every((address) => allowed.has(address))
        ? 'ALLOWED'
        : 'DENIED';
    if (status === 'DENIED') rejectionCodes.push('SENDER_NOT_ALLOWED');
  }

  return {
    sesVerdicts,
    senderAllowlist: {
      status,
      parameterName: allowlistParameter,
      fromAddresses,
    },
    rejectionCodes,
  };
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
    const line = headerLines.find(
      (candidate) => candidate.key.toLowerCase() === VERDICT_HEADERS[name],
    )?.line;
    if (line === undefined) continue;
    verdicts[name] = line
      .slice(line.indexOf(':') + 1)
      .replace(/\r?\n[ \t]+/g, ' ')
      .trim()
      .toUpperCase();
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
