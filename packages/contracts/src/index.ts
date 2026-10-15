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
  rows: CsvRow[];
  normalizedArtifact: S3ObjectReference;
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
