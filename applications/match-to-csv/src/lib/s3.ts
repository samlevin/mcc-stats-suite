import type { GetObjectOutput } from '@aws-sdk/client-s3';
import type { SourceScreenshot } from '@mcc/contracts';

export async function bodyToBuffer(
  body: GetObjectOutput['Body'],
): Promise<Buffer> {
  if (!body) {
    throw new Error('S3 object has no body');
  }

  const sdkBody = body as {
    transformToByteArray?: () => Promise<Uint8Array>;
  };
  if (typeof sdkBody.transformToByteArray === 'function') {
    return Buffer.from(await sdkBody.transformToByteArray());
  }

  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function safeObjectName(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160) || 'attachment';
}

export function namespacedObjectKey(key: string): string {
  const prefix = process.env.OBJECT_PREFIX?.replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${key.replace(/^\/+/, '')}` : key;
}

export function sourceScreenshotPrefix(source: SourceScreenshot): string {
  const suffix = '/source/original';
  if (!source.key.endsWith(suffix)) {
    throw new Error(`Unexpected source screenshot key: ${source.key}`);
  }
  return source.key.slice(0, -suffix.length);
}

export function processingRunPrefix(
  source: SourceScreenshot,
  runId: string,
): string {
  return `${sourceScreenshotPrefix(source)}/runs/${runId}`;
}
