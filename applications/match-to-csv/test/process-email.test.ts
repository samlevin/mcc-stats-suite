import t, { type Test } from 'tap';
import type { S3ObjectReference } from '@samlevin/contracts';
import {
  attachmentRejectionCodes,
  parseSenderAllowlist,
  parseSesVerdicts,
  processEmail,
  type ProcessEmailDependencies,
} from '../src/lambdas/process-email';

interface ScreeningCase {
  headerLines?: Array<{ key: string; line: string }>;
  fromAddresses?: string[];
  /** Undefined leaves SENDER_ALLOWLIST_PARAMETER unset. */
  allowlistParameter?: string;
  allowlist?: string[];
}

/** Runs processEmail on one valid screenshot and records every side effect. */
async function runScreening(t: Test, options: ScreeningCase) {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  if (options.allowlistParameter) {
    process.env.SENDER_ALLOWLIST_PARAMETER = options.allowlistParameter;
  }
  t.teardown(() => {
    delete process.env.EVIDENCE_BUCKET;
    delete process.env.SENDER_ALLOWLIST_PARAMETER;
  });
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

t.test(
  'processEmail accepts a listed sender with passing verdicts and records the decision',
  async (t) => {
    const run = await runScreening(t, {
      headerLines: sesHeaders('PASS', 'PASS'),
      fromAddresses: ['Player@Example.test'],
      allowlistParameter: '/mcc/dev/match-to-csv/sender-allowlist',
      allowlist: ['player@example.test', 'other@example.test'],
    });

    t.equal(run.error, undefined);
    t.equal(run.result?.screenshots.length, 1);
    t.same(run.allowlistReads, ['/mcc/dev/match-to-csv/sender-allowlist']);
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
    t.same(run.ingestion.sesVerdicts, sesVerdicts);
    t.same(run.ingestion.senderAllowlist, senderAllowlist);
    t.equal(run.completion.status, 'SUCCEEDED');
    t.same(run.completion.rejectionCodes, []);
    t.equal(run.event.type, 'SUBMISSION_ACCEPTED');
    t.same(run.event.detail.sesVerdicts, sesVerdicts);
    t.same(run.event.detail.senderAllowlist, senderAllowlist);
  },
);

t.test(
  'processEmail keeps today behavior when no allowlist is configured',
  async (t) => {
    const unset = await runScreening(t, { fromAddresses: ['a@example.test'] });
    t.equal(unset.error, undefined);
    t.same(unset.allowlistReads, [], 'no parameter name means no SSM read');
    t.same(unset.ingestion.senderAllowlist, {
      status: 'NOT_CONFIGURED',
      parameterName: null,
      fromAddresses: ['a@example.test'],
    });
    t.same(unset.ingestion.sesVerdicts, {
      spam: null,
      virus: null,
      spf: null,
      dkim: null,
    });

    const absent = await runScreening(t, {
      fromAddresses: ['a@example.test'],
      allowlistParameter: '/mcc/dev/match-to-csv/sender-allowlist',
      allowlist: undefined,
    });
    t.equal(absent.error, undefined);
    t.equal(absent.result?.screenshots.length, 1);
    t.equal(absent.ingestion.senderAllowlist.status, 'NOT_CONFIGURED');
    t.equal(absent.event.type, 'SUBMISSION_ACCEPTED');
  },
);

for (const [spam, virus, codes] of [
  ['FAIL', 'PASS', ['SPAM_VERDICT_FAILED']],
  ['PASS', 'FAIL', ['VIRUS_VERDICT_FAILED']],
  ['FAIL', 'FAIL', ['SPAM_VERDICT_FAILED', 'VIRUS_VERDICT_FAILED']],
] as const) {
  t.test(
    `processEmail rejects spam ${spam} and virus ${virus} before storing any screenshot`,
    async (t) => {
      const run = await runScreening(t, {
        headerLines: sesHeaders(spam, virus),
        fromAddresses: ['player@example.test'],
      });

      t.match(run.error, { name: 'SubmissionRejectedError' });
      t.same(run.objectWrites, [], 'no screenshot is stored');
      t.equal(run.inspections(), 0, 'no attachment is inspected');
      t.equal(run.ingestion.sesVerdicts.spam, spam);
      t.equal(run.ingestion.sesVerdicts.virus, virus);
      t.equal(run.completion.status, 'REJECTED');
      t.same(run.completion.rejectionCodes, codes);
      t.equal(run.completion.acceptedScreenshotCount, 0);
      t.equal(run.event.type, 'SUBMISSION_REJECTED');
      t.same(run.event.detail.rejectionCodes, codes);
      t.equal(run.event.detail.sesVerdicts.spam, spam);
    },
  );
}

for (const [label, fromAddresses] of [
  ['an unlisted sender', ['stranger@example.test']],
  ['a message with one unlisted sender', ['player@example.test', 'x@y.test']],
  ['a message without a From address', []],
] as const) {
  t.test(`processEmail rejects ${label} by allowlist`, async (t) => {
    const run = await runScreening(t, {
      headerLines: sesHeaders('PASS', 'PASS'),
      fromAddresses: [...fromAddresses],
      allowlistParameter: '/mcc/dev/match-to-csv/sender-allowlist',
      allowlist: ['player@example.test'],
    });

    t.match(run.error, { name: 'SubmissionRejectedError' });
    t.same(run.objectWrites, []);
    t.equal(run.inspections(), 0);
    t.equal(run.ingestion.senderAllowlist.status, 'DENIED');
    t.equal(run.completion.status, 'REJECTED');
    t.same(run.completion.rejectionCodes, ['SENDER_NOT_ALLOWED']);
    t.equal(run.event.type, 'SUBMISSION_REJECTED');
    t.same(run.event.detail.senderAllowlist, {
      status: 'DENIED',
      parameterName: '/mcc/dev/match-to-csv/sender-allowlist',
      fromAddresses,
    });
  });
}

t.test('processEmail records every screening rejection together', async (t) => {
  const run = await runScreening(t, {
    headerLines: sesHeaders('FAIL', 'PASS'),
    fromAddresses: ['stranger@example.test'],
    allowlistParameter: '/mcc/dev/match-to-csv/sender-allowlist',
    allowlist: [],
  });
  t.same(run.completion.rejectionCodes, [
    'SPAM_VERDICT_FAILED',
    'SENDER_NOT_ALLOWED',
  ]);
});

t.test(
  'processEmail writes no evidence when the allowlist read fails',
  async (t) => {
    process.env.EVIDENCE_BUCKET = 'evidence-bucket';
    process.env.SENDER_ALLOWLIST_PARAMETER =
      '/mcc/dev/match-to-csv/sender-allowlist';
    t.teardown(() => {
      delete process.env.EVIDENCE_BUCKET;
      delete process.env.SENDER_ALLOWLIST_PARAMETER;
    });
    const writes: string[] = [];
    const throttled = Object.assign(new Error('slow down'), {
      name: 'ThrottlingException',
    });
    await t.rejects(
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
    t.same(
      writes,
      [],
      'a Step Functions retry starts without partial evidence',
    );
  },
);

t.test('SES verdicts come from the topmost header of each kind', (t) => {
  t.same(
    parseSesVerdicts([
      { key: 'X-SES-Spam-Verdict', line: 'X-SES-Spam-Verdict:\r\n  fail' },
      { key: 'from', line: 'From: a@example.test' },
      { key: 'x-ses-spam-verdict', line: 'X-SES-Spam-Verdict: PASS' },
      { key: 'x-ses-virus-verdict', line: 'X-SES-Virus-Verdict: PASS' },
    ]),
    { spam: 'FAIL', virus: 'PASS', spf: null, dkim: null },
  );
  t.end();
});

t.test('the sender allowlist splits on commas and whitespace', (t) => {
  t.same(parseSenderAllowlist(' A@Example.test,b@example.test\nc@x.test ,, '), [
    'a@example.test',
    'b@example.test',
    'c@x.test',
  ]);
  t.same(parseSenderAllowlist(''), []);
  t.end();
});

t.test(
  'processEmail preserves images and returns every processable attachment',
  async (t) => {
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

    t.equal(result.screenshots.length, 1);
    t.equal(result.rejectedAttachments.length, 3);
    t.same(
      result.rejectedAttachments.map((item) => item.rejectionCodes),
      [['NOT_AN_IMAGE'], ['UNSUPPORTED_IMAGE_FORMAT'], ['IMAGE_TOO_SMALL']],
    );
    t.equal(objectWrites.length, 3, 'every image original is preserved');
    t.ok(
      objectWrites.every((reference) =>
        reference.key.startsWith('ephemeral/tester/submissions/'),
      ),
      'all image artifacts use the ephemeral namespace',
    );
    t.ok(jsonWrites.some((write) => write.key.endsWith('/ingestion.json')));
    t.ok(jsonWrites.some((write) => write.key.endsWith('/completion.json')));
    t.ok(
      jsonWrites.some((write) => write.value.type === 'SUBMISSION_ACCEPTED'),
    );
  },
);

t.test(
  'processEmail records and rejects an email without a screenshot',
  async (t) => {
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
  },
);

t.test('attachment validation reports independent problems', (t) => {
  t.same(
    attachmentRejectionCodes(Buffer.alloc(10_000_001), {
      format: 'webp',
      width: 100,
      height: 100,
    }),
    ['UNSUPPORTED_IMAGE_FORMAT', 'IMAGE_TOO_LARGE', 'IMAGE_TOO_SMALL'],
  );
  t.same(
    attachmentRejectionCodes(Buffer.from('bad'), {}, new Error('invalid')),
    ['UNREADABLE_IMAGE'],
  );
  t.end();
});

t.test('attachment validation uses the 10,000,000-byte Textract limit', (t) => {
  const metadata = { format: 'png', width: 1920, height: 1080 };
  t.same(attachmentRejectionCodes(Buffer.alloc(10_000_000), metadata), []);
  t.same(attachmentRejectionCodes(Buffer.alloc(10_000_001), metadata), [
    'IMAGE_TOO_LARGE',
  ]);
  t.end();
});

t.test(
  'processEmail records a failed completion when evidence storage fails',
  async (t) => {
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
  },
);
