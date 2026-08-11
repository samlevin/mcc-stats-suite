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

export interface ProcessEmailInput extends S3ObjectReference {}

export interface ProcessEmailOutput {
  submissionId: string;
  screenshots: SourceScreenshot[];
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
