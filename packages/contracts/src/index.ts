export interface S3ObjectReference {
  bucket: string;
  key: string;
}

export type AcquisitionType = 'SCREENSHOT' | 'PHOTO' | 'OTHER';

/** The state machine that invoked a Lambda (spec 1.3 §4.1). */
export type WorkflowKind = 'INGEST' | 'REPLAY';

/**
 * The Step Functions context a workflow can pass to a Lambda task (spec 1.3
 * §4.1). It is absent when the task payload does not set it, as in direct
 * invocations. Handlers read it as untrusted input and never reject a
 * malformed value.
 */
export interface TraceContext {
  /** `$$.Execution.Id`, the execution ARN. */
  executionId: string;
  /** `$$.State.RetryCount`. */
  retryCount: number;
  workflow: WorkflowKind;
}

export interface SourceScreenshot extends S3ObjectReference {
  screenshotId: string;
  submissionId: string;
  attachmentName: string;
  contentType: string;
  sha256: string;
  acquisitionType: AcquisitionType;
  widthPx: number;
  heightPx: number;
  /**
   * When S3 received the raw email, as ISO 8601, copied from
   * `ProcessEmailInput.receivedAt`. Absent when the input had none, and in
   * documents written before it existed.
   */
  receivedAt?: string;
}

/**
 * Why a person should check an extracted value against the screenshot.
 *
 * - `LOW_WORD_CONFIDENCE`: a word of the value has a very low Textract WORD
 *   confidence.
 * - `SPLIT_TRAILING_DIGITS`: the value ends in a digits-only word that follows
 *   a word ending in a letter, or in a letter followed by punctuation, and
 *   Textract read one of the two with low confidence, so the space and any
 *   punctuation between them may be a misread.
 * - `UNMAPPED_COLUMN`: the parser could not tell which column holds the stat,
 *   so the value is empty.
 */
export type RowReviewCode =
  'LOW_WORD_CONFIDENCE' | 'SPLIT_TRAILING_DIGITS' | 'UNMAPPED_COLUMN';

/** A deterministic review flag on one field of an extracted row. */
export type RowReviewFlag =
  | {
      field: 'player';
      code: 'LOW_WORD_CONFIDENCE' | 'SPLIT_TRAILING_DIGITS';
      /** Lowest Textract WORD confidence, 0 to 100, among the words the rule read. */
      wordConfidence: number;
    }
  | {
      field: 'score' | 'kills' | 'assists' | 'deaths';
      code: 'UNMAPPED_COLUMN';
    };

/**
 * How an observed cell differs from what the screenshot shows (spec 2.3 §7.3).
 * Defined once here and shared by roster resolutions (spec 1.2 §7.5) and cell
 * labeling. A list of these is sorted and has no duplicates.
 */
export type CellErrorType =
  | 'GLYPH_SUBSTITUTION'
  | 'MISSING_CHARACTERS'
  | 'EXTRA_CHARACTERS'
  | 'SHIFTED_CELL'
  | 'MERGED_CELL'
  | 'OTHER';

export type RosterChangeAction = 'ADD' | 'DEACTIVATE' | 'REACTIVATE';

/**
 * One append-only change to a roster namespace (spec 1.2 §5.1). Stored as a
 * roster table change item and never updated or deleted.
 */
export interface RosterChange {
  schemaVersion: 'roster-change/v1';
  /** `stable`, or `ephemeral/<name>` for an ephemeral stack. */
  namespace: string;
  /** 1-based, with no gaps within a namespace. */
  rosterVersion: number;
  action: RosterChangeAction;
  /** Assigned by `ADD` with `evidenceId()`. */
  gamertagId: string;
  /** The validated display text (spec 1.2 §4.3). */
  gamertag: string;
  /** At most 256 characters. */
  reason: string | null;
  /** The IAM ARN of the caller who wrote the change, from STS. */
  actorArn: string;
  clientRequestId: string;
  changedAt: string;
  /** The roster hash after this change (spec 1.2 §5.1). */
  rosterSha256: string;
}

export interface RosterEntry {
  gamertagId: string;
  gamertag: string;
}

/** The active entries of one roster version, stored at `roster/versions/{rosterVersion}.json`. */
export interface RosterSnapshot {
  schemaVersion: 'roster-snapshot/v1';
  namespace: string;
  rosterVersion: number;
  rosterSha256: string;
  /** Active entries only, sorted by `gamertagId`. */
  entries: readonly RosterEntry[];
}

/** The roster version a processing run matched against, and its snapshot. */
export interface RosterReference {
  namespace: string;
  rosterVersion: number;
  rosterSha256: string;
  snapshot: S3ObjectReference;
}

export type RecipientChangeAction = 'ADD' | 'DEACTIVATE' | 'REACTIVATE';

/**
 * One append-only change to a CSV recipient list namespace (spec 1.1 §4.5).
 * Stored as a recipient table change item and never updated or deleted.
 */
export interface RecipientChange {
  /** 1-based, with no gaps within a namespace. */
  recipientsVersion: number;
  action: RecipientChangeAction;
  /** A UUID assigned by `ADD`. */
  recipientId: string;
  /** The validated, trimmed address, with its case as entered. */
  address: string;
  /** At most 256 characters. */
  reason: string | null;
  /** The IAM ARN of the caller who wrote the change, from STS. */
  actorArn: string;
  clientRequestId: string;
  changedAt: string;
}

/** One active recipient of the per-gamertag CSVs. */
export interface RecipientEntry {
  recipientId: string;
  address: string;
}

export type PlayerMatchStatus = 'EXACT' | 'RESOLVED' | 'UNMATCHED';

export type UnmatchedReason = 'NO_CANDIDATE' | 'AMBIGUOUS' | 'ENTRY_CLAIMED';

/**
 * The roster match for one row's player name (spec 1.2 §7). It never changes
 * the name as read.
 */
export interface PlayerResolution {
  status: PlayerMatchStatus;
  /** `CsvRow.player`, the tidied name as read. */
  asRead: string;
  /** Null when `UNMATCHED`. */
  gamertagId: string | null;
  /** Null when `UNMATCHED`. */
  gamertag: string | null;
  /** The smallest key distance; 0 for `EXACT`; null when no entry was compared. */
  keyDistance: number | null;
  /** The next smallest key distance; null when no other entry exists. */
  runnerUpDistance: number | null;
  /** Distance from `asRead` to `gamertag`; null when `UNMATCHED`. */
  textDistance: number | null;
  /** Set for `RESOLVED` only; sorted. */
  errorTypes: readonly CellErrorType[];
  unmatchedReason: UnmatchedReason | null;
}

export interface CsvRow {
  team: string;
  player: string;
  score: string;
  kills: string;
  assists: string;
  deaths: string;
  win: number;
  loss: number;
  /**
   * Present only when a rule flags the row. Flags never change the values,
   * which stay as read. The CSV file does not include them.
   */
  reviewFlags?: RowReviewFlag[];
  /**
   * The roster match for `player`, in normalized observations and the export
   * from spec 1.2 P3.2 on. It never changes `player`.
   */
  playerResolution?: PlayerResolution;
}

/** The raw email object, plus the context the ingest workflow can add. */
export interface ProcessEmailInput extends S3ObjectReference {
  /** `$.time` of the S3 `Object Created` event, as ISO 8601. */
  receivedAt?: string;
  trace?: TraceContext;
}

export interface ProcessEmailOutput {
  status: 'ACCEPTED';
  submissionId: string;
  /**
   * The first valid match date in the plain-text email body, as `YYYY-MM-DD`.
   * A submission without a valid date is rejected with `MATCH_DATE_INVALID`,
   * so it is always set.
   */
  matchDate: string;
  screenshots: SourceScreenshot[];
  rejectedAttachments: RejectedAttachment[];
  /** `ProcessEmailInput.receivedAt`, when the input had a well-formed one. */
  receivedAt?: string;
}

/** The result for a submission rejected as a whole (spec 1.3 §10.1). */
export interface ProcessEmailRejectedOutput {
  status: 'REJECTED';
  submissionId: string;
  rejectionCodes: SubmissionRejectionCode[];
}

/** A `process-email` result of either kind, told apart by `status`. */
export type ProcessEmailResult =
  ProcessEmailOutput | ProcessEmailRejectedOutput;

export type AttachmentRejectionCode =
  | 'NOT_AN_IMAGE'
  | 'UNREADABLE_IMAGE'
  | 'UNSUPPORTED_IMAGE_FORMAT'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_TOO_SMALL';

/**
 * Why a whole submission was rejected. Screening codes (SES verdicts, the
 * sender allowlist, and an ephemeral stack's recipient check) stop a message
 * before any attachment is stored. `MATCH_DATE_INVALID` is checked only after
 * screening passes, when the plain-text body contains no valid `M/D/YYYY` date,
 * and also stops the message before any attachment is stored.
 */
export type SubmissionRejectionCode =
  | 'NO_PROCESSABLE_SCREENSHOTS'
  | 'SPAM_VERDICT_FAILED'
  | 'VIRUS_VERDICT_FAILED'
  | 'SENDER_NOT_ALLOWED'
  | 'RECIPIENT_NOT_ALLOWED'
  | 'MATCH_DATE_INVALID';

export interface RejectedAttachment {
  attachmentIndex: number;
  attachmentName: string;
  contentType: string;
  fileSizeBytes: number;
  rejectionCodes: AttachmentRejectionCode[];
  source?: S3ObjectReference;
}

export interface ProcessingRunInput {
  source: SourceScreenshot;
  trace?: TraceContext;
}

export interface ExtractTextOutput {
  runId: string;
  source: SourceScreenshot;
  /** These rows never carry `playerResolution`. */
  rows: CsvRow[];
  normalizedArtifact: S3ObjectReference;
  /** Present on runs from spec 1.2 P3.1 on. */
  roster?: RosterReference;
  trace?: TraceContext;
}

export interface WriteExtractedCsvOutput extends S3ObjectReference {
  runId: string;
  rowCount: number;
}

/**
 * Input of the main workflow's per-gamertag export step. `exports` holds each
 * `Map` item's `WriteExtractedCsvOutput`, in `ProcessEmailOutput.screenshots`
 * order.
 */
export interface WriteGamertagCsvsInput {
  submissionId: string;
  /** `ProcessEmailOutput.matchDate`, as `YYYY-MM-DD`. */
  matchDate: string;
  exports: WriteExtractedCsvOutput[];
  /** `ProcessEmailOutput.receivedAt`, when present. */
  receivedAt?: string;
  trace?: TraceContext;
}

/**
 * Output of the per-gamertag export step. File keys name gamertags, so the
 * output carries only the submission's export prefix and counts.
 */
export interface WriteGamertagCsvsOutput {
  submissionId: string;
  /** `[ephemeral/<name>/]submissions/{submissionId}/export/gamertags/` */
  prefix: string;
  /** Files for gamertags with at least one `EXACT` or `RESOLVED` row. */
  fileCount: number;
  /** Lines across those files, one per `EXACT` or `RESOLVED` row. */
  rowCount: number;
}

/**
 * Input of the main workflow's results email step, which runs after the
 * per-gamertag export step.
 */
export interface EmailGamertagCsvsInput {
  submissionId: string;
  /** `ProcessEmailOutput.matchDate`, as `YYYY-MM-DD`. */
  matchDate: string;
  /** The number of `ProcessEmailOutput.screenshots`. */
  screenshotCount: number;
  gamertagCsvs: WriteGamertagCsvsOutput;
  trace?: TraceContext;
}

/**
 * What the results email step did. `SENT`: SES accepted one email to every
 * active recipient. `NOT_CONFIGURED`: the recipient list has no active
 * entry. `NO_FILES`: the submission has no per-gamertag CSV.
 */
export type CsvEmailDeliveryStatus = 'SENT' | 'NOT_CONFIGURED' | 'NO_FILES';

/**
 * The submission's `export/csv-email.json`, written once. It names the
 * attachments but never an address.
 */
export interface CsvEmailDelivery {
  schemaVersion: 'csv-email-delivery/v1';
  submissionId: string;
  status: CsvEmailDeliveryStatus;
  /** The SES message ID; null unless `SENT`. */
  sesMessageId: string | null;
  recipientsVersion: number;
  /** Active recipients at `recipientsVersion`. */
  recipientCount: number;
  screenshotCount: number;
  /** The per-gamertag CSV file names, sorted. */
  attachments: string[];
  recordedAt: string;
}

/**
 * Output of the results email step. Attachment names name gamertags, so the
 * output carries counts only.
 */
export interface EmailGamertagCsvsOutput {
  submissionId: string;
  status: CsvEmailDeliveryStatus;
  sesMessageId: string | null;
  recipientsVersion: number;
  recipientCount: number;
  attachmentCount: number;
  /** The delivery record, `[ephemeral/<name>/]submissions/{submissionId}/export/csv-email.json`. */
  key: string;
}

export type DatasetSplit = 'TRAIN' | 'VALIDATION' | 'TEST';

export interface MaterializeTrainingDataInput {
  bucket: string;
  normalizedKeys: string[];
  splitSeed?: string;
}

export interface MaterializeTrainingDataOutput {
  datasetId: string;
  bucket: string;
  prefix: string;
  manifest: S3ObjectReference;
  files: Record<Lowercase<DatasetSplit>, S3ObjectReference>;
  counts: Record<Lowercase<DatasetSplit>, number>;
}

/** Body of `POST /v1/gamertags` on the roster API (spec 1.2 §4.1). */
export interface AddGamertagRequest {
  gamertag: string;
  reason?: string;
  clientRequestId: string;
}

/** Body of `POST /v1/gamertags/{gamertagId}/deactivate` and `/reactivate`. */
export interface ChangeGamertagStatusRequest {
  reason?: string;
  clientRequestId: string;
}

/** Response to a successful roster API write. */
export interface RosterChangeResponse {
  change: RosterChange;
  entry: RosterEntry & { status: 'ACTIVE' | 'INACTIVE' };
  rosterVersion: number;
  rosterSha256: string;
  /** Active gamertags whose key is one edit from the new entry's key. */
  warnings: { nearKeyGamertags: readonly string[] };
}
