// Textract request and row-color sampling shared by the ExtractText Lambda and
// the local capture script (scripts/capture-textract.ts), so a local capture
// sends the same request and computes the same row colors as a processing run.

import type {
  AnalyzeDocumentCommandInput,
  Block,
} from '@aws-sdk/client-textract';
import sharp from 'sharp';
import type { RowColor, TextractBlockLite } from './scoreboard-logic';

/** Textract feature types every processing run requests. */
export const TEXTRACT_FEATURE_TYPES = ['TABLES'] as const;

/** The AnalyzeDocument request for one screenshot, sent as raw bytes. */
export function analyzeDocumentInput(
  image: Uint8Array,
): AnalyzeDocumentCommandInput {
  return {
    Document: { Bytes: image },
    FeatureTypes: [...TEXTRACT_FEATURE_TYPES],
  };
}

/** Keeps the fields of a Textract block that the scoreboard parser reads. */
export function toLiteBlock(block: Block): TextractBlockLite {
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

/**
 * Average color of each table row, sampled from a one-pixel band across the
 * row's vertical middle, from 10% to 40% of the image width.
 */
export async function computeRowColors(
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
    const top = Math.max(0, Math.floor(height * ((row.top + row.bottom) / 2)));
    // Sharp's stats() reads the whole input image and ignores extract(), so
    // the band is decoded to raw pixels and averaged here.
    const { data, info } = await sharp(image)
      .extract({
        left: Math.floor(width * 0.1),
        top: Math.min(top, height - 1),
        width: Math.max(1, Math.floor(width * 0.3)),
        height: 1,
      })
      .removeAlpha()
      .toColorspace('srgb')
      .raw({ depth: 'uchar' })
      .toBuffer({ resolveWithObject: true });
    colors.push({ rowIndex, ...meanColor(data, info.channels) });
  }
  return colors;
}

function meanColor(
  pixels: Buffer,
  channels: number,
): { r: number; g: number; b: number } {
  const pixelCount = Math.floor(pixels.length / channels);
  if (pixelCount === 0) return { r: 0, g: 0, b: 0 };
  const sums = [0, 0, 0];
  for (let offset = 0; offset < pixelCount * channels; offset += channels) {
    for (let channel = 0; channel < 3; channel++) {
      sums[channel] += pixels[offset + Math.min(channel, channels - 1)];
    }
  }
  return {
    r: sums[0] / pixelCount,
    g: sums[1] / pixelCount,
    b: sums[2] / pixelCount,
  };
}
