import {
  DetectTextCommand,
  RekognitionClient,
  type TextDetection,
} from '@aws-sdk/client-rekognition';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { MatchAttachment, PreprocessImageOutput } from '@mcc/contracts';
import sharp from 'sharp';
import { log } from '../lib/log';
import {
  bodyToBuffer,
  namespacedObjectKey,
  safeObjectName,
} from '../lib/s3';

const rekognition = new RekognitionClient({});
const s3 = new S3Client({});
const PADDING = 0.02;

interface PreprocessImageInput extends MatchAttachment {
  matchId: string;
}

interface NormalizedBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export async function handler(
  event: PreprocessImageInput,
): Promise<PreprocessImageOutput> {
  log('INFO', 'Preprocessing image', {
    matchId: event.matchId,
    key: event.key,
  });

  const object = await s3.send(
    new GetObjectCommand({ Bucket: event.bucket, Key: event.key }),
  );
  const source = await bodyToBuffer(object.Body);
  let oriented = sharp(source).rotate();
  let metadata = await oriented.metadata();

  if (metadata.width && metadata.height && metadata.width < metadata.height) {
    oriented = oriented.rotate(90);
    metadata = await oriented.metadata();
  }

  const preprocessed = await oriented.sharpen().png().toBuffer();
  const processedMetadata = await sharp(preprocessed).metadata();
  const width = processedMetadata.width ?? metadata.width ?? 0;
  const height = processedMetadata.height ?? metadata.height ?? 0;
  if (width < 1 || height < 1) {
    throw new Error('Preprocessed image has invalid dimensions');
  }

  const crop = await detectScoreboardCropBox(preprocessed);
  const pixels = normalizedToPixels(crop, width, height);
  const cropped = await sharp(preprocessed).extract(pixels).png().toBuffer();
  const key = namespacedObjectKey(
    `matches/${safeObjectName(event.matchId)}/preprocessed/${safeObjectName(event.attachmentName)}.png`,
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: event.bucket,
      Key: key,
      Body: cropped,
      ContentType: 'image/png',
    }),
  );

  log('INFO', 'Image preprocessed', {
    matchId: event.matchId,
    sourceKey: event.key,
    preprocessedKey: key,
  });

  return {
    matchId: event.matchId,
    source: {
      bucket: event.bucket,
      key: event.key,
      attachmentName: event.attachmentName,
      contentType: event.contentType,
    },
    preprocessed: { bucket: event.bucket, key },
  };
}

async function detectScoreboardCropBox(
  image: Buffer,
): Promise<NormalizedBox> {
  const result = await rekognition.send(
    new DetectTextCommand({ Image: { Bytes: image } }),
  );
  const words = (result.TextDetections ?? []).filter(
    (item: TextDetection) =>
      item.Type === 'WORD' &&
      item.DetectedText &&
      item.Geometry?.BoundingBox,
  );
  const find = (text: string) =>
    words.find(
      (word) => word.DetectedText?.trim().toUpperCase() === text,
    );

  const players = find('PLAYERS');
  const score = find('SCORE');
  const deaths = find('DEATHS');
  if (!players || !score || !deaths) {
    log('WARN', 'Scoreboard anchors not found; retaining full image');
    return { left: 0, top: 0, width: 1, height: 1 };
  }

  const anchors = [
    players,
    score,
    find('KILLS'),
    find('ASSISTS'),
    deaths,
  ].filter((item): item is TextDetection => Boolean(item));
  const boxes = anchors.map((item) => item.Geometry!.BoundingBox!);
  let left = Math.min(...boxes.map((box) => box.Left ?? 0));
  let right = Math.max(
    ...boxes.map((box) => (box.Left ?? 0) + (box.Width ?? 0)),
  );
  let top = players.Geometry!.BoundingBox!.Top ?? 0;
  let bottom = top;

  for (const word of words) {
    const box = word.Geometry!.BoundingBox!;
    const middle = (box.Left ?? 0) + (box.Width ?? 0) / 2;
    if (middle < left - 0.05 || middle > right + 0.05) continue;
    if ((box.Top ?? 0) <= top) continue;
    bottom = Math.max(bottom, (box.Top ?? 0) + (box.Height ?? 0));
  }

  left = Math.max(0, left - PADDING);
  right = Math.min(1, right + PADDING);
  top = Math.max(0, top - PADDING);
  bottom = Math.min(1, bottom + PADDING);
  return {
    left,
    top,
    width: Math.max(0.01, right - left),
    height: Math.max(0.01, bottom - top),
  };
}

function normalizedToPixels(
  box: NormalizedBox,
  imageWidth: number,
  imageHeight: number,
) {
  const left = Math.max(0, Math.floor(box.left * imageWidth));
  const top = Math.max(0, Math.floor(box.top * imageHeight));
  return {
    left,
    top,
    width: Math.max(
      1,
      Math.min(imageWidth - left, Math.ceil(box.width * imageWidth)),
    ),
    height: Math.max(
      1,
      Math.min(imageHeight - top, Math.ceil(box.height * imageHeight)),
    ),
  };
}
