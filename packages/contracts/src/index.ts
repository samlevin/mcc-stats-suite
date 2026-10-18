export interface S3ObjectReference {
  bucket: string;
  key: string;
}

export type AcquisitionType = 'SCREENSHOT' | 'PHOTO' | 'OTHER';

export interface SourceScreenshot extends S3ObjectReference {
  screenshotId: string;
  submissionId: string;
  attachmentName: string;
  contentType: string;
  sha256: string;
  acquisitionType: AcquisitionType;
  widthPx: number;
  heightPx: number;
}

/**
 * Why a person should check an extracted value against the screenshot.
 *
 * - `LOW_WORD_CONFIDENCE`: a word of the value has a very low Textract WORD
 *   confidence.
 * - `SPLIT_TRAILING_DIGITS`: the value ends in a digits-only word that follows
 *   a word ending in a letter, and Textract read one of the two with low
 *   confidence, so the space between them may be a misread.
 */
export type RowReviewCode = 'LOW_WORD_CONFIDENCE' | 'SPLIT_TRAILING_DIGITS';

/** A deterministic review flag on one field of an extracted row. */
export interface RowReviewFlag {
  field: 'player';
  code: RowReviewCode;
  /** Lowest Textract WORD confidence, 0 to 100, among the words the rule read. */
  wordConfidence: number;
}

/**
 * How an observed cell differs from what the screenshot shows (spec 3 §7.3).
 * Defined once here and shared by roster resolutions (spec 6 §7.5) and cell
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
 * One append-only change to a roster namespace (spec 6 §5.1). Stored as a
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
  /** The validated display text (spec 6 §4.3). */
  gamertag: string;
  /** At most 256 characters. */
  reason: string | null;
  /** The IAM `userArn` of the function URL caller. */
  actorArn: string;
  clientRequestId: string;
  changedAt: string;
  /** The roster hash after this change (spec 6 §5.1). */
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

export type PlayerMatchStatus = 'EXACT' | 'RESOLVED' | 'UNMATCHED';

export type UnmatchedReason = 'NO_CANDIDATE' | 'AMBIGUOUS' | 'ENTRY_CLAIMED';

/**
 * The roster match for one row's player name (spec 6 §7). It never changes
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
   * from spec 6 P3.2 on. It never changes `player`.
   */
  playerResolution?: PlayerResolution;
}

export type ProcessEmailInput = S3ObjectReference;

export interface ProcessEmailOutput {
  submissionId: string;
  screenshots: SourceScreenshot[];
  rejectedAttachments: RejectedAttachment[];
}

export type AttachmentRejectionCode =
  | 'NOT_AN_IMAGE'
  | 'UNREADABLE_IMAGE'
  | 'UNSUPPORTED_IMAGE_FORMAT'
  | 'IMAGE_TOO_LARGE'
  | 'IMAGE_TOO_SMALL';

/**
 * Why a whole submission was rejected. Screening codes (SES verdicts, the
 * sender allowlist, and an ephemeral stack's recipient check) stop a message
 * before any attachment is stored.
 */
export type SubmissionRejectionCode =
  | 'NO_PROCESSABLE_SCREENSHOTS'
  | 'SPAM_VERDICT_FAILED'
  | 'VIRUS_VERDICT_FAILED'
  | 'SENDER_NOT_ALLOWED'
  | 'RECIPIENT_NOT_ALLOWED';

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
}

export interface ExtractTextOutput {
  runId: string;
  source: SourceScreenshot;
  /** These rows never carry `playerResolution`. */
  rows: CsvRow[];
  normalizedArtifact: S3ObjectReference;
  /** Present on runs from spec 6 P3.1 on. */
  roster?: RosterReference;
}

export interface WriteExtractedCsvOutput extends S3ObjectReference {
  runId: string;
  rowCount: number;
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

/** Body of `POST /v1/gamertags` on the roster API (spec 6 §4.1). */
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
