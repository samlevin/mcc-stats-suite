import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  AnalyzeDocumentCommand,
  TextractClient,
  type Block,
} from '@aws-sdk/client-textract';
import type { ExtractTextOutput, PreprocessImageOutput } from '@mcc/contracts';
import sharp from 'sharp';
import { log } from '../lib/log';
import {
  bodyToBuffer,
  namespacedObjectKey,
  safeObjectName,
} from '../lib/s3';
import {
  processScoreboardImage,
  type RowColor,
  type TextractBlockLite,
} from '../lib/scoreboard-logic';

const s3 = new S3Client({});
const textract = new TextractClient({});

export async function handler(
  event: PreprocessImageOutput,
): Promise<ExtractTextOutput> {
  const outputBucket = requiredEnvironment('OUTPUT_BUCKET');
  const object = await s3.send(
    new GetObjectCommand({
      Bucket: event.preprocessed.bucket,
      Key: event.preprocessed.key,
    }),
  );
  const image = await bodyToBuffer(object.Body);
  const metadata = await sharp(image).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  const result = await textract.send(
    new AnalyzeDocumentCommand({
      Document: { Bytes: image },
      FeatureTypes: ['TABLES'],
    }),
  );
  const blocks = (result.Blocks ?? []).map(toLiteBlock);
  const rowColors = await computeRowColors(image, width, height, blocks);
  const rows = processScoreboardImage(blocks, rowColors);
  const artifactKey = namespacedObjectKey(
    `matches/${safeObjectName(event.matchId)}/ocr/${safeObjectName(event.source.attachmentName)}.json`,
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: outputBucket,
      Key: artifactKey,
      Body: JSON.stringify({
        schemaVersion: '1.0',
        matchId: event.matchId,
        attachmentName: event.source.attachmentName,
        blocks,
        rowColors,
        rows,
      }),
      ContentType: 'application/json',
    }),
  );

  log('INFO', 'Text extracted', {
    matchId: event.matchId,
    attachmentName: event.source.attachmentName,
    rowCount: rows.length,
    artifactKey,
  });

  return {
    matchId: event.matchId,
    attachmentName: event.source.attachmentName,
    rows,
  };
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

async function computeRowColors(
  image: Buffer,
  width: number,
  height: number,
  blocks: TextractBlockLite[],
): Promise<RowColor[]> {
  if (width < 1 || height < 1) return [];
  const tops = new Map<number, number>();
  const bottoms = new Map<number, number>();

  for (const block of blocks) {
    if (block.BlockType !== 'CELL' || block.RowIndex == null) continue;
    const box = block.Geometry?.BoundingBox;
    if (!box) continue;
    const top = box.Top ?? 0;
    const bottom = top + (box.Height ?? 0);
    tops.set(block.RowIndex, Math.min(tops.get(block.RowIndex) ?? top, top));
    bottoms.set(
      block.RowIndex,
      Math.max(bottoms.get(block.RowIndex) ?? bottom, bottom),
    );
  }

  const colors: RowColor[] = [];
  for (const [rowIndex, rowTop] of tops) {
    const rowBottom = bottoms.get(rowIndex) ?? rowTop;
    const sampleHeight = Math.min(0.05, Math.max(0.01, rowBottom - rowTop));
    const sampleTop = Math.max(
      0,
      (rowTop + rowBottom) / 2 - sampleHeight / 2,
    );
    const left = clamp(Math.floor(width * 0.1), 0, width - 1);
    const top = clamp(Math.floor(height * sampleTop), 0, height - 1);
    const sampleWidth = clamp(Math.ceil(width * 0.3), 1, width - left);
    const sampleHeightPixels = clamp(
      Math.ceil(height * sampleHeight),
      1,
      height - top,
    );
    const stats = await sharp(image)
      .extract({
        left,
        top,
        width: sampleWidth,
        height: sampleHeightPixels,
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
