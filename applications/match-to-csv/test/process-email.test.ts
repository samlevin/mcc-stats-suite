import t from 'tap';
import type { S3ObjectReference } from '@mcc/contracts';
import {
  attachmentRejectionCodes,
  processEmail,
  type ProcessEmailDependencies,
} from '../src/lambdas/process-email';

t.test('processEmail preserves images and returns every processable attachment', async (t) => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  process.env.OBJECT_PREFIX = 'ephemeral/tester';
  t.teardown(() => {
    delete process.env.EVIDENCE_BUCKET;
    delete process.env.OBJECT_PREFIX;
  });

  const jsonWrites: Array<{ key: string; value: any }> = [];
  const objectWrites: S3ObjectReference[] = [];
  let id = 0;
  const dependencies: ProcessEmailDependencies = {
    async getRawEmail() {
      return Buffer.from('mime');
    },
    async parseEmail() {
      return {
        messageId: 'message',
        subject: 'subject',
        attachments: [
          { filename: 'scoreboard.png', contentType: 'image/png', content: Buffer.from('png') },
          { filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('text') },
          { filename: 'photo.webp', contentType: 'image/webp', content: Buffer.from('webp') },
          { filename: 'logo.jpg', contentType: 'image/jpeg', content: Buffer.from('small') },
        ],
      };
    },
    async inspectImage(content) {
      if (content.toString() === 'webp') return { format: 'webp', width: 1920, height: 1080 };
      if (content.toString() === 'small') return { format: 'jpeg', width: 200, height: 100 };
      return { format: 'png', width: 1920, height: 1080 };
    },
    async putObject(reference) {
      objectWrites.push(reference);
    },
    async writeJson(bucket, key, value) {
      jsonWrites.push({ key, value });
      return { bucket, key };
    },
    id: () => `id-${++id}`,
    timestamp: () => '2026-01-01T00:00:00.000Z',
  };

  const result = await processEmail(
    { bucket: 'raw', key: 'incoming/message' },
    dependencies,
  );

  t.equal(result.screenshots.length, 1);
  t.equal(result.rejectedAttachments.length, 3);
  t.same(
    result.rejectedAttachments.map((item) => item.rejectionCodes),
    [['NOT_AN_IMAGE'], ['UNSUPPORTED_IMAGE_FORMAT'], ['IMAGE_TOO_SMALL']],
  );
  t.equal(objectWrites.length, 3, 'every image original is preserved');
  t.ok(
    objectWrites.every((reference) => reference.key.startsWith('ephemeral/tester/submissions/')),
    'all image artifacts use the ephemeral namespace',
  );
  t.ok(jsonWrites.some((write) => write.key.endsWith('/ingestion.json')));
  t.ok(jsonWrites.some((write) => write.key.endsWith('/completion.json')));
  t.ok(
    jsonWrites.some((write) => write.value.type === 'SUBMISSION_ACCEPTED'),
  );
});

t.test('processEmail records and rejects an email without a screenshot', async (t) => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  t.teardown(() => delete process.env.EVIDENCE_BUCKET);
  const jsonWrites: Array<{ key: string; value: any }> = [];
  const dependencies: ProcessEmailDependencies = {
    async getRawEmail() {
      return Buffer.from('mime');
    },
    async parseEmail() {
      return {
        attachments: [
          { contentType: 'text/plain', content: Buffer.from('notes') },
        ],
      };
    },
    async inspectImage() {
      throw new Error('not called');
    },
    async putObject() {
      throw new Error('not called');
    },
    async writeJson(bucket, key, value) {
      jsonWrites.push({ key, value });
      return { bucket, key };
    },
    id: () => 'id',
    timestamp: () => '2026-01-01T00:00:00.000Z',
  };

  await t.rejects(
    processEmail({ bucket: 'raw', key: 'incoming/message' }, dependencies),
    { name: 'NoProcessableScreenshotsError' },
  );
  t.ok(
    jsonWrites.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.status === 'REJECTED',
    ),
  );
  t.ok(
    jsonWrites.some((write) => write.value.type === 'SUBMISSION_REJECTED'),
  );
});

t.test('attachment validation reports independent problems', (t) => {
  t.same(
    attachmentRejectionCodes(
      Buffer.alloc(10 * 1024 * 1024 + 1),
      { format: 'webp', width: 100, height: 100 },
    ),
    ['UNSUPPORTED_IMAGE_FORMAT', 'IMAGE_TOO_LARGE', 'IMAGE_TOO_SMALL'],
  );
  t.same(
    attachmentRejectionCodes(Buffer.from('bad'), {}, new Error('invalid')),
    ['UNREADABLE_IMAGE'],
  );
  t.end();
});

t.test('processEmail records a failed completion when evidence storage fails', async (t) => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  t.teardown(() => delete process.env.EVIDENCE_BUCKET);
  const jsonWrites: Array<{ key: string; value: any }> = [];
  const dependencies: ProcessEmailDependencies = {
    async getRawEmail() {
      return Buffer.from('mime');
    },
    async parseEmail() {
      return {
        attachments: [
          { contentType: 'image/png', content: Buffer.from('image') },
        ],
      };
    },
    async inspectImage() {
      return { format: 'png', width: 1920, height: 1080 };
    },
    async putObject() {
      throw new Error('storage failed');
    },
    async writeJson(bucket, key, value) {
      jsonWrites.push({ key, value });
      return { bucket, key };
    },
    id: () => 'id',
    timestamp: () => '2026-01-01T00:00:00.000Z',
  };

  await t.rejects(
    processEmail({ bucket: 'raw', key: 'incoming/message' }, dependencies),
    { message: 'storage failed' },
  );
  t.ok(
    jsonWrites.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.status === 'FAILED',
    ),
  );
  t.ok(jsonWrites.some((write) => write.value.type === 'SUBMISSION_FAILED'));
});
