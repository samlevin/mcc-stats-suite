import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  AnalyzeDocumentCommand,
  TextractClient,
  type AnalyzeDocumentCommandOutput,
  type Block,
} from '@aws-sdk/client-textract';
import type {
  ExtractTextOutput,
  ProcessingRunInput,
  S3ObjectReference,
} from '@mcc/contracts';
import sharp from 'sharp';
import { bodyToBuffer, processingRunPrefix } from '../lib/s3';
import { evidenceId, now, putJson, sha256 } from '../lib/evidence';
import { log } from '../lib/log';
import {
  processScoreboardImage,
  type RowColor,
  type TextractBlockLite,
} from '../lib/scoreboard-logic';

const s3 = new S3Client({});
const textract = new TextractClient({});
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const versions = {
  pipelineVersion: '1.0.0',
  preprocessingVersion: 'none-v1',
  textractConfigurationVersion: 'textract-tables-v1',
  textractNormalizerVersion: 'textract-normalizer-v2',
  tableParserVersion: 'scoreboard-parser-v2',
  semanticMapperVersion: 'scoreboard-semantic-v2',
  validationRulesVersion: 'scoreboard-validation-v2',
};

interface ImageMetadata {
  format?: string;
  width?: number;
  height?: number;
}

export interface ExtractTextDependencies {
  getImage(bucket: string, key: string): Promise<Buffer>;
  inspectImage(image: Buffer): Promise<ImageMetadata>;
  analyze(image: Buffer): Promise<AnalyzeDocumentCommandOutput>;
  calculateRowColors(
    image: Buffer,
    width: number,
    height: number,
    blocks: TextractBlockLite[],
  ): Promise<RowColor[]>;
  writeJson(
    bucket: string,
    key: string,
    value: unknown,
  ): Promise<S3ObjectReference>;
  id(): string;
  timestamp(): string;
  build: { gitSha: string; environment: string };
}

const defaultDependencies: ExtractTextDependencies = {
  async getImage(bucket, key) {
    const object = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    return bodyToBuffer(object.Body);
  },
  async inspectImage(image) {
    return sharp(image, { failOn: 'none' }).metadata();
  },
  async analyze(image) {
    return textract.send(
      new AnalyzeDocumentCommand({
        Document: { Bytes: image },
        FeatureTypes: ['TABLES'],
      }),
    );
  },
  calculateRowColors: computeRowColors,
  writeJson: putJson,
  id: evidenceId,
  timestamp: now,
  build: {
    gitSha: process.env.GIT_SHA ?? 'local',
    environment: process.env.DEPLOYMENT_ENVIRONMENT ?? 'LOCAL',
  },
};

export async function handler(
  event: ProcessingRunInput,
): Promise<ExtractTextOutput> {
  return runExtraction(event, defaultDependencies);
}

export async function runExtraction(
  event: ProcessingRunInput,
  dependencies: ExtractTextDependencies,
): Promise<ExtractTextOutput> {
  const { source } = event;
  const runId = dependencies.id();
  const runPrefix = processingRunPrefix(source, runId);
  const startedAt = dependencies.timestamp();
  let request: S3ObjectReference | undefined;

  await dependencies.writeJson(source.bucket, `${runPrefix}/manifest.json`, {
    schemaVersion: 'processing-run/v1',
    runId,
    screenshotId: source.screenshotId,
    inputArtifact: { ...source, kind: 'ORIGINAL' },
    versions,
    build: dependencies.build,
    startedAt,
  });
  await eventRecord(
    dependencies,
    source.bucket,
    runPrefix,
    runId,
    'RUN_STARTED',
    { startedAt },
  );

  try {
    const image = await dependencies.getImage(source.bucket, source.key);
    const metadata = await dependencies.inspectImage(image);
    validateTextractImage(image, metadata, source.sha256);
    const invokedAt = dependencies.timestamp();
    request = await dependencies.writeJson(
      source.bucket,
      `${runPrefix}/textract/request.json`,
      {
        provider: 'AWS_TEXTRACT',
        operation: 'AnalyzeDocument',
        featureTypes: ['TABLES'],
        invokedAt,
        inputSha256: sha256(image),
        inputSizeBytes: image.byteLength,
      },
    );

    const result = await dependencies.analyze(image);
    const rawResponse = await dependencies.writeJson(
      source.bucket,
      `${runPrefix}/textract/raw-response.json`,
      result,
    );
    const rawBlocks = result.Blocks ?? [];
    const blocks = rawBlocks.map(toLiteBlock);
    const rowColors = await dependencies.calculateRowColors(
      image,
      metadata.width ?? 0,
      metadata.height ?? 0,
      blocks,
    );
    const rows = processScoreboardImage(blocks, rowColors);
    const normalized = normalize(rawBlocks, source, runId);
    const normalizedArtifact = await dependencies.writeJson(
      source.bucket,
      `${runPrefix}/normalized/observations.json`,
      {
        schemaVersion: 'normalized-ocr/v2',
        runId,
        screenshotId: source.screenshotId,
        blocks: normalized.blocks,
        tables: normalized.tables,
        cells: normalized.cells,
        tokens: normalized.tokens,
        parser: { version: versions.tableParserVersion, rows, rowColors },
        validation: normalized.cells.map((cell) => ({
          cellObservationId: cell.cellObservationId,
          ...cell.validation,
        })),
      },
    );

    await dependencies.writeJson(
      source.bucket,
      `${runPrefix}/completion.json`,
      {
        schemaVersion: 'processing-run-completion/v1',
        runId,
        status: 'SUCCEEDED',
        completedAt: dependencies.timestamp(),
        textract: {
          rawResponse,
          rawResponseSha256: sha256(
            Buffer.from(JSON.stringify(result)),
          ),
          request,
          requestId: result.$metadata.requestId,
        },
        metrics: {
          detectedTableCount: normalized.tables.length,
          detectedCellCount: normalized.cells.length,
          detectedTokenCount: normalized.tokens.length,
          extractedRowCount: rows.length,
        },
      },
    );
    await eventRecord(
      dependencies,
      source.bucket,
      runPrefix,
      runId,
      'RUN_SUCCEEDED',
      { rawResponse, normalizedArtifact },
    );
    log('INFO', 'Screenshot processed', {
      screenshotId: source.screenshotId,
      runId,
      rowCount: rows.length,
    });
    return { runId, source, rows, normalizedArtifact };
  } catch (error) {
    const failure = errorSummary(error);
    await Promise.all([
      dependencies.writeJson(
        source.bucket,
        `${runPrefix}/completion.json`,
        {
          schemaVersion: 'processing-run-completion/v1',
          runId,
          status: 'FAILED',
          completedAt: dependencies.timestamp(),
          request,
          error: failure,
        },
      ),
      eventRecord(
        dependencies,
        source.bucket,
        runPrefix,
        runId,
        'RUN_FAILED',
        { request, error: failure },
      ),
    ]).catch((recordError) => {
      log('ERROR', 'Unable to record processing failure', {
        screenshotId: source.screenshotId,
        runId,
        error: errorSummary(recordError),
      });
    });
    throw error;
  }
}

function validateTextractImage(
  image: Buffer,
  metadata: ImageMetadata,
  expectedSha256: string,
): void {
  if (sha256(image) !== expectedSha256) {
    throw namedError(
      'SourceHashMismatchError',
      'Stored source image does not match its immutable source hash',
    );
  }
  if (image.byteLength > MAX_IMAGE_BYTES) {
    throw namedError('ImageTooLargeError', 'Image exceeds the Textract limit');
  }
  if (!metadata.format || !['png', 'jpeg', 'jpg'].includes(metadata.format)) {
    throw namedError(
      'UnsupportedImageFormatError',
      'Textract byte input requires PNG or JPEG',
    );
  }
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function eventRecord(
  dependencies: ExtractTextDependencies,
  bucket: string,
  prefix: string,
  runId: string,
  type: string,
  detail: unknown,
): Promise<S3ObjectReference> {
  const occurredAt = dependencies.timestamp();
  return dependencies.writeJson(
    bucket,
    `${prefix}/events/${occurredAt}-${dependencies.id()}.json`,
    {
      schemaVersion: 'processing-event/v1',
      runId,
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

function toLiteBlock(block: Block): TextractBlockLite {
  return {
    Id: block.Id,
    BlockType: block.BlockType,
    Text: block.Text,
    RowIndex: block.RowIndex,
    ColumnIndex: block.ColumnIndex,
    Geometry: block.Geometry
      ? {
          BoundingBox: {
            Top: block.Geometry.BoundingBox?.Top,
            Height: block.Geometry.BoundingBox?.Height,
          },
        }
      : undefined,
    Relationships: block.Relationships?.map((relationship) => ({
      Type: relationship.Type,
      Ids: relationship.Ids,
    })),
  };
}

export function normalize(
  rawBlocks: Block[],
  source: ProcessingRunInput['source'],
  runId: string,
) {
  const blocksById = new Map(
    rawBlocks.flatMap((block) => (block.Id ? [[block.Id, block]] : [])),
  );
  const childToCell = new Map<string, Block>();
  const cellToTable = new Map<string, string>();
  const tableIndexes = new Map<string, number>();
  const tableBlocks = rawBlocks.filter((block) => block.BlockType === 'TABLE');
  tableBlocks.forEach((table, index) => {
    if (table.Id) tableIndexes.set(table.Id, index);
    for (const relationship of table.Relationships ?? []) {
      if (relationship.Type !== 'CHILD') continue;
      for (const id of relationship.Ids ?? []) {
        cellToTable.set(id, table.Id ?? 'unknown');
      }
    }
  });
  for (const block of rawBlocks) {
    if (block.BlockType !== 'CELL') continue;
    for (const relationship of block.Relationships ?? []) {
      if (relationship.Type !== 'CHILD') continue;
      for (const id of relationship.Ids ?? []) childToCell.set(id, block);
    }
  }

  const cellText = new Map<string, string>();
  for (const [tokenId, cell] of childToCell) {
    const token = blocksById.get(tokenId);
    if (token?.Text) {
      cellText.set(
        cell.Id ?? '',
        `${cellText.get(cell.Id ?? '') ?? ''} ${token.Text}`.trim(),
      );
    }
  }

  const semanticColumnsByTable = new Map<number, Map<number, string>>();
  for (const table of tableBlocks) {
    const tableIndex = tableIndexes.get(table.Id ?? '') ?? 0;
    const semanticColumns = new Map<number, string>();
    const headerCells = (table.Relationships ?? [])
      .filter((relationship) => relationship.Type === 'CHILD')
      .flatMap((relationship) => relationship.Ids ?? [])
      .map((id) => blocksById.get(id))
      .filter(
        (block): block is Block =>
          block?.BlockType === 'CELL' && block.RowIndex === 1,
      );
    for (const cell of headerCells) {
      const field = semanticField(cellText.get(cell.Id ?? '') ?? '');
      if (field && cell.ColumnIndex) {
        semanticColumns.set(cell.ColumnIndex, field);
      }
    }
    semanticColumnsByTable.set(tableIndex, semanticColumns);
  }

  const blocks = rawBlocks.map((block) => ({
    observationId: `${runId}:block:${block.Id}`,
    runId,
    provider: 'AWS_TEXTRACT',
    providerBlockId: block.Id,
    blockType: block.BlockType,
    text: block.Text,
    confidence: block.Confidence,
    geometry: geometry(block, source.screenshotId),
    page: block.Page,
    rowIndex: block.RowIndex,
    columnIndex: block.ColumnIndex,
    rowSpan: block.RowSpan,
    columnSpan: block.ColumnSpan,
    entityTypes: block.EntityTypes,
    selectionStatus: block.SelectionStatus,
    relationshipIds: (block.Relationships ?? []).map((relationship) => ({
      type: relationship.Type,
      providerBlockIds: relationship.Ids ?? [],
    })),
    providerExtensions: { textType: block.TextType },
  }));

  const tables = tableBlocks.map((block, index) => {
    const semanticColumns = semanticColumnsByTable.get(index) ?? new Map();
    return {
      tableObservationId: `${runId}:table:${block.Id}`,
      runId,
      providerBlockId: block.Id,
      tableIndex: index,
      confidence: block.Confidence,
      geometry: geometry(block, source.screenshotId),
      classification:
        [...semanticColumns.values()].includes('PLAYER') &&
        semanticColumns.size >= 2
          ? 'SCOREBOARD'
          : 'UNKNOWN',
      childCellObservationIds: (block.Relationships ?? []).flatMap(
        (relationship) =>
          relationship.Type === 'CHILD'
            ? (relationship.Ids ?? []).map((id) => `${runId}:cell:${id}`)
            : [],
      ),
      createdAt: now(),
    };
  });

  const cells = rawBlocks
    .filter((block) => block.BlockType === 'CELL')
    .map((block) => {
      const observedText = cellText.get(block.Id ?? '') ?? block.Text ?? '';
      const tableId = cellToTable.get(block.Id ?? '') ?? 'unknown';
      const tableIndex = tableIndexes.get(tableId) ?? -1;
      const field =
        semanticColumnsByTable
          .get(tableIndex)
          ?.get(block.ColumnIndex ?? 0) ?? 'UNKNOWN';
      const rowRole = block.RowIndex === 1 ? 'HEADER' : 'DATA';
      const expectsInteger =
        rowRole === 'DATA' &&
        ['SCORE', 'KILLS', 'ASSISTS', 'DEATHS'].includes(field);
      const numeric = /^\d+$/.test(observedText.trim());
      const empty = observedText.trim().length === 0;
      const lowConfidence = (block.Confidence ?? 0) < 95;
      const invalidInteger = expectsInteger && !empty && !numeric;
      const validation = {
        rulesVersion: versions.validationRulesVersion,
        valid: !empty && !invalidInteger,
        deterministicReviewRequired:
          empty || lowConfidence || invalidInteger,
        flags: [
          ...(empty
            ? [{ code: 'EMPTY_REQUIRED_CELL', severity: 'WARNING' }]
            : []),
          ...(lowConfidence
            ? [
                {
                  code: 'LOW_TEXTRACT_CONFIDENCE',
                  severity: 'WARNING',
                  actual: block.Confidence ?? 0,
                },
              ]
            : []),
          ...(invalidInteger
            ? [{ code: 'INVALID_INTEGER', severity: 'WARNING' }]
            : []),
        ],
      };
      return {
        cellObservationId: `${runId}:cell:${block.Id}`,
        runId,
        screenshotId: source.screenshotId,
        tableObservationId: `${runId}:table:${tableId}`,
        providerBlockId: block.Id,
        tableLocation: {
          tableIndex,
          rowIndex: block.RowIndex,
          columnIndex: block.ColumnIndex,
          rowSpan: block.RowSpan ?? 1,
          columnSpan: block.ColumnSpan ?? 1,
        },
        semanticLocation: { field, rowRole },
        observedText,
        confidence: block.Confidence ?? 0,
        parsed: {
          parserVersion: versions.tableParserVersion,
          expectedType: expectsInteger ? 'INTEGER' : 'STRING',
          parseSucceeded: !empty && (!expectsInteger || numeric),
          stringValue: observedText,
          integerValue: numeric ? Number(observedText) : undefined,
          transformations: [],
        },
        geometry: geometry(block, source.screenshotId),
        tokenObservationIds: (block.Relationships ?? []).flatMap(
          (relationship) =>
            relationship.Type === 'CHILD'
              ? (relationship.Ids ?? []).map((id) => `${runId}:token:${id}`)
              : [],
        ),
        providerMetadata: {
          entityTypes: block.EntityTypes,
          selectionStatus: block.SelectionStatus,
        },
        validation,
        createdAt: now(),
      };
    });

  const tokens = rawBlocks
    .filter((block) =>
      ['WORD', 'LINE', 'SELECTION_ELEMENT'].includes(block.BlockType ?? ''),
    )
    .map((block) => ({
      tokenObservationId: `${runId}:token:${block.Id}`,
      runId,
      cellObservationId: childToCell.get(block.Id ?? '')?.Id
        ? `${runId}:cell:${childToCell.get(block.Id ?? '')?.Id}`
        : undefined,
      providerBlockId: block.Id,
      tokenType: block.BlockType,
      text: block.Text,
      confidence: block.Confidence,
      geometry: geometry(block, source.screenshotId),
      providerMetadata: { textType: block.TextType },
      createdAt: now(),
    }));
  return { blocks, tables, cells, tokens };
}

function semanticField(headerText: string): string | undefined {
  const header = headerText.trim().toUpperCase();
  if (header.includes('PLAYER')) return 'PLAYER';
  if (header === 'SCORE') return 'SCORE';
  if (header === 'KILLS') return 'KILLS';
  if (header === 'ASSISTS') return 'ASSISTS';
  if (header === 'DEATHS') return 'DEATHS';
  return undefined;
}

function geometry(block: Block, imageArtifactId: string) {
  const box = block.Geometry?.BoundingBox;
  return {
    imageArtifactId,
    boundingBox: {
      left: box?.Left ?? 0,
      top: box?.Top ?? 0,
      width: box?.Width ?? 0,
      height: box?.Height ?? 0,
    },
    polygon: (block.Geometry?.Polygon ?? []).map((point) => ({
      x: point.X ?? 0,
      y: point.Y ?? 0,
    })),
  };
}

async function computeRowColors(
  image: Buffer,
  width: number,
  height: number,
  blocks: TextractBlockLite[],
): Promise<RowColor[]> {
  if (width < 1 || height < 1) return [];
  const rows = new Map<number, { top: number; bottom: number }>();
  for (const block of blocks) {
    const box = block.Geometry?.BoundingBox;
    if (block.BlockType !== 'CELL' || block.RowIndex == null || !box) continue;
    const current = rows.get(block.RowIndex);
    const top = box.Top ?? 0;
    const bottom = top + (box.Height ?? 0);
    rows.set(block.RowIndex, {
      top: Math.min(current?.top ?? top, top),
      bottom: Math.max(current?.bottom ?? bottom, bottom),
    });
  }
  const colors: RowColor[] = [];
  for (const [rowIndex, row] of rows) {
    const top = Math.max(
      0,
      Math.floor(height * ((row.top + row.bottom) / 2)),
    );
    const stats = await sharp(image)
      .extract({
        left: Math.floor(width * 0.1),
        top: Math.min(top, height - 1),
        width: Math.max(1, Math.floor(width * 0.3)),
        height: 1,
      })
      .stats();
    colors.push({
      rowIndex,
      r: stats.channels[0]?.mean ?? 0,
      g: stats.channels[1]?.mean ?? 0,
      b: stats.channels[2]?.mean ?? 0,
    });
  }
  return colors;
}
