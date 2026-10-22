import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  AnalyzeDocumentCommand,
  TextractClient,
  type AnalyzeDocumentCommandOutput,
  type Block,
} from '@aws-sdk/client-textract';
import type { Context } from 'aws-lambda';
import type {
  CsvRow,
  ExtractTextOutput,
  PlayerResolution,
  ProcessingRunInput,
  S3ObjectReference,
} from '@mcc/contracts';
import { ROSTER_MATCHER_VERSION, resolvePlayers } from '@mcc/roster';
import sharp from 'sharp';
import {
  analyzeDocumentInput,
  computeRowColors,
  TEXTRACT_FEATURE_TYPES,
  toLiteBlock,
} from '../lib/textract-analysis';
import { bodyToBuffer, processingRunPrefix } from '../lib/s3';
import { evidenceId, now, putJson, sha256 } from '../lib/evidence';
import { MAX_IMAGE_BYTES } from '../lib/image-limits';
import { log } from '../lib/log';
import {
  publishExtractionMetrics,
  publishStageEvent,
  publishWithoutFailing,
  type StageEvent,
} from '../lib/metrics';
import {
  DynamoRosterSource,
  dynamoRosterTable,
  s3SnapshotStore,
  type LoadedRoster,
} from '../lib/roster-source';
import {
  processScoreboardImage,
  type RowColor,
  type TextractBlockLite,
} from '../lib/scoreboard-logic';

const s3 = new S3Client({});
const textract = new TextractClient({});

const versions = {
  pipelineVersion: '1.1.0',
  preprocessingVersion: 'none-v1',
  textractConfigurationVersion: 'textract-tables-v1',
  textractNormalizerVersion: 'textract-normalizer-v2',
  tableParserVersion: 'scoreboard-parser-v6',
  semanticMapperVersion: 'scoreboard-semantic-v2',
  validationRulesVersion: 'scoreboard-validation-v2',
  rosterMatcherVersion: ROSTER_MATCHER_VERSION,
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
  /** Publishes the extracted row count, which alarms on zero-row runs. */
  publishExtractionMetrics(rowCount: number): void;
  /** Writes the invocation's stage event. */
  publishStageEvent(event: StageEvent): void;
  /**
   * Reads this deployment's roster and makes sure its snapshot exists in the
   * evidence bucket (spec 1.2 §6.2 step 4).
   */
  readRoster(bucket: string): Promise<LoadedRoster>;
  id(): string;
  timestamp(): string;
  /** Milliseconds on a monotonic clock, read only to measure durations. */
  clockMs(): number;
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
      new AnalyzeDocumentCommand(analyzeDocumentInput(image)),
    );
  },
  calculateRowColors: computeRowColors,
  writeJson: putJson,
  publishExtractionMetrics: (rowCount) => publishExtractionMetrics(rowCount),
  publishStageEvent: (event) => publishStageEvent(event),
  readRoster: (bucket) => rosterSource().read(rosterNamespace(), bucket),
  id: evidenceId,
  timestamp: now,
  clockMs: () => performance.now(),
  build: {
    gitSha: process.env.GIT_SHA ?? 'local',
    environment: process.env.DEPLOYMENT_ENVIRONMENT ?? 'LOCAL',
  },
};

let defaultRosterSource: DynamoRosterSource | undefined;

/** One roster source per execution environment, so its cache outlives an invocation. */
function rosterSource(): DynamoRosterSource {
  if (!defaultRosterSource) {
    const tableName = process.env.ROSTER_TABLE;
    if (!tableName) {
      throw namedError('RosterConfigurationError', 'ROSTER_TABLE is not set');
    }
    defaultRosterSource = new DynamoRosterSource(
      dynamoRosterTable(tableName),
      s3SnapshotStore(s3),
      process.env.OBJECT_PREFIX ?? '',
    );
  }
  return defaultRosterSource;
}

function rosterNamespace(): string {
  const namespace = process.env.ROSTER_NAMESPACE;
  if (!namespace) {
    throw namedError('RosterConfigurationError', 'ROSTER_NAMESPACE is not set');
  }
  return namespace;
}

/**
 * What one run measured. A field is absent until the step that measures it
 * has finished, so a failed run carries only what it reached.
 */
interface ExtractionMeasurements {
  runId?: string;
  /** Size of the stored image read. */
  imageBytes?: number;
  widthPx?: number;
  heightPx?: number;
  /** Time spent in the `AnalyzeDocument` call, set only when the call returned. */
  textractMs?: number;
  /** Mean Textract confidence of the normalized cells, absent when there are none. */
  meanConfidence?: number;
  /** Normalized cells whose validation has `deterministicReviewRequired`. */
  reviewRequiredCells?: number;
  /** Rows parsed from the scoreboard. */
  rowCount?: number;
  /** Rows by `playerResolution` status. */
  playerMatchCounts?: { exact: number; resolved: number; unmatched: number };
}

export async function handler(
  event: ProcessingRunInput,
  context?: Pick<Context, 'awsRequestId'>,
): Promise<ExtractTextOutput> {
  return runExtraction(event, defaultDependencies, context?.awsRequestId);
}

/**
 * Runs one extraction and writes one `extract` stage event (spec 1.3 §3.1):
 * `OK` when the run succeeds, or `ERROR` before the error is rethrown. The
 * event carries what the run measured before it returned or failed.
 */
export async function runExtraction(
  event: ProcessingRunInput,
  dependencies: ExtractTextDependencies,
  requestId?: string,
): Promise<ExtractTextOutput> {
  const startedMs = dependencies.clockMs();
  const measurements: ExtractionMeasurements = {};
  let output: ExtractTextOutput;
  try {
    output = await extract(event, dependencies, measurements);
  } catch (error) {
    publishWithoutFailing(
      dependencies,
      stageEvent(event, measurements, {
        outcome: 'ERROR',
        durationMs: dependencies.clockMs() - startedMs,
        errorName: error instanceof Error ? error.name : undefined,
        requestId,
      }),
    );
    throw error;
  }
  publishWithoutFailing(
    dependencies,
    stageEvent(event, measurements, {
      outcome: 'OK',
      durationMs: dependencies.clockMs() - startedMs,
      requestId,
    }),
  );
  return output;
}

/**
 * The `extract` stage event. Match counts are reported only on `OK`, when
 * every row has been resolved and recorded.
 */
function stageEvent(
  event: ProcessingRunInput,
  measurements: ExtractionMeasurements,
  result: Pick<
    StageEvent,
    'outcome' | 'durationMs' | 'errorName' | 'requestId'
  >,
): StageEvent {
  const { source } = event;
  const counts =
    result.outcome === 'OK' ? measurements.playerMatchCounts : undefined;
  const optional = (values: Record<string, number | undefined>) =>
    Object.fromEntries(
      Object.entries(values).filter(([, value]) => value !== undefined),
    ) as Record<string, number>;
  return {
    stage: 'extract',
    ...result,
    ids: {
      submissionId: source?.submissionId,
      screenshotId: source?.screenshotId,
      runId: measurements.runId,
    },
    trace: event.trace,
    properties: {
      ...(source?.acquisitionType
        ? { acquisitionType: source.acquisitionType }
        : {}),
      ...optional({
        imageBytes: measurements.imageBytes,
        widthPx: measurements.widthPx,
        heightPx: measurements.heightPx,
        rowCount: measurements.rowCount,
        reviewRequiredCells: measurements.reviewRequiredCells,
        meanConfidence: measurements.meanConfidence,
        textractMs: measurements.textractMs,
        exactRows: counts?.exact,
        resolvedRows: counts?.resolved,
        unmatchedRows: counts?.unmatched,
      }),
    },
    metrics: optional({
      TextractLatency: measurements.textractMs,
      OcrMeanConfidence: measurements.meanConfidence,
      ReviewRequiredCells: measurements.reviewRequiredCells,
    }),
    ...(counts
      ? {
          breakdowns: {
            playerRows: {
              EXACT: counts.exact,
              RESOLVED: counts.resolved,
              UNMATCHED: counts.unmatched,
            },
          },
        }
      : {}),
  };
}

/**
 * Records one processing run. `measurements` is filled in as the run proceeds
 * and stays readable after the run returns or throws.
 */
async function extract(
  event: ProcessingRunInput,
  dependencies: ExtractTextDependencies,
  measurements: ExtractionMeasurements,
): Promise<ExtractTextOutput> {
  const { source } = event;
  const runId = dependencies.id();
  measurements.runId = runId;
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
    Object.assign(measurements, {
      imageBytes: image.byteLength,
      widthPx: metadata.width,
      heightPx: metadata.height,
    });
    validateTextractImage(image, metadata, source.sha256);
    // The roster is read before Textract, so a roster failure never costs a
    // provider call.
    const { reference: roster, entries } = await dependencies.readRoster(
      source.bucket,
    );
    const invokedAt = dependencies.timestamp();
    request = await dependencies.writeJson(
      source.bucket,
      `${runPrefix}/textract/request.json`,
      {
        provider: 'AWS_TEXTRACT',
        operation: 'AnalyzeDocument',
        featureTypes: [...TEXTRACT_FEATURE_TYPES],
        invokedAt,
        inputSha256: sha256(image),
        inputSizeBytes: image.byteLength,
      },
    );

    const textractStartedMs = dependencies.clockMs();
    const result = await dependencies.analyze(image);
    measurements.textractMs = dependencies.clockMs() - textractStartedMs;
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
    const { rows, noRowsReason } = processScoreboardImage(blocks, rowColors);
    // Resolutions sit beside the names as read in the normalized observations
    // only. The returned rows carry none, so no roster gamertag enters Step
    // Functions state (spec 1.2 §1).
    const resolutions = resolvePlayers(rows, entries);
    const resolvedRows: CsvRow[] = rows.map((row, index) => ({
      ...row,
      playerResolution: resolutions[index],
    }));
    const playerMatchCounts = countMatches(resolutions);
    measurements.rowCount = rows.length;
    measurements.playerMatchCounts = playerMatchCounts;
    const normalized = normalize(rawBlocks, source, runId);
    Object.assign(measurements, cellMeasurements(normalized.cells));
    const normalizedArtifact = await dependencies.writeJson(
      source.bucket,
      `${runPrefix}/normalized/observations.json`,
      {
        schemaVersion: 'normalized-ocr/v2',
        runId,
        screenshotId: source.screenshotId,
        roster,
        blocks: normalized.blocks,
        tables: normalized.tables,
        cells: normalized.cells,
        tokens: normalized.tokens,
        parser: {
          version: versions.tableParserVersion,
          rows: resolvedRows,
          rowColors,
          ...(noRowsReason ? { noRowsReason } : {}),
        },
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
        roster,
        textract: {
          rawResponse,
          rawResponseSha256: sha256(Buffer.from(JSON.stringify(result))),
          request,
          requestId: result.$metadata.requestId,
        },
        metrics: {
          detectedTableCount: normalized.tables.length,
          detectedCellCount: normalized.cells.length,
          detectedTokenCount: normalized.tokens.length,
          extractedRowCount: rows.length,
          playerMatchCounts,
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
      rosterVersion: roster.rosterVersion,
      ...playerMatchCounts,
      ...(noRowsReason ? { noRowsReason } : {}),
    });
    dependencies.publishExtractionMetrics(rows.length);
    return { runId, source, rows, normalizedArtifact, roster };
  } catch (error) {
    const failure = errorSummary(error);
    await Promise.all([
      dependencies.writeJson(source.bucket, `${runPrefix}/completion.json`, {
        schemaVersion: 'processing-run-completion/v1',
        runId,
        status: 'FAILED',
        completedAt: dependencies.timestamp(),
        request,
        error: failure,
      }),
      eventRecord(dependencies, source.bucket, runPrefix, runId, 'RUN_FAILED', {
        request,
        error: failure,
      }),
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

/** How many rows matched exactly, resolved from a near reading, or matched nothing. */
function countMatches(resolutions: readonly PlayerResolution[]): {
  exact: number;
  resolved: number;
  unmatched: number;
} {
  const count = (status: PlayerResolution['status']) =>
    resolutions.filter((resolution) => resolution.status === status).length;
  return {
    exact: count('EXACT'),
    resolved: count('RESOLVED'),
    unmatched: count('UNMATCHED'),
  };
}

/** Mean confidence and review count of a run's normalized cells. */
function cellMeasurements(
  cells: ReadonlyArray<{
    confidence: number;
    validation: { deterministicReviewRequired: boolean };
  }>,
): Pick<ExtractionMeasurements, 'meanConfidence' | 'reviewRequiredCells'> {
  const reviewRequiredCells = cells.filter(
    (cell) => cell.validation.deterministicReviewRequired,
  ).length;
  if (cells.length === 0) return { reviewRequiredCells };
  const total = cells.reduce((sum, cell) => sum + cell.confidence, 0);
  return { meanConfidence: total / cells.length, reviewRequiredCells };
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
        semanticColumnsByTable.get(tableIndex)?.get(block.ColumnIndex ?? 0) ??
        'UNKNOWN';
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
        deterministicReviewRequired: empty || lowConfidence || invalidInteger,
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
