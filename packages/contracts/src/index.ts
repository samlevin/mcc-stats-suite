export interface S3ObjectReference {
  bucket: string;
  key: string;
}

export interface MatchAttachment extends S3ObjectReference {
  attachmentName: string;
  contentType: string;
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
  matchId: string;
  attachments: MatchAttachment[];
}

export interface PreprocessImageOutput {
  matchId: string;
  source: MatchAttachment;
  preprocessed: S3ObjectReference;
}

export interface ExtractTextOutput {
  matchId: string;
  attachmentName: string;
  rows: CsvRow[];
}

export interface WriteMatchCsvInput {
  matchId: string;
  results: ExtractTextOutput[];
}

export interface WriteMatchCsvOutput extends S3ObjectReference {
  matchId: string;
  rowCount: number;
}
