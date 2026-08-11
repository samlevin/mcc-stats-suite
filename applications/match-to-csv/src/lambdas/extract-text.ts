import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { AnalyzeDocumentCommand, TextractClient, type Block } from '@aws-sdk/client-textract';
import type { ExtractTextOutput, ProcessingRunInput } from '@mcc/contracts';
import sharp from 'sharp';
import { bodyToBuffer } from '../lib/s3';
import { evidenceId, now, putJson, sha256 } from '../lib/evidence';
import { log } from '../lib/log';
import { processScoreboardImage, type RowColor, type TextractBlockLite } from '../lib/scoreboard-logic';

const s3 = new S3Client({});
const textract = new TextractClient({});

const versions = {
  pipelineVersion: '1.0.0',
  preprocessingVersion: 'none-v1',
  textractConfigurationVersion: 'textract-tables-v1',
  textractNormalizerVersion: 'textract-normalizer-v1',
  tableParserVersion: 'scoreboard-parser-v1',
  semanticMapperVersion: 'scoreboard-semantic-v1',
  validationRulesVersion: 'scoreboard-validation-v1',
};

export async function handler(event: ProcessingRunInput): Promise<ExtractTextOutput> {
  const { source } = event;
  const runId = evidenceId();
  const runPrefix = `submissions/${source.submissionId}/screenshots/${source.screenshotId}/runs/${runId}`;
  const startedAt = now();

  await putJson(source.bucket, `${runPrefix}/manifest.json`, {
    schemaVersion: 'processing-run/v1', runId, screenshotId: source.screenshotId,
    inputArtifact: { ...source, kind: 'ORIGINAL' }, versions,
    build: { gitSha: process.env.GITHUB_SHA ?? 'local', environment: process.env.DEPLOYMENT_ENVIRONMENT ?? 'DEV' },
    startedAt,
  });
  await eventRecord(source.bucket, runPrefix, runId, 'RUN_STARTED', { startedAt });

  const object = await s3.send(new GetObjectCommand({ Bucket: source.bucket, Key: source.key }));
  const image = await bodyToBuffer(object.Body);
  const metadata = await sharp(image, { failOn: 'none' }).metadata();
  const invokedAt = now();
  const result = await textract.send(new AnalyzeDocumentCommand({
    Document: { Bytes: image }, FeatureTypes: ['TABLES'],
  }));
  const rawResponse = await putJson(source.bucket, `${runPrefix}/textract/raw-response.json`, result);
  const request = await putJson(source.bucket, `${runPrefix}/textract/request.json`, {
    provider: 'AWS_TEXTRACT', operation: 'AnalyzeDocument', featureTypes: ['TABLES'], invokedAt,
  });

  const rawBlocks = result.Blocks ?? [];
  const blocks = rawBlocks.map(toLiteBlock);
  const rowColors = await computeRowColors(image, metadata.width ?? 0, metadata.height ?? 0, blocks);
  const rows = processScoreboardImage(blocks, rowColors);
  const normalized = normalize(rawBlocks, source, runId);
  const normalizedArtifact = await putJson(source.bucket, `${runPrefix}/normalized/observations.json`, {
    schemaVersion: 'normalized-ocr/v1', runId, screenshotId: source.screenshotId,
    blocks: normalized.blocks, tables: normalized.tables, cells: normalized.cells, tokens: normalized.tokens,
    parser: { version: versions.tableParserVersion, rows, rowColors },
    validation: normalized.cells.map((cell) => ({ cellObservationId: cell.cellObservationId, ...cell.validation })),
  });

  await putJson(source.bucket, `${runPrefix}/completion.json`, {
    schemaVersion: 'processing-run-completion/v1', runId, status: 'SUCCEEDED', completedAt: now(),
    textract: { rawResponse, rawResponseSha256: sha256(Buffer.from(JSON.stringify(result))), request, requestId: result.$metadata.requestId },
    metrics: { detectedTableCount: normalized.tables.length, detectedCellCount: normalized.cells.length, detectedTokenCount: normalized.tokens.length, extractedRowCount: rows.length },
  });
  await eventRecord(source.bucket, runPrefix, runId, 'RUN_SUCCEEDED', { rawResponse, normalizedArtifact });
  log('INFO', 'Screenshot processed', { screenshotId: source.screenshotId, runId, rowCount: rows.length });
  return { runId, source, rows, normalizedArtifact };
}

async function eventRecord(bucket: string, prefix: string, runId: string, type: string, detail: unknown) {
  return putJson(bucket, `${prefix}/events/${now()}-${evidenceId()}.json`, { schemaVersion: 'processing-event/v1', runId, type, occurredAt: now(), detail });
}

function toLiteBlock(block: Block): TextractBlockLite {
  return { Id: block.Id, BlockType: block.BlockType, Text: block.Text, RowIndex: block.RowIndex, ColumnIndex: block.ColumnIndex,
    Geometry: block.Geometry ? { BoundingBox: { Top: block.Geometry.BoundingBox?.Top, Height: block.Geometry.BoundingBox?.Height } } : undefined,
    Relationships: block.Relationships?.map((relationship) => ({ Type: relationship.Type, Ids: relationship.Ids })) };
}

export function normalize(rawBlocks: Block[], source: ProcessingRunInput['source'], runId: string) {
  const childToCell = new Map<string, Block>();
  const cellToTable = new Map<string, string>();
  for (const table of rawBlocks.filter((block) => block.BlockType === 'TABLE')) {
    for (const relationship of table.Relationships ?? []) {
      if (relationship.Type !== 'CHILD') continue;
      for (const id of relationship.Ids ?? []) cellToTable.set(id, table.Id ?? 'unknown');
    }
  }
  for (const block of rawBlocks) for (const relationship of block.Relationships ?? []) if (block.BlockType === 'CELL' && relationship.Type === 'CHILD') for (const id of relationship.Ids ?? []) childToCell.set(id, block);
  const cellText = new Map<string, string>();
  for (const [tokenId, cell] of childToCell) {
    const token = rawBlocks.find((block) => block.Id === tokenId);
    if (token?.Text) cellText.set(cell.Id ?? '', `${cellText.get(cell.Id ?? '') ?? ''} ${token.Text}`.trim());
  }
  const semanticColumns = new Map<number, string>();
  const firstTable = rawBlocks.find((block) => block.BlockType === 'TABLE');
  const headerCells = (firstTable?.Relationships ?? [])
    .filter((relationship) => relationship.Type === 'CHILD')
    .flatMap((relationship) => relationship.Ids ?? [])
    .map((id) => rawBlocks.find((block) => block.Id === id))
    .filter((block): block is Block => block?.BlockType === 'CELL' && block.RowIndex === 1);
  for (const cell of headerCells) {
    const header = (cellText.get(cell.Id ?? '') ?? '').toUpperCase();
    const field = header.includes('PLAYER') ? 'PLAYER' : header === 'SCORE' ? 'SCORE' : header === 'KILLS' ? 'KILLS' : header === 'ASSISTS' ? 'ASSISTS' : header === 'DEATHS' ? 'DEATHS' : undefined;
    if (field && cell.ColumnIndex) semanticColumns.set(cell.ColumnIndex, field);
  }
  const blocks = rawBlocks.map((block) => ({ observationId: `${runId}:block:${block.Id}`, runId, provider: 'AWS_TEXTRACT', providerBlockId: block.Id, blockType: block.BlockType, text: block.Text, confidence: block.Confidence, geometry: geometry(block, source.screenshotId), page: block.Page, rowIndex: block.RowIndex, columnIndex: block.ColumnIndex, rowSpan: block.RowSpan, columnSpan: block.ColumnSpan, entityTypes: block.EntityTypes, selectionStatus: block.SelectionStatus, relationshipIds: (block.Relationships ?? []).map((r) => ({ type: r.Type, providerBlockIds: r.Ids ?? [] })), providerExtensions: { textType: block.TextType } }));
  const tables = rawBlocks.filter((block) => block.BlockType === 'TABLE').map((block, index) => ({ tableObservationId: `${runId}:table:${block.Id}`, runId, providerBlockId: block.Id, tableIndex: index, confidence: block.Confidence, geometry: geometry(block, source.screenshotId), classification: index === 0 ? 'SCOREBOARD' : 'UNKNOWN', childCellObservationIds: (block.Relationships ?? []).flatMap((r) => r.Type === 'CHILD' ? (r.Ids ?? []).map((id) => `${runId}:cell:${id}`) : []), createdAt: now() }));
  const cells = rawBlocks.filter((block) => block.BlockType === 'CELL').map((block) => {
    const observedText = cellText.get(block.Id ?? '') ?? block.Text ?? '';
    const field = semanticColumns.get(block.ColumnIndex ?? 0) ?? 'UNKNOWN';
    const expectsInteger = ['SCORE', 'KILLS', 'ASSISTS', 'DEATHS'].includes(field);
    const numeric = /^\d+$/.test(observedText.trim());
    const validation = { rulesVersion: versions.validationRulesVersion, valid: observedText.length > 0, deterministicReviewRequired: observedText.length === 0 || (block.Confidence ?? 0) < 95, flags: [ ...(observedText.length === 0 ? [{ code: 'EMPTY_REQUIRED_CELL', severity: 'WARNING' }] : []), ...((block.Confidence ?? 0) < 95 ? [{ code: 'LOW_TEXTRACT_CONFIDENCE', severity: 'WARNING', actual: block.Confidence ?? 0 }] : []) ] };
    return { cellObservationId: `${runId}:cell:${block.Id}`, runId, screenshotId: source.screenshotId, tableObservationId: `${runId}:table:${cellToTable.get(block.Id ?? '') ?? 'unknown'}`, providerBlockId: block.Id, tableLocation: { rowIndex: block.RowIndex, columnIndex: block.ColumnIndex, rowSpan: block.RowSpan ?? 1, columnSpan: block.ColumnSpan ?? 1 }, semanticLocation: { field }, observedText, confidence: block.Confidence ?? 0, parsed: { parserVersion: versions.tableParserVersion, expectedType: expectsInteger ? 'INTEGER' : 'STRING', parseSucceeded: observedText.length > 0 && (!expectsInteger || numeric), stringValue: observedText, integerValue: numeric ? Number(observedText) : undefined, transformations: [] }, geometry: geometry(block, source.screenshotId), tokenObservationIds: (block.Relationships ?? []).flatMap((r) => r.Type === 'CHILD' ? (r.Ids ?? []).map((id) => `${runId}:token:${id}`) : []), providerMetadata: { entityTypes: block.EntityTypes, selectionStatus: block.SelectionStatus }, validation, createdAt: now() };
  });
  const tokens = rawBlocks.filter((block) => ['WORD', 'LINE', 'SELECTION_ELEMENT'].includes(block.BlockType ?? '')).map((block) => ({ tokenObservationId: `${runId}:token:${block.Id}`, runId, cellObservationId: childToCell.get(block.Id ?? '')?.Id ? `${runId}:cell:${childToCell.get(block.Id ?? '')?.Id}` : undefined, providerBlockId: block.Id, tokenType: block.BlockType, text: block.Text, confidence: block.Confidence, geometry: geometry(block, source.screenshotId), providerMetadata: { textType: block.TextType }, createdAt: now() }));
  return { blocks, tables, cells, tokens };
}

function geometry(block: Block, imageArtifactId: string) {
  const box = block.Geometry?.BoundingBox;
  return { imageArtifactId, boundingBox: { left: box?.Left ?? 0, top: box?.Top ?? 0, width: box?.Width ?? 0, height: box?.Height ?? 0 }, polygon: (block.Geometry?.Polygon ?? []).map((point) => ({ x: point.X ?? 0, y: point.Y ?? 0 })) };
}

async function computeRowColors(image: Buffer, width: number, height: number, blocks: TextractBlockLite[]): Promise<RowColor[]> {
  if (width < 1 || height < 1) return [];
  const rows = new Map<number, { top: number; bottom: number }>();
  for (const block of blocks) { const box = block.Geometry?.BoundingBox; if (block.BlockType !== 'CELL' || block.RowIndex == null || !box) continue; const current = rows.get(block.RowIndex); const top = box.Top ?? 0; const bottom = top + (box.Height ?? 0); rows.set(block.RowIndex, { top: Math.min(current?.top ?? top, top), bottom: Math.max(current?.bottom ?? bottom, bottom) }); }
  const colors: RowColor[] = [];
  for (const [rowIndex, row] of rows) { const top = Math.max(0, Math.floor(height * ((row.top + row.bottom) / 2))); const stats = await sharp(image).extract({ left: Math.floor(width * 0.1), top: Math.min(top, height - 1), width: Math.max(1, Math.floor(width * 0.3)), height: 1 }).stats(); colors.push({ rowIndex, r: stats.channels[0]?.mean ?? 0, g: stats.channels[1]?.mean ?? 0, b: stats.channels[2]?.mean ?? 0 }); }
  return colors;
}
