import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  analyzeDocumentInput,
  computeRowColors,
  toLiteBlock,
} from '../src/lib/textract-analysis';

const width = 100;
const height = 40;

/** A PNG whose top half is red and bottom half is blue. */
async function redOverBlue(): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      if (y < height / 2) pixels[offset] = 200;
      else pixels[offset + 2] = 150;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

function rowCell(rowIndex: number, top: number) {
  return {
    Id: `cell-${rowIndex}`,
    BlockType: 'CELL',
    RowIndex: rowIndex,
    ColumnIndex: 1,
    Geometry: { BoundingBox: { Top: top, Height: 0.2 } },
  };
}

test('computeRowColors samples each row, not the whole image', async () => {
  const colors = await computeRowColors(await redOverBlue(), width, height, [
    rowCell(1, 0.1),
    rowCell(2, 0.6),
    { Id: 'word', BlockType: 'WORD', Text: 'ignored' },
  ]);
  assert.deepEqual(colors, [
    { rowIndex: 1, r: 200, g: 0, b: 0 },
    { rowIndex: 2, r: 0, g: 0, b: 150 },
  ]);
});

test('computeRowColors spans every cell in a row', async () => {
  // One cell sits in the red half and one in the blue half; the band is
  // sampled at the middle of their combined extent, in the blue half.
  const colors = await computeRowColors(await redOverBlue(), width, height, [
    rowCell(1, 0.3),
    { ...rowCell(1, 0.7), Id: 'cell-1b' },
  ]);
  assert.deepEqual(colors, [{ rowIndex: 1, r: 0, g: 0, b: 150 }]);
});

test('computeRowColors returns nothing for an image without dimensions', async () => {
  assert.deepEqual(await computeRowColors(Buffer.alloc(0), 0, 0, []), []);
});

test('analyzeDocumentInput requests table analysis of raw bytes', () => {
  const image = Buffer.from('png');
  assert.deepEqual(analyzeDocumentInput(image), {
    Document: { Bytes: image },
    FeatureTypes: ['TABLES'],
  });
});

test('toLiteBlock keeps the fields the parser reads', () => {
  assert.deepEqual(
    toLiteBlock({
      Id: 'cell',
      BlockType: 'CELL',
      Confidence: 99,
      RowIndex: 2,
      ColumnIndex: 1,
      Geometry: {
        BoundingBox: { Top: 0.1, Height: 0.2, Left: 0.3, Width: 0.4 },
        Polygon: [{ X: 0, Y: 0 }],
      },
      Relationships: [{ Type: 'CHILD', Ids: ['word'] }],
    }),
    {
      Id: 'cell',
      BlockType: 'CELL',
      Text: undefined,
      RowIndex: 2,
      ColumnIndex: 1,
      Geometry: { BoundingBox: { Top: 0.1, Height: 0.2 } },
      Relationships: [{ Type: 'CHILD', Ids: ['word'] }],
    },
  );
  assert.equal(toLiteBlock({ Id: 'page' }).Geometry, undefined);
});
