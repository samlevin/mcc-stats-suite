/**
 * Largest image, in bytes, that Textract's synchronous AnalyzeDocument
 * accepts as raw bytes: 10 MB (10,000,000 bytes), not 10 MiB. Intake rejects
 * anything larger so the failure is a recorded rejection, not a failed run.
 */
export const MAX_IMAGE_BYTES = 10_000_000;
