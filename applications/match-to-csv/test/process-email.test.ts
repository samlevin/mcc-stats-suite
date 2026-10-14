import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { S3ObjectReference } from '@samlevin/contracts';
import {
  attachmentRejectionCodes,
  parseSenderAllowlist,
  parseSesVerdicts,
  processEmail,
  type ProcessEmailDependencies,
} from '../src/lambdas/process-email';

afterEach(() => {
  delete process.env.EVIDENCE_BUCKET;
  delete process.env.SENDER_ALLOWLIST_PARAMETER;
  delete process.env.OBJECT_PREFIX;
});

interface ScreeningCase {
  headerLines?: Array<{ key: string; line: string }>;
  fromAddresses?: string[];
  /** Undefined leaves SENDER_ALLOWLIST_PARAMETER unset. */
  allowlistParameter?: string;
  allowlist?: string[];
}

/** Runs processEmail on one valid screenshot and records every side effect. */
async function runScreening(options: ScreeningCase) {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  if (options.allowlistParameter) {
    process.env.SENDER_ALLOWLIST_PARAMETER = options.allowlistParameter;
  }
  const jsonWrites: Array<{ key: string; value: any }> = [];
  const objectWrites: S3ObjectReference[] = [];
  const allowlistReads: string[] = [];
  let inspections = 0;
  let id = 0;
  const dependencies: ProcessEmailDependencies = {
    async getRawEmail() {
      return Buffer.from('mime');
    },
    async parseEmail() {
      return {
        headerLines: options.headerLines,
        fromAddresses: options.fromAddresses,
        attachments: [
          {
            filename: 'scoreboard.png',
            contentType: 'image/png',
            content: Buffer.from('png'),
          },
        ],
      };
    },
    async getSenderAllowlist(parameterName) {
      allowlistReads.push(parameterName);
      return options.allowlist;
    },
    async inspectImage() {
      inspections += 1;
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
  const outcome = await processEmail(
    { bucket: 'raw', key: 'incoming/message' },
    dependencies,
  ).then(
    (result) => ({ result, error: undefined }),
    (error: Error) => ({ result: undefined, error }),
  );
  const find = (fragment: string): Record<string, any> => {
    const write = jsonWrites.find((candidate) =>
      candidate.key.includes(fragment),
    );
    if (!write) throw new Error(`No evidence written under ${fragment}`);
    return write.value as Record<string, any>;
  };
  return {
    ...outcome,
    ingestion: find('/ingestion.json'),
    completion: find('/completion.json'),
    event: find('/events/'),
    objectWrites,
    allowlistReads,
    inspections: () => inspections,
  };
}

const sesHeaders = (spam: string, virus: string) => [
  { key: 'x-ses-spam-verdict', line: `X-SES-Spam-Verdict: ${spam}` },
  { key: 'x-ses-virus-verdict', line: `X-SES-Virus-Verdict: ${virus}` },
  { key: 'x-ses-spf-verdict', line: 'X-SES-SPF-Verdict: PASS' },
  { key: 'x-ses-dkim-verdict', line: 'X-SES-DKIM-Verdict: GRAY' },
];

test('processEmail accepts a listed sender with passing verdicts and records the decision', async () => {
  const run = await runScreening({
    headerLines: sesHeaders('PASS', 'PASS'),
    fromAddresses: ['Player@Example.test'],
    allowlistParameter: '/mcc/dev/match-to-csv/sender-allowlist',
    allowlist: ['player@example.test', 'other@example.test'],
  });

  assert.equal(run.error, undefined);
  assert.equal(run.result?.screenshots.length, 1);
  assert.deepEqual(run.allowlistReads, [
    '/mcc/dev/match-to-csv/sender-allowlist',
  ]);
  const sesVerdicts = {
    spam: 'PASS',
    virus: 'PASS',
    spf: 'PASS',
    dkim: 'GRAY',
  };
  const senderAllowlist = {
    status: 'ALLOWED',
    parameterName: '/mcc/dev/match-to-csv/sender-allowlist',
    fromAddresses: ['player@example.test'],
  };
  assert.deepEqual(run.ingestion.sesVerdicts, sesVerdicts);
  assert.deepEqual(run.ingestion.senderAllowlist, senderAllowlist);
  assert.equal(run.completion.status, 'SUCCEEDED');
  assert.deepEqual(run.completion.rejectionCodes, []);
  assert.equal(run.event.type, 'SUBMISSION_ACCEPTED');
  assert.deepEqual(run.event.detail.sesVerdicts, sesVerdicts);
  assert.deepEqual(run.event.detail.senderAllowlist, senderAllowlist);
});

test('processEmail keeps today behavior when no allowlist is configured', async () => {
  const unset = await runScreening({ fromAddresses: ['a@example.test'] });
  assert.equal(unset.error, undefined);
  assert.deepEqual(
    unset.allowlistReads,
    [],
    'no parameter name means no SSM read',
  );
  assert.deepEqual(unset.ingestion.senderAllowlist, {
    status: 'NOT_CONFIGURED',
    parameterName: null,
    fromAddresses: ['a@example.test'],
  });
  assert.deepEqual(unset.ingestion.sesVerdicts, {
    spam: null,
    virus: null,
    spf: null,
    dkim: null,
  });

  const absent = await runScreening({
    fromAddresses: ['a@example.test'],
    allowlistParameter: '/mcc/dev/match-to-csv/sender-allowlist',
    allowlist: undefined,
  });
  assert.equal(absent.error, undefined);
  assert.equal(absent.result?.screenshots.length, 1);
  assert.equal(absent.ingestion.senderAllowlist.status, 'NOT_CONFIGURED');
  assert.equal(absent.event.type, 'SUBMISSION_ACCEPTED');
});

for (const [spam, virus, codes] of [
  ['FAIL', 'PASS', ['SPAM_VERDICT_FAILED']],
  ['PASS', 'FAIL', ['VIRUS_VERDICT_FAILED']],
  ['FAIL', 'FAIL', ['SPAM_VERDICT_FAILED', 'VIRUS_VERDICT_FAILED']],
] as const) {
  test(`processEmail rejects spam ${spam} and virus ${virus} before storing any screenshot`, async () => {
    const run = await runScreening({
      headerLines: sesHeaders(spam, virus),
      fromAddresses: ['player@example.test'],
    });

    assert.equal(run.error?.name, 'SubmissionRejectedError');
    assert.deepEqual(run.objectWrites, [], 'no screenshot is stored');
    assert.equal(run.inspections(), 0, 'no attachment is inspected');
    assert.equal(run.ingestion.sesVerdicts.spam, spam);
    assert.equal(run.ingestion.sesVerdicts.virus, virus);
    assert.equal(run.completion.status, 'REJECTED');
    assert.deepEqual(run.completion.rejectionCodes, codes);
    assert.equal(run.completion.acceptedScreenshotCount, 0);
    assert.equal(run.event.type, 'SUBMISSION_REJECTED');
    assert.deepEqual(run.event.detail.rejectionCodes, codes);
    assert.equal(run.event.detail.sesVerdicts.spam, spam);
  });
}

for (const [label, fromAddresses] of [
  ['an unlisted sender', ['stranger@example.test']],
  ['a message with one unlisted sender', ['player@example.test', 'x@y.test']],
  ['a message without a From address', []],
] as const) {
  test(`processEmail rejects ${label} by allowlist`, async () => {
    const run = await runScreening({
      headerLines: sesHeaders('PASS', 'PASS'),
      fromAddresses: [...fromAddresses],
      allowlistParameter: '/mcc/dev/match-to-csv/sender-allowlist',
      allowlist: ['player@example.test'],
    });

    assert.equal(run.error?.name, 'SubmissionRejectedError');
    assert.deepEqual(run.objectWrites, []);
    assert.equal(run.inspections(), 0);
    assert.equal(run.ingestion.senderAllowlist.status, 'DENIED');
    assert.equal(run.completion.status, 'REJECTED');
    assert.deepEqual(run.completion.rejectionCodes, ['SENDER_NOT_ALLOWED']);
    assert.equal(run.event.type, 'SUBMISSION_REJECTED');
    assert.deepEqual(run.event.detail.senderAllowlist, {
      status: 'DENIED',
      parameterName: '/mcc/dev/match-to-csv/sender-allowlist',
      fromAddresses,
    });
  });
}

test('processEmail records every screening rejection together', async () => {
  const run = await runScreening({
    headerLines: sesHeaders('FAIL', 'PASS'),
    fromAddresses: ['stranger@example.test'],
    allowlistParameter: '/mcc/dev/match-to-csv/sender-allowlist',
    allowlist: [],
  });
  assert.deepEqual(run.completion.rejectionCodes, [
    'SPAM_VERDICT_FAILED',
    'SENDER_NOT_ALLOWED',
  ]);
});

test('processEmail writes no evidence when the allowlist read fails', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  process.env.SENDER_ALLOWLIST_PARAMETER =
    '/mcc/dev/match-to-csv/sender-allowlist';
  const writes: string[] = [];
  const throttled = Object.assign(new Error('slow down'), {
    name: 'ThrottlingException',
  });
  await assert.rejects(
    processEmail(
      { bucket: 'raw', key: 'incoming/message' },
      {
        async getRawEmail() {
          return Buffer.from('mime');
        },
        async parseEmail() {
          return { attachments: [] };
        },
        async getSenderAllowlist() {
          throw throttled;
        },
        async inspectImage() {
          throw new Error('not called');
        },
        async putObject(reference) {
          writes.push(reference.key);
        },
        async writeJson(bucket, key) {
          writes.push(key);
          return { bucket, key };
        },
        id: () => 'id',
        timestamp: () => '2026-01-01T00:00:00.000Z',
      },
    ),
    { name: 'ThrottlingException' },
  );
  assert.deepEqual(
    writes,
    [],
    'a Step Functions retry starts without partial evidence',
  );
});

test('SES verdicts come from the topmost header of each kind', () => {
  assert.deepEqual(
    parseSesVerdicts([
      { key: 'X-SES-Spam-Verdict', line: 'X-SES-Spam-Verdict:\r\n  fail' },
      { key: 'from', line: 'From: a@example.test' },
      { key: 'x-ses-spam-verdict', line: 'X-SES-Spam-Verdict: PASS' },
      { key: 'x-ses-virus-verdict', line: 'X-SES-Virus-Verdict: PASS' },
    ]),
    { spam: 'FAIL', virus: 'PASS', spf: null, dkim: null },
  );
});

test('the sender allowlist splits on commas and whitespace', () => {
  assert.deepEqual(
    parseSenderAllowlist(' A@Example.test,b@example.test\nc@x.test ,, '),
    ['a@example.test', 'b@example.test', 'c@x.test'],
  );
  assert.deepEqual(parseSenderAllowlist(''), []);
});

test('processEmail preserves images and returns every processable attachment', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  process.env.OBJECT_PREFIX = 'ephemeral/tester';

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
          {
            filename: 'scoreboard.png',
            contentType: 'image/png',
            content: Buffer.from('png'),
          },
          {
            filename: 'notes.txt',
            contentType: 'text/plain',
            content: Buffer.from('text'),
          },
          {
            filename: 'photo.webp',
            contentType: 'image/webp',
            content: Buffer.from('webp'),
          },
          {
            filename: 'logo.jpg',
            contentType: 'image/jpeg',
            content: Buffer.from('small'),
          },
        ],
      };
    },
    async getSenderAllowlist() {
      throw new Error('not called');
    },
    async inspectImage(content) {
      if (content.toString() === 'webp')
        return { format: 'webp', width: 1920, height: 1080 };
      if (content.toString() === 'small')
        return { format: 'jpeg', width: 200, height: 100 };
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

  assert.equal(result.screenshots.length, 1);
  assert.equal(result.rejectedAttachments.length, 3);
  assert.deepEqual(
    result.rejectedAttachments.map((item) => item.rejectionCodes),
    [['NOT_AN_IMAGE'], ['UNSUPPORTED_IMAGE_FORMAT'], ['IMAGE_TOO_SMALL']],
  );
  assert.equal(objectWrites.length, 3, 'every image original is preserved');
  assert.ok(
    objectWrites.every((reference) =>
      reference.key.startsWith('ephemeral/tester/submissions/'),
    ),
    'all image artifacts use the ephemeral namespace',
  );
  assert.ok(jsonWrites.some((write) => write.key.endsWith('/ingestion.json')));
  assert.ok(jsonWrites.some((write) => write.key.endsWith('/completion.json')));
  assert.ok(
    jsonWrites.some((write) => write.value.type === 'SUBMISSION_ACCEPTED'),
  );
});

test('processEmail records and rejects an email without a screenshot', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
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
    async getSenderAllowlist() {
      throw new Error('not called');
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

  await assert.rejects(
    processEmail({ bucket: 'raw', key: 'incoming/message' }, dependencies),
    { name: 'NoProcessableScreenshotsError' },
  );
  assert.ok(
    jsonWrites.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.status === 'REJECTED',
    ),
  );
  assert.ok(
    jsonWrites.some((write) => write.value.type === 'SUBMISSION_REJECTED'),
  );
});

test('attachment validation reports independent problems', () => {
  assert.deepEqual(
    attachmentRejectionCodes(Buffer.alloc(10_000_001), {
      format: 'webp',
      width: 100,
      height: 100,
    }),
    ['UNSUPPORTED_IMAGE_FORMAT', 'IMAGE_TOO_LARGE', 'IMAGE_TOO_SMALL'],
  );
  assert.deepEqual(
    attachmentRejectionCodes(Buffer.from('bad'), {}, new Error('invalid')),
    ['UNREADABLE_IMAGE'],
  );
});

test('attachment validation uses the 10,000,000-byte Textract limit', () => {
  const metadata = { format: 'png', width: 1920, height: 1080 };
  assert.deepEqual(
    attachmentRejectionCodes(Buffer.alloc(10_000_000), metadata),
    [],
  );
  assert.deepEqual(
    attachmentRejectionCodes(Buffer.alloc(10_000_001), metadata),
    ['IMAGE_TOO_LARGE'],
  );
});

test('processEmail records a failed completion when evidence storage fails', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
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
    async getSenderAllowlist() {
      throw new Error('not called');
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

  await assert.rejects(
    processEmail({ bucket: 'raw', key: 'incoming/message' }, dependencies),
    { message: 'storage failed' },
  );
  assert.ok(
    jsonWrites.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.status === 'FAILED',
    ),
  );
  assert.ok(
    jsonWrites.some((write) => write.value.type === 'SUBMISSION_FAILED'),
  );
});
