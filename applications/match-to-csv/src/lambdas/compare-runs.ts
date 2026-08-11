import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { bodyToBuffer } from '../lib/s3';

const s3 = new S3Client({});

export async function handler(event: { bucket: string; baselineKey: string; candidateKey: string; outputKey: string }) {
  const [baseline, candidate] = await Promise.all([event.baselineKey, event.candidateKey].map(async (key) => {
    const object = await s3.send(new GetObjectCommand({ Bucket: event.bucket, Key: key }));
    return JSON.parse((await bodyToBuffer(object.Body)).toString('utf8'));
  }));
  type Cell = { tableLocation?: { rowIndex?: number; columnIndex?: number }; observedText?: string; confidence?: number };
  const byCell = (value: any): Map<string, Cell> => new Map((value.cells ?? []).map((cell: Cell) => [`${cell.tableLocation?.rowIndex}:${cell.tableLocation?.columnIndex}`, cell]));
  const before = byCell(baseline); const after = byCell(candidate);
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changes = [...keys].flatMap((key) => {
    const left = before.get(key); const right = after.get(key);
    return JSON.stringify(left?.observedText) === JSON.stringify(right?.observedText) ? [] : [{ coordinate: key, before: left?.observedText, after: right?.observedText, beforeConfidence: left?.confidence, afterConfidence: right?.confidence }];
  });
  const result = { schemaVersion: 'run-comparison/v1', baselineRunId: baseline.runId, candidateRunId: candidate.runId, comparedAt: new Date().toISOString(), summary: { baselineCellCount: before.size, candidateCellCount: after.size, changedCellCount: changes.length }, changes };
  await s3.send(new PutObjectCommand({ Bucket: event.bucket, Key: event.outputKey, Body: JSON.stringify(result), ContentType: 'application/json' }));
  return result;
}
