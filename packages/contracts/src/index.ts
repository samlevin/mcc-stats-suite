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

export interface CsvRow {
  team: string;
  player: string;
  score: string;
  kills: string;
  assists: string;
  deaths: string;
  win: number;
  loss: number;
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
