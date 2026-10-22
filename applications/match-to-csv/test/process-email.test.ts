import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type {
  ProcessEmailInput,
  S3ObjectReference,
  SubmissionRejectionCode,
} from '@mcc/contracts';
import {
  attachmentRejectionCodes,
  createParameterReader,
  matchDateReply,
  parseEmail,
  parseMatchDate,
  parseSenderAllowlist,
  parseSesRecipients,
  parseSesVerdicts,
  processEmail,
  type ProcessEmailDependencies,
  type ReplyMessage,
} from '../src/lambdas/process-email';
import { publishStageEvent, type StageEvent } from '../src/lib/metrics';
import { readReceivedAt } from '../src/lib/received-at';
import { captureLogLines } from './support/log-lines';

let stageEvents: StageEvent[] = [];

function recordStageEvent(stageEvent: StageEvent): void {
  stageEvents.push(stageEvent);
}

/** A clock that advances 250 ms on each reading. */
function clock(): () => number {
  let next = 0;
  return () => {
    const current = next;
    next += 250;
    return current;
  };
}

beforeEach(() => {
  stageEvents = [];
});

afterEach(() => {
  delete process.env.EVIDENCE_BUCKET;
  delete process.env.SENDER_ALLOWLIST_PARAMETER;
  delete process.env.OBJECT_PREFIX;
  delete process.env.EMAIL_ALIAS_PARAMETER;
  delete process.env.EMAIL_DOMAIN_PARAMETER;
  delete process.env.RECIPIENT_SUBADDRESS;
  delete process.env.REPLY_FROM_DOMAIN;
});

/** A valid match date body, as a person would type it. */
const MATCH_DATE = '5/2/2026';
const REPLY_DOMAIN = 'mail.example.test';
const ALLOWLIST_PARAMETER = '/mcc/dev/match-to-csv/sender-allowlist';
const LISTED_SENDER = 'player@example.test';

interface ScreeningCase {
  headerLines?: Array<{ key: string; line: string }>;
  fromAddresses?: string[];
  /**
   * Undefined leaves SENDER_ALLOWLIST_PARAMETER unset; absent uses
   * ALLOWLIST_PARAMETER.
   */
  allowlistParameter?: string;
  /**
   * The parameter's addresses. Undefined means the parameter is missing;
   * absent lists LISTED_SENDER.
   */
  allowlist?: string[];
  /**
   * Configures an ephemeral stack's recipient check: the stack name and the
   * current parameter values, where undefined means the parameter is missing.
   */
  ephemeral?: { name: string; alias?: string; domain?: string };
  /** The plain-text body. Defaults to a valid match date when absent. */
  text?: string;
  /**
   * Raw MIME for the real parser. When set, headerLines, fromAddresses, text,
   * messageId, and subject are ignored.
   */
  rawEmail?: string;
  messageId?: string;
  subject?: string;
  /** Makes every reply send fail with this error. */
  sendError?: Error;
  /** Undefined leaves REPLY_FROM_DOMAIN unset; absent uses REPLY_DOMAIN. */
  replyDomain?: string;
  /** Fields the workflow adds to the raw email reference. */
  input?: Omit<ProcessEmailInput, 'bucket' | 'key'>;
  /** Valid PNG attachments in the message. Defaults to 1. */
  screenshotCount?: number;
}

const ALIAS_PARAMETER = '/mcc/dev/match-to-csv/email-alias';
const DOMAIN_PARAMETER = '/mcc/dev/match-to-csv/email-domain';

/** Runs processEmail on one valid screenshot and records every side effect. */
async function runScreening(options: ScreeningCase) {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  const allowlistParameter =
    'allowlistParameter' in options
      ? options.allowlistParameter
      : ALLOWLIST_PARAMETER;
  if (allowlistParameter) {
    process.env.SENDER_ALLOWLIST_PARAMETER = allowlistParameter;
  }
  const allowlist =
    'allowlist' in options ? options.allowlist : [LISTED_SENDER];
  if (options.ephemeral) {
    process.env.EMAIL_ALIAS_PARAMETER = ALIAS_PARAMETER;
    process.env.EMAIL_DOMAIN_PARAMETER = DOMAIN_PARAMETER;
    process.env.RECIPIENT_SUBADDRESS = options.ephemeral.name;
  }
  const replyDomain =
    'replyDomain' in options ? options.replyDomain : REPLY_DOMAIN;
  if (replyDomain) process.env.REPLY_FROM_DOMAIN = replyDomain;
  const parameters: Record<string, string | undefined> = {
    [ALIAS_PARAMETER]: options.ephemeral?.alias,
    [DOMAIN_PARAMETER]: options.ephemeral?.domain,
  };
  const jsonWrites: Array<{ key: string; value: any }> = [];
  const objectWrites: S3ObjectReference[] = [];
  const allowlistReads: string[] = [];
  const parameterReads: string[] = [];
  const sends: ReplyMessage[] = [];
  let inspections = 0;
  let id = 0;
  const dependencies: ProcessEmailDependencies = {
    async getRawEmail() {
      return Buffer.from(options.rawEmail ?? 'mime');
    },
    async parseEmail(rawEmail) {
      if (options.rawEmail !== undefined) return parseEmail(rawEmail);
      return {
        messageId: options.messageId,
        subject: options.subject,
        headerLines: options.headerLines,
        fromAddresses: options.fromAddresses,
        text: 'text' in options ? options.text : MATCH_DATE,
        attachments: Array.from(
          { length: options.screenshotCount ?? 1 },
          (_, index) => ({
            filename:
              index === 0 ? 'scoreboard.png' : `scoreboard-${index + 1}.png`,
            contentType: 'image/png',
            content: Buffer.from(`png-${index}`),
          }),
        ),
      };
    },
    async getSenderAllowlist(parameterName) {
      allowlistReads.push(parameterName);
      return allowlist;
    },
    async getParameter(parameterName) {
      parameterReads.push(parameterName);
      return parameters[parameterName];
    },
    async inspectImage() {
      inspections += 1;
      return { format: 'png', width: 1920, height: 1080 };
    },
    async sendEmail(message) {
      sends.push(message);
      if (options.sendError) throw options.sendError;
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
    publishStageEvent: recordStageEvent,
    now: clock(),
  };
  const captured = captureLogLines();
  stageEvents = [];
  const outcome = await processEmail(
    { bucket: 'raw', key: 'incoming/message', ...options.input },
    dependencies,
    'request-1',
  )
    .then(
      ({ result, matchDateReply }) => ({
        result,
        matchDateReply,
        error: undefined,
      }),
      (error: Error) => ({
        result: undefined,
        matchDateReply: undefined,
        error,
      }),
    )
    .finally(captured.restore);
  const logs = captured.lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
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
    accepted:
      outcome.result?.status === 'ACCEPTED' ? outcome.result : undefined,
    ingestion: find('/ingestion.json'),
    completion: find('/completion.json'),
    event: find('/events/'),
    sourceMetadata: jsonWrites
      .filter((write) => write.key.endsWith('/source/metadata.json'))
      .map((write) => write.value as Record<string, unknown>),
    objectWrites,
    allowlistReads,
    parameterReads,
    sends,
    logs,
    stageEvents: [...stageEvents],
    inspections: () => inspections,
  };
}

/**
 * Asserts that a run returned the rejected result, without throwing, for the
 * submission it recorded.
 */
function assertRejected(
  run: Awaited<ReturnType<typeof runScreening>>,
  rejectionCodes: readonly SubmissionRejectionCode[],
): void {
  assert.equal(run.error, undefined, 'a rejection is a result, not an error');
  assert.deepEqual(run.result, {
    status: 'REJECTED',
    submissionId: run.ingestion.submissionId as string,
    rejectionCodes,
  });
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
  assert.equal(run.accepted?.screenshots.length, 1);
  assert.equal(run.accepted?.matchDate, '2026-05-02');
  assert.equal(run.ingestion.matchDate, '2026-05-02');
  assert.deepEqual(run.sends, [], 'an accepted submission gets no reply');
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

const RECEIVED_AT = '2026-05-02T18:30:00Z';
const trace = {
  executionId:
    'arn:aws:states:us-east-1:000000000000:execution:match-to-csv-dev:example',
  retryCount: 0,
  workflow: 'INGEST' as const,
};

test('processEmail copies receivedAt into its output and every screenshot', async () => {
  const run = await runScreening({
    fromAddresses: [LISTED_SENDER],
    input: { receivedAt: RECEIVED_AT, trace },
    screenshotCount: 2,
  });

  assert.equal(run.error, undefined);
  assert.equal(run.result?.status, 'ACCEPTED');
  assert.equal(run.accepted?.receivedAt, RECEIVED_AT);
  assert.equal(run.accepted?.screenshots.length, 2);
  for (const screenshot of run.accepted?.screenshots ?? []) {
    assert.equal(screenshot.receivedAt, RECEIVED_AT);
  }
  assert.equal(run.sourceMetadata.length, 2);
  for (const metadata of run.sourceMetadata) {
    assert.equal(metadata.receivedAt, RECEIVED_AT, 'replays read it back');
  }
  assert.deepEqual(
    run.ingestion.rawEmail,
    { bucket: 'raw', key: 'incoming/message' },
    'trace context is not evidence',
  );
});

test('processEmail omits receivedAt when the input has none', async () => {
  const run = await runScreening({
    fromAddresses: [LISTED_SENDER],
    screenshotCount: 2,
  });

  assert.equal(run.error, undefined);
  assert.equal(run.result?.status, 'ACCEPTED');
  assert.ok(run.accepted && !('receivedAt' in run.accepted));
  assert.equal(run.accepted?.screenshots.length, 2);
  for (const screenshot of run.accepted?.screenshots ?? []) {
    assert.ok(!('receivedAt' in screenshot));
  }
  for (const metadata of run.sourceMetadata) {
    assert.ok(!('receivedAt' in metadata));
  }
  assert.deepEqual(run.ingestion.rawEmail, {
    bucket: 'raw',
    key: 'incoming/message',
  });
});

test('processEmail drops a malformed receivedAt instead of rejecting the email', async () => {
  for (const receivedAt of [42, 'yesterday', '2026-02-30T00:00:00Z']) {
    const run = await runScreening({
      fromAddresses: [LISTED_SENDER],
      input: { receivedAt: receivedAt as string },
    });
    assert.equal(run.error, undefined);
    assert.equal(run.accepted?.screenshots.length, 1);
    assert.ok(run.accepted && !('receivedAt' in run.accepted));
    assert.ok(!('receivedAt' in (run.accepted?.screenshots[0] ?? {})));
    assert.ok(!('receivedAt' in run.sourceMetadata[0]));
  }
});

test('receivedAt is read only as an ISO 8601 timestamp', () => {
  for (const value of [
    '2026-05-02T18:30:00Z',
    '2026-05-02T18:30:00.123Z',
    '2024-02-29T23:59:59+05:30',
  ]) {
    assert.equal(readReceivedAt(value), value);
  }
  for (const value of [
    undefined,
    null,
    42,
    { time: RECEIVED_AT },
    '',
    'yesterday',
    '2026-05-02',
    '2026-05-02T18:30:00',
    '2026-05-02 18:30:00Z',
    '2026-02-30T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-05-02T25:00:00Z',
    ` ${RECEIVED_AT}`,
  ]) {
    assert.equal(readReceivedAt(value), undefined, JSON.stringify(value));
  }
});

test('processEmail rejects every sender when no allowlist parameter is named', async () => {
  const unset = await runScreening({
    fromAddresses: [LISTED_SENDER],
    allowlistParameter: undefined,
  });
  assertRejected(unset, ['SENDER_NOT_ALLOWED']);
  assert.deepEqual(
    unset.allowlistReads,
    [],
    'no parameter name means no SSM read',
  );
  assert.deepEqual(
    unset.parameterReads,
    [],
    'a stable stack checks no recipient',
  );
  assert.deepEqual(unset.objectWrites, [], 'no screenshot is stored');
  assert.equal(unset.inspections(), 0, 'no attachment is inspected');
  assert.deepEqual(unset.ingestion.recipientCheck, {
    status: 'NOT_CONFIGURED',
    recipients: [],
  });
  const senderAllowlist = {
    status: 'NOT_CONFIGURED',
    parameterName: null,
    fromAddresses: [LISTED_SENDER],
  };
  assert.deepEqual(unset.ingestion.senderAllowlist, senderAllowlist);
  assert.deepEqual(unset.ingestion.sesVerdicts, {
    spam: null,
    virus: null,
    spf: null,
    dkim: null,
  });
  assert.equal(unset.completion.status, 'REJECTED');
  assert.deepEqual(unset.completion.rejectionCodes, ['SENDER_NOT_ALLOWED']);
  assert.equal(unset.event.type, 'SUBMISSION_REJECTED');
  assert.deepEqual(unset.event.detail.senderAllowlist, senderAllowlist);
});

for (const [label, allowlist] of [
  ['a missing allowlist parameter', undefined],
  ['an allowlist with no addresses', []],
  ['an allowlist of blank entries', ['', ' ']],
] as const) {
  test(`processEmail rejects every sender for ${label} and records that no allowlist was configured`, async () => {
    const run = await runScreening({
      headerLines: sesHeaders('PASS', 'PASS'),
      fromAddresses: [LISTED_SENDER],
      allowlist: allowlist && [...allowlist],
    });

    assertRejected(run, ['SENDER_NOT_ALLOWED']);
    assert.equal(run.accepted, undefined);
    assert.deepEqual(run.allowlistReads, [ALLOWLIST_PARAMETER]);
    assert.deepEqual(run.objectWrites, [], 'no screenshot is stored');
    assert.equal(run.inspections(), 0, 'no attachment is inspected');
    const senderAllowlist = {
      status: 'NOT_CONFIGURED',
      parameterName: ALLOWLIST_PARAMETER,
      fromAddresses: [LISTED_SENDER],
    };
    assert.deepEqual(run.ingestion.senderAllowlist, senderAllowlist);
    assert.equal(run.completion.status, 'REJECTED');
    assert.deepEqual(run.completion.rejectionCodes, ['SENDER_NOT_ALLOWED']);
    assert.equal(run.completion.acceptedScreenshotCount, 0);
    assert.equal(run.event.type, 'SUBMISSION_REJECTED');
    assert.deepEqual(run.event.detail.rejectionCodes, ['SENDER_NOT_ALLOWED']);
    assert.deepEqual(run.event.detail.senderAllowlist, senderAllowlist);
    assert.deepEqual(run.sends, []);
  });
}

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

    assertRejected(run, codes);
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

    assertRejected(run, ['SENDER_NOT_ALLOWED']);
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
  assertRejected(run, ['SPAM_VERDICT_FAILED', 'SENDER_NOT_ALLOWED']);
  assert.deepEqual(run.completion.rejectionCodes, [
    'SPAM_VERDICT_FAILED',
    'SENDER_NOT_ALLOWED',
  ]);
});

/** The Received header SES prepends, folded as SES folds it. */
const sesReceived = (recipients: string) => ({
  key: 'received',
  line:
    'Received: from mail.sender.test (mail.sender.test [192.0.2.1])\r\n' +
    ' by inbound-smtp.us-east-1.amazonaws.com with SMTP id abc123\r\n' +
    ` for ${recipients};\r\n` +
    ' Thu, 01 Jan 2026 00:00:00 +0000 (UTC)',
});

const current = {
  name: 'sam',
  alias: 'example-alias',
  domain: 'mail.example.com',
};

test('processEmail accepts an ephemeral message sent to the current alias and domain', async () => {
  const run = await runScreening({
    headerLines: [
      sesReceived('Example-Alias+Sam@Mail.Example.com'),
      ...sesHeaders('PASS', 'PASS'),
    ],
    fromAddresses: ['player@example.test'],
    ephemeral: current,
  });

  assert.equal(run.error, undefined);
  assert.equal(run.accepted?.screenshots.length, 1);
  assert.deepEqual(run.parameterReads.sort(), [
    ALIAS_PARAMETER,
    DOMAIN_PARAMETER,
  ]);
  const recipientCheck = {
    status: 'ALLOWED',
    recipients: ['example-alias+sam@mail.example.com'],
  };
  assert.deepEqual(run.ingestion.recipientCheck, recipientCheck);
  assert.equal(run.completion.status, 'SUCCEEDED');
  assert.equal(run.event.type, 'SUBMISSION_ACCEPTED');
  assert.deepEqual(run.event.detail.recipientCheck, recipientCheck);
});

for (const [label, forClause] of [
  [
    'also names the shared address',
    'example-alias@mail.example.com, Example-Alias+Sam@mail.example.com',
  ],
  [
    "also names another stack's address",
    '<example-alias+bob@mail.example.com>, <example-alias+sam@mail.example.com>',
  ],
  ['adds a comment', '<example-alias+sam@mail.example.com> (single recipient)'],
] as const) {
  test(`processEmail accepts an ephemeral message whose Received header ${label}`, async () => {
    const run = await runScreening({
      headerLines: [sesReceived(forClause), ...sesHeaders('PASS', 'PASS')],
      fromAddresses: ['player@example.test'],
      ephemeral: current,
    });

    assert.equal(run.error, undefined);
    assert.equal(run.ingestion.recipientCheck.status, 'ALLOWED');
    const recipients = run.ingestion.recipientCheck.recipients as string[];
    assert.ok(recipients.includes('example-alias+sam@mail.example.com'));
  });
}

for (const [label, headerLines, ephemeral] of [
  [
    'a stale rule on an old alias',
    [sesReceived('old-alias+sam@mail.example.com')],
    current,
  ],
  [
    'a stale rule on an old domain',
    [sesReceived('example-alias+sam@old.example.com')],
    current,
  ],
  [
    "another stack's address",
    [sesReceived('example-alias+bob@mail.example.com')],
    current,
  ],
  [
    'a message to the shared address only',
    [sesReceived('example-alias@mail.example.com')],
    current,
  ],
  ['a message without a Received header', [], current],
  [
    'a Received header without a for clause',
    [
      {
        key: 'received',
        line: 'Received: from a.test by inbound-smtp.test; Thu, 01 Jan 2026',
      },
    ],
    current,
  ],
  [
    'a missing alias parameter',
    [sesReceived('example-alias+sam@mail.example.com')],
    { ...current, alias: undefined },
  ],
  [
    'a missing domain parameter',
    [sesReceived('example-alias+sam@mail.example.com')],
    { ...current, domain: undefined },
  ],
] as const) {
  test(`processEmail rejects ${label} before storing any screenshot`, async () => {
    const run = await runScreening({
      headerLines: [...headerLines, ...sesHeaders('PASS', 'PASS')],
      fromAddresses: ['player@example.test'],
      ephemeral,
    });

    assertRejected(run, ['RECIPIENT_NOT_ALLOWED']);
    assert.deepEqual(run.objectWrites, [], 'no screenshot is stored');
    assert.equal(run.inspections(), 0, 'no attachment is inspected');
    assert.equal(run.ingestion.recipientCheck.status, 'DENIED');
    assert.equal(run.completion.status, 'REJECTED');
    assert.deepEqual(run.completion.rejectionCodes, ['RECIPIENT_NOT_ALLOWED']);
    assert.equal(run.completion.acceptedScreenshotCount, 0);
    assert.equal(run.event.type, 'SUBMISSION_REJECTED');
    assert.deepEqual(run.event.detail.rejectionCodes, [
      'RECIPIENT_NOT_ALLOWED',
    ]);
    assert.equal(run.event.detail.recipientCheck.status, 'DENIED');
  });
}

test('processEmail refuses a partial recipient configuration before writing evidence', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  process.env.EMAIL_ALIAS_PARAMETER = ALIAS_PARAMETER;
  const writes: string[] = [];
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
          throw new Error('not called');
        },
        async getParameter() {
          throw new Error('not called');
        },
        async inspectImage() {
          throw new Error('not called');
        },
        async sendEmail() {
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
        publishStageEvent: recordStageEvent,
        now: clock(),
      },
    ),
    /must be set together/,
  );
  assert.deepEqual(writes, []);
});

test('SES recipients come from the end of the topmost Received header', () => {
  assert.deepEqual(
    parseSesRecipients([
      sesReceived('<A+B@Example.test>'),
      { key: 'received', line: 'Received: by relay.test for x@y.test; date' },
    ]),
    ['a+b@example.test'],
  );
  assert.deepEqual(
    parseSesRecipients([
      {
        key: 'Received',
        line: 'Received: from h (x for spoof@example.test) by inbound-smtp.test with SMTP id 1 for real@example.test; Thu, 01 Jan 2026',
      },
    ]),
    ['real@example.test'],
    'only the clause just before the date counts',
  );
  assert.deepEqual(
    parseSesRecipients([sesReceived('a@example.test, b@example.test')]),
    ['a@example.test', 'b@example.test'],
  );
  assert.deepEqual(
    parseSesRecipients([sesReceived('<a@example.test> (comment, b@x.test)')]),
    ['a@example.test'],
    'comments and non-address tokens are ignored',
  );
  assert.deepEqual(
    parseSesRecipients([
      {
        key: 'received',
        line: 'Received: from h by inbound-smtp.test; date',
      },
      { key: 'received', line: 'Received: by relay.test for x@y.test; date' },
    ]),
    [],
    'a lower header written by the sender never supplies the recipient',
  );
  assert.deepEqual(parseSesRecipients([]), []);
});

test('parameter reads are cached for the TTL, including a missing parameter', async () => {
  let time = 0;
  const reads: string[] = [];
  const read = createParameterReader(
    async (name) => {
      reads.push(name);
      return name === 'missing' ? undefined : `${name}-${reads.length}`;
    },
    1000,
    () => time,
  );

  assert.equal(await read('alias'), 'alias-1');
  assert.equal(await read('missing'), undefined);
  time = 999;
  assert.equal(await read('alias'), 'alias-1');
  assert.equal(await read('missing'), undefined);
  assert.deepEqual(reads, ['alias', 'missing']);
  time = 1000;
  assert.equal(await read('alias'), 'alias-3', 'an expired value is re-read');
});

test('parameter read errors are not cached', async () => {
  let calls = 0;
  const read = createParameterReader(async () => {
    calls += 1;
    if (calls === 1) throw new Error('throttled');
    return 'value';
  });
  await assert.rejects(read('alias'), { message: 'throttled' });
  assert.equal(await read('alias'), 'value');
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
        async getParameter() {
          throw new Error('not called');
        },
        async inspectImage() {
          throw new Error('not called');
        },
        async sendEmail() {
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
        publishStageEvent: recordStageEvent,
        now: clock(),
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
  process.env.SENDER_ALLOWLIST_PARAMETER = ALLOWLIST_PARAMETER;

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
        fromAddresses: [LISTED_SENDER],
        text: MATCH_DATE,
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
      return [LISTED_SENDER];
    },
    async getParameter() {
      throw new Error('not called');
    },
    async inspectImage(content) {
      if (content.toString() === 'webp')
        return { format: 'webp', width: 1920, height: 1080 };
      if (content.toString() === 'small')
        return { format: 'jpeg', width: 200, height: 100 };
      return { format: 'png', width: 1920, height: 1080 };
    },
    async sendEmail() {
      throw new Error('not called');
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
    publishStageEvent: recordStageEvent,
    now: clock(),
  };

  const { result } = await processEmail(
    { bucket: 'raw', key: 'incoming/message' },
    dependencies,
  );

  assert.ok(result.status === 'ACCEPTED');
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

test('processEmail records and returns the rejection of an email without a screenshot', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  process.env.SENDER_ALLOWLIST_PARAMETER = ALLOWLIST_PARAMETER;
  const jsonWrites: Array<{ key: string; value: any }> = [];
  const dependencies: ProcessEmailDependencies = {
    async getRawEmail() {
      return Buffer.from('mime');
    },
    async parseEmail() {
      return {
        fromAddresses: [LISTED_SENDER],
        text: MATCH_DATE,
        attachments: [
          { contentType: 'text/plain', content: Buffer.from('notes') },
        ],
      };
    },
    async getSenderAllowlist() {
      return [LISTED_SENDER];
    },
    async getParameter() {
      throw new Error('not called');
    },
    async inspectImage() {
      throw new Error('not called');
    },
    async sendEmail() {
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
    publishStageEvent: recordStageEvent,
    now: clock(),
  };

  assert.deepEqual(
    (
      await processEmail(
        { bucket: 'raw', key: 'incoming/message' },
        dependencies,
      )
    ).result,
    {
      status: 'REJECTED',
      submissionId: 'id',
      rejectionCodes: ['NO_PROCESSABLE_SCREENSHOTS'],
    },
  );
  assert.ok(
    jsonWrites.some(
      (write) =>
        write.key.endsWith('/completion.json') &&
        write.value.status === 'REJECTED' &&
        (write.value.rejectionCodes as string[]).join() ===
          'NO_PROCESSABLE_SCREENSHOTS',
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
  process.env.SENDER_ALLOWLIST_PARAMETER = ALLOWLIST_PARAMETER;
  const jsonWrites: Array<{ key: string; value: any }> = [];
  const dependencies: ProcessEmailDependencies = {
    async getRawEmail() {
      return Buffer.from('mime');
    },
    async parseEmail() {
      return {
        fromAddresses: [LISTED_SENDER],
        text: MATCH_DATE,
        attachments: [
          { contentType: 'image/png', content: Buffer.from('image') },
        ],
      };
    },
    async getSenderAllowlist() {
      return [LISTED_SENDER];
    },
    async getParameter() {
      throw new Error('not called');
    },
    async inspectImage() {
      return { format: 'png', width: 1920, height: 1080 };
    },
    async sendEmail() {
      throw new Error('not called');
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
    publishStageEvent: recordStageEvent,
    now: clock(),
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

test('processEmail throws and records a failure when it cannot record a rejection', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  const jsonWrites: Array<{ key: string; value: any }> = [];
  const dependencies: ProcessEmailDependencies = {
    async getRawEmail() {
      return Buffer.from('mime');
    },
    async parseEmail() {
      return { text: MATCH_DATE, attachments: [] };
    },
    async getSenderAllowlist() {
      throw new Error('not called');
    },
    async getParameter() {
      throw new Error('not called');
    },
    async inspectImage() {
      throw new Error('not called');
    },
    async sendEmail() {
      throw new Error('not called');
    },
    async putObject() {
      throw new Error('not called');
    },
    async writeJson(bucket, key, value) {
      if ((value as { type?: string }).type === 'SUBMISSION_REJECTED') {
        throw new Error('event write failed');
      }
      jsonWrites.push({ key, value });
      return { bucket, key };
    },
    id: () => 'id',
    timestamp: () => '2026-01-01T00:00:00.000Z',
    publishStageEvent: recordStageEvent,
    now: clock(),
  };

  await assert.rejects(
    processEmail({ bucket: 'raw', key: 'incoming/message' }, dependencies),
    { message: 'event write failed' },
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

test('the match date is the first valid M/D/YYYY calendar date in reading order', () => {
  for (const [body, expected] of [
    ['5/2/2026', '2026-05-02'],
    ['05/02/2026', '2026-05-02'],
    ['12/31/2026', '2026-12-31'],
    ['1/1/0999', '0999-01-01'],
    [' \r\n\t10/17/2026 \r\n', '2026-10-17'],
    ['2/29/2024', '2024-02-29'],
    ['2/29/2000', '2000-02-29'],
    ['Match date: (10/18/2026).\n--\nExample signature', '2026-10-18'],
    ['1/1/2026 thanks', '2026-01-01'],
    ['12/31/2026\n1/2/2026', '2026-12-31'],
    ['13/1/2026, 2/30/2026, 2/29/1900, 2/29/2000', '2000-02-29'],
    ['001/1/2026 1/001/2026 1/1/20266 then 5/2/2026', '2026-05-02'],
    ['1/1/26 then 05/02/2026', '2026-05-02'],
  ] as const) {
    assert.equal(parseMatchDate(body), expected, body);
  }
  for (const body of [
    undefined,
    '',
    '  \r\n ',
    'scores from tonight',
    '13/1/2026',
    '0/1/2026',
    '1/0/2026',
    '1/32/2026',
    '4/31/2026',
    '2/30/2026',
    '2/29/2026',
    '2/29/1900',
    '1/1/26',
    '1/1/20266',
    '001/1/2026',
    '1/001/2026',
    '11/111/2026',
    '1/1/2026/2',
    '1/1/1/2026',
    '2026-01-01',
    '1-1-2026',
    '13/1/2026 and 2/29/1900',
  ]) {
    assert.equal(parseMatchDate(body), undefined, JSON.stringify(body));
  }
});

const listedSender = {
  headerLines: sesHeaders('PASS', 'PASS'),
  fromAddresses: ['player@example.test'],
  allowlistParameter: '/mcc/dev/match-to-csv/sender-allowlist',
  allowlist: ['player@example.test'],
  messageId: '<original-id@example.test>',
  subject: 'Tonight',
};

for (const [label, text] of [
  ['an empty body', ''],
  ['no plain-text body', undefined],
  ['text', 'scores from tonight'],
  ['month 13', '13/1/2026'],
  ['February 30', '2/30/2026'],
  ['a two-digit year', '1/1/26'],
  [
    'only invalid dates among text',
    'Dates: 13/1/2026, 2/30/2026.\nExample signature',
  ],
  ['a longer numeric date token', 'Date: 001/1/2026'],
] as const) {
  test(`processEmail rejects ${label} as MATCH_DATE_INVALID before storing any screenshot and replies`, async () => {
    const run = await runScreening({ ...listedSender, text });

    assertRejected(run, ['MATCH_DATE_INVALID']);
    assert.equal(run.accepted, undefined, 'no screenshot reaches the Map');
    assert.deepEqual(run.objectWrites, [], 'no screenshot is stored');
    assert.equal(run.inspections(), 0, 'no attachment is inspected');
    assert.equal(run.ingestion.matchDate, null);
    assert.equal(run.completion.status, 'REJECTED');
    assert.deepEqual(run.completion.rejectionCodes, ['MATCH_DATE_INVALID']);
    assert.equal(run.completion.acceptedScreenshotCount, 0);
    assert.equal(run.event.type, 'SUBMISSION_REJECTED');
    assert.deepEqual(run.event.detail.rejectionCodes, ['MATCH_DATE_INVALID']);
    assert.equal(run.sends.length, 1);
    assert.equal(run.matchDateReply, 'SENT');
    const [reply] = run.sends;
    assert.equal(reply.from, 'noreply@mail.example.test');
    assert.deepEqual(reply.to, ['player@example.test']);
    assert.equal(reply.subject, 'Re: Tonight');
    assert.deepEqual(reply.headers, [
      { name: 'In-Reply-To', value: '<original-id@example.test>' },
      { name: 'References', value: '<original-id@example.test>' },
    ]);
    assert.match(reply.body, /not processed/);
    assert.match(
      reply.body,
      /no valid match date was found in its plain-text body/,
    );
    assert.match(reply.body, /Include the date as M\/D\/YYYY/);
    assert.match(reply.body, /first valid date in the body is used/);
    assert.match(reply.body, /Surrounding text and signatures are allowed/);
    assert.match(reply.body, /send it again to the submission address/);
    assert.match(reply.body, /Replies to this no-reply address are not read/);
  });
}

/** A MIME message from the listed sender whose content starts with `content`. */
function mimeMessage(content: string[]): string {
  return [
    'From: Player <player@example.test>',
    'To: submissions@example.test',
    'Subject: Tonight',
    'Message-ID: <original-id@example.test>',
    'MIME-Version: 1.0',
    ...content,
    '',
  ].join('\r\n');
}

/** A multipart/mixed MIME message with these body parts and one PNG attachment. */
function mimeWithScreenshot(parts: string[][]): string {
  return mimeMessage([
    'Content-Type: multipart/mixed; boundary="mixed"',
    '',
    ...parts.flatMap((part) => ['--mixed', ...part]),
    '--mixed',
    'Content-Type: image/png; name="scoreboard.png"',
    'Content-Disposition: attachment; filename="scoreboard.png"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('png').toString('base64'),
    '--mixed--',
  ]);
}

const htmlPart = [
  'Content-Type: text/html; charset=utf-8',
  '',
  `<p>${MATCH_DATE}</p>`,
];
const plainPart = (body: string) => [
  'Content-Type: text/plain; charset=utf-8',
  '',
  body,
];

for (const [label, body, expected] of [
  [
    'a signature after the date',
    '10/18/2026\r\n--\r\nExample signature',
    '2026-10-18',
  ],
  ['surrounding text', 'Screenshots for (05/02/2026). Thanks!', '2026-05-02'],
  ['multiple valid dates', '12/31/2026\r\n1/2/2026', '2026-12-31'],
  [
    'invalid dates before a valid date',
    '13/1/2026, 2/29/1900, then 2/29/2000',
    '2000-02-29',
  ],
  [
    'numeric tokens before a valid date',
    '001/1/2026 1/1/20266 then 5/2/2026',
    '2026-05-02',
  ],
] as const) {
  test(`processEmail accepts ${label} parsed from MIME and records the first valid date`, async () => {
    const run = await runScreening({
      ...listedSender,
      rawEmail: mimeWithScreenshot([plainPart(body)]),
    });

    assert.equal(run.error, undefined);
    assert.equal(run.accepted?.matchDate, expected);
    assert.equal(run.ingestion.matchDate, expected);
    assert.equal(run.accepted?.screenshots.length, 1);
    assert.equal(run.objectWrites.length, 1);
    assert.equal(run.completion.status, 'SUCCEEDED');
    assert.deepEqual(run.completion.rejectionCodes, []);
    assert.equal(run.event.type, 'SUBMISSION_ACCEPTED');
    assert.deepEqual(run.sends, []);
  });
}

// By default MailParser converts HTML to text when the HTML is the whole
// message or sits beside a text/plain part, so the first and last bodies would
// read as a valid date without skipHtmlToText.
for (const [label, rawEmail] of [
  ['an HTML-only message', mimeMessage(htmlPart)],
  ['an HTML part with a screenshot', mimeWithScreenshot([htmlPart])],
  [
    'an HTML part beside an empty text/plain part',
    mimeWithScreenshot([plainPart(''), htmlPart]),
  ],
] as const) {
  test(`processEmail rejects ${label} parsed from MIME as MATCH_DATE_INVALID and replies`, async () => {
    const run = await runScreening({ ...listedSender, rawEmail });

    assertRejected(run, ['MATCH_DATE_INVALID']);
    assert.equal(run.ingestion.matchDate, null);
    assert.deepEqual(run.completion.rejectionCodes, ['MATCH_DATE_INVALID']);
    assert.deepEqual(run.objectWrites, []);
    assert.equal(run.sends.length, 1);
    assert.equal(run.matchDateReply, 'SENT');
    assert.deepEqual(run.sends[0].to, ['player@example.test']);
    assert.equal(run.sends[0].subject, 'Re: Tonight');
  });
}

test('processEmail accepts the text/plain date of a multipart/alternative body parsed from MIME', async () => {
  const run = await runScreening({
    ...listedSender,
    rawEmail: mimeWithScreenshot([
      [
        'Content-Type: multipart/alternative; boundary="alternative"',
        '',
        '--alternative',
        ...plainPart(MATCH_DATE),
        '--alternative',
        ...htmlPart,
        '--alternative--',
      ],
    ]),
  });

  assert.equal(run.error, undefined);
  assert.equal(run.accepted?.matchDate, '2026-05-02');
  assert.equal(run.ingestion.matchDate, '2026-05-02');
  assert.equal(run.accepted?.screenshots.length, 1);
  assert.deepEqual(run.sends, []);
});

for (const [label, options, codes] of [
  [
    'a failed spam verdict',
    { headerLines: sesHeaders('FAIL', 'PASS') },
    ['SPAM_VERDICT_FAILED'],
  ],
  [
    'a failed virus verdict',
    { headerLines: sesHeaders('PASS', 'FAIL') },
    ['VIRUS_VERDICT_FAILED'],
  ],
  [
    'an unlisted sender',
    { fromAddresses: ['stranger@example.test'] },
    ['SENDER_NOT_ALLOWED'],
  ],
  [
    'a failed recipient check',
    {
      headerLines: [
        sesReceived('example-alias+bob@mail.example.com'),
        ...sesHeaders('PASS', 'PASS'),
      ],
      ephemeral: current,
    },
    ['RECIPIENT_NOT_ALLOWED'],
  ],
] as Array<[string, ScreeningCase, SubmissionRejectionCode[]]>) {
  test(`processEmail sends no reply for ${label}, even without a match date`, async () => {
    const run = await runScreening({ ...listedSender, ...options, text: '' });

    assertRejected(run, codes);
    assert.deepEqual(run.completion.rejectionCodes, codes);
    assert.deepEqual(run.objectWrites, []);
    assert.deepEqual(run.sends, []);
    assert.equal(
      run.matchDateReply,
      undefined,
      'no reply result without MATCH_DATE_INVALID',
    );
  });

  test(`processEmail preserves ${label} with a valid date among surrounding text`, async () => {
    const run = await runScreening({
      ...listedSender,
      ...options,
      text: 'Match date: 10/18/2026\n--\nExample signature',
    });

    assertRejected(run, codes);
    assert.equal(run.accepted, undefined);
    assert.equal(run.ingestion.matchDate, '2026-10-18');
    assert.equal(run.completion.status, 'REJECTED');
    assert.deepEqual(run.completion.rejectionCodes, codes);
    assert.equal(run.event.type, 'SUBMISSION_REJECTED');
    assert.deepEqual(run.event.detail.rejectionCodes, codes);
    assert.deepEqual(run.objectWrites, []);
    assert.equal(run.inspections(), 0);
    assert.deepEqual(run.sends, []);
  });
}

test('processEmail sends no reply when no attachment is processable', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  process.env.SENDER_ALLOWLIST_PARAMETER = ALLOWLIST_PARAMETER;
  process.env.REPLY_FROM_DOMAIN = REPLY_DOMAIN;
  const sends: ReplyMessage[] = [];
  const jsonWrites: Array<{ key: string; value: any }> = [];
  const { result } = await processEmail(
    { bucket: 'raw', key: 'incoming/message' },
    {
      async getRawEmail() {
        return Buffer.from('mime');
      },
      async parseEmail() {
        return {
          fromAddresses: [LISTED_SENDER],
          text: MATCH_DATE,
          attachments: [],
        };
      },
      async getSenderAllowlist() {
        return [LISTED_SENDER];
      },
      async getParameter() {
        throw new Error('not called');
      },
      async inspectImage() {
        throw new Error('not called');
      },
      async sendEmail(message) {
        sends.push(message);
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
      publishStageEvent: recordStageEvent,
      now: clock(),
    },
  );
  assert.deepEqual(result, {
    status: 'REJECTED',
    submissionId: 'id',
    rejectionCodes: ['NO_PROCESSABLE_SCREENSHOTS'],
  });
  assert.equal(
    jsonWrites.find((write) => write.key.endsWith('/ingestion.json'))?.value
      .matchDate,
    '2026-05-02',
  );
  assert.deepEqual(sends, []);
});

test('processEmail logs a failed reply without an address or email content and keeps the rejection', async () => {
  const sendError = Object.assign(
    new Error('Email address is not verified: player@example.test, Tonight'),
    { name: 'MessageRejected' },
  );
  const run = await runScreening({ ...listedSender, text: '', sendError });

  assertRejected(run, ['MATCH_DATE_INVALID']);
  assert.equal(run.matchDateReply, 'FAILED');
  assert.equal(run.sends.length, 1, 'the send was attempted');
  assert.equal(run.completion.status, 'REJECTED');
  assert.deepEqual(run.completion.rejectionCodes, ['MATCH_DATE_INVALID']);
  assert.equal(run.event.type, 'SUBMISSION_REJECTED');
  const failure = run.logs.find(
    (line) => line.message === 'Unable to send the match date reply',
  );
  assert.ok(failure, 'the failed send is logged');
  assert.equal(failure.level, 'ERROR');
  assert.equal(failure.error, 'MessageRejected');
  const logged = JSON.stringify(run.logs);
  for (const fragment of ['@example.test', 'Tonight', 'original-id']) {
    assert.ok(!logged.includes(fragment), `logs omit ${fragment}`);
  }
});

for (const [label, options] of [
  ['no allowlist parameter name', { allowlistParameter: undefined }],
  ['a missing allowlist parameter', { allowlist: undefined }],
  ['an allowlist with no addresses', { allowlist: [] }],
] as Array<[string, ScreeningCase]>) {
  test(`processEmail sends no reply for ${label}, even without a match date`, async () => {
    const run = await runScreening({ ...listedSender, ...options, text: '' });

    assert.equal(run.ingestion.senderAllowlist.status, 'NOT_CONFIGURED');
    assert.equal(run.ingestion.matchDate, null);
    assert.deepEqual(run.completion.rejectionCodes, ['SENDER_NOT_ALLOWED']);
    assert.equal(run.matchDateReply, undefined);
    assert.deepEqual(run.objectWrites, []);
    assert.deepEqual(run.sends, []);
  });
}

test('processEmail sends no reply without a reply domain', async () => {
  const run = await runScreening({
    ...listedSender,
    replyDomain: undefined,
    text: '',
  });

  assertRejected(run, ['MATCH_DATE_INVALID']);
  assert.equal(run.matchDateReply, 'SKIPPED');
  assert.deepEqual(run.completion.rejectionCodes, ['MATCH_DATE_INVALID']);
  assert.equal(run.event.type, 'SUBMISSION_REJECTED');
  assert.deepEqual(run.sends, []);
  assert.ok(
    run.logs.some(
      (line) =>
        line.level === 'ERROR' &&
        line.message ===
          'Match date reply not sent: REPLY_FROM_DOMAIN is not set',
    ),
  );
});

test('the match date reply threads only under a well-formed message ID', () => {
  const to = ['player@example.test'];
  assert.deepEqual(
    matchDateReply(
      { messageId: '<a.b+c@example.test>', subject: 'Line one\r\n line two' },
      to,
      REPLY_DOMAIN,
    ),
    {
      from: 'noreply@mail.example.test',
      to,
      subject: 'Re: Line one  line two',
      body: matchDateReply({}, to, REPLY_DOMAIN).body,
      headers: [
        { name: 'In-Reply-To', value: '<a.b+c@example.test>' },
        { name: 'References', value: '<a.b+c@example.test>' },
      ],
    },
  );
  for (const messageId of [
    undefined,
    'no-brackets@example.test',
    '<two@example.test> <ids@example.test>',
    '<bad\r\nInjected: header>',
    `<${'x'.repeat(870)}>`,
  ]) {
    assert.deepEqual(
      matchDateReply({ messageId }, to, REPLY_DOMAIN).headers,
      [],
      JSON.stringify(messageId),
    );
  }
  assert.equal(matchDateReply({}, to, REPLY_DOMAIN).subject, 'Re:');
});

/** Dependencies for a listed sender's email with these attachments. */
function attachmentDependencies(
  attachments: Array<{ filename: string; contentType: string; body: string }>,
  inspections: Record<
    string,
    { format: string; width: number; height: number }
  >,
): ProcessEmailDependencies {
  let id = 0;
  return {
    async getRawEmail() {
      return Buffer.from('mime');
    },
    async parseEmail() {
      return {
        messageId: '<original-id@example.test>',
        subject: 'Tonight',
        headerLines: sesHeaders('PASS', 'PASS'),
        fromAddresses: [LISTED_SENDER],
        text: MATCH_DATE,
        attachments: attachments.map(({ filename, contentType, body }) => ({
          filename,
          contentType,
          content: Buffer.from(body),
        })),
      };
    },
    async getSenderAllowlist() {
      return [LISTED_SENDER];
    },
    async getParameter() {
      throw new Error('not called');
    },
    async inspectImage(content) {
      return (
        inspections[content.toString()] ?? {
          format: 'png',
          width: 1920,
          height: 1080,
        }
      );
    },
    async sendEmail() {},
    async putObject() {},
    async writeJson(bucket, key) {
      return { bucket, key };
    },
    id: () => `id-${++id}`,
    timestamp: () => '2026-01-01T00:00:00.000Z',
    publishStageEvent: recordStageEvent,
    now: clock(),
  };
}

test('an accepted submission writes one OK stage event', async () => {
  const run = await runScreening({
    ...listedSender,
    input: { receivedAt: RECEIVED_AT, trace },
    screenshotCount: 2,
  });

  assert.equal(run.result?.status, 'ACCEPTED');
  assert.deepEqual(run.stageEvents, [
    {
      stage: 'process-email',
      outcome: 'OK',
      durationMs: 250,
      requestId: 'request-1',
      ids: { submissionId: run.ingestion.submissionId as string },
      trace,
      properties: {
        attachmentCount: 2,
        rejectedAttachmentCount: 0,
        screenshotCount: 2,
      },
      metrics: { SubmissionsAccepted: 1, ScreenshotsAccepted: 2 },
      breakdowns: { attachmentRejectionReasons: {} },
    },
  ]);
});

test('an accepted submission counts every code of its rejected attachments', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  process.env.SENDER_ALLOWLIST_PARAMETER = ALLOWLIST_PARAMETER;
  const { result } = await processEmail(
    { bucket: 'raw', key: 'incoming/message' },
    attachmentDependencies(
      [
        { filename: 'scoreboard.png', contentType: 'image/png', body: 'png' },
        { filename: 'notes.txt', contentType: 'text/plain', body: 'text' },
        { filename: 'photo.webp', contentType: 'image/webp', body: 'webp' },
        { filename: 'logo.jpg', contentType: 'image/jpeg', body: 'small' },
      ],
      {
        webp: { format: 'webp', width: 200, height: 100 },
        small: { format: 'jpeg', width: 200, height: 100 },
      },
    ),
  );

  assert.equal(result.status, 'ACCEPTED');
  assert.equal(stageEvents.length, 1);
  const [stageEvent] = stageEvents;
  assert.equal(stageEvent.outcome, 'OK');
  assert.deepEqual(stageEvent.properties, {
    attachmentCount: 4,
    rejectedAttachmentCount: 3,
    screenshotCount: 1,
  });
  assert.deepEqual(stageEvent.breakdowns, {
    attachmentRejectionReasons: {
      NOT_AN_IMAGE: 1,
      UNSUPPORTED_IMAGE_FORMAT: 1,
      IMAGE_TOO_SMALL: 2,
    },
  });

  const lines: string[] = [];
  publishStageEvent(stageEvent, (line) => lines.push(line), {}, 0);
  const records = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  assert.equal(
    records[0].attachmentRejectionCodes,
    'IMAGE_TOO_SMALL,NOT_AN_IMAGE,UNSUPPORTED_IMAGE_FORMAT',
  );
  assert.deepEqual(
    records
      .slice(1)
      .map((record) => [record.Reason, record.AttachmentsRejected]),
    [
      ['IMAGE_TOO_SMALL', 2],
      ['NOT_AN_IMAGE', 1],
      ['UNSUPPORTED_IMAGE_FORMAT', 1],
    ],
  );
});

test('a rejected submission writes one REJECTED event with every rejection code', async () => {
  const run = await runScreening({
    headerLines: sesHeaders('FAIL', 'PASS'),
    fromAddresses: ['stranger@example.test'],
    input: { trace },
  });

  assertRejected(run, ['SPAM_VERDICT_FAILED', 'SENDER_NOT_ALLOWED']);
  assert.deepEqual(run.stageEvents, [
    {
      stage: 'process-email',
      outcome: 'REJECTED',
      durationMs: 250,
      requestId: 'request-1',
      ids: { submissionId: run.ingestion.submissionId as string },
      trace,
      properties: { attachmentCount: 1, rejectedAttachmentCount: 0 },
      metrics: { SubmissionsRejected: 1 },
      breakdowns: {
        submissionRejectionReasons: [
          'SPAM_VERDICT_FAILED',
          'SENDER_NOT_ALLOWED',
        ],
        attachmentRejectionReasons: {},
      },
    },
  ]);

  const lines: string[] = [];
  publishStageEvent(run.stageEvents[0], (line) => lines.push(line), {}, 0);
  const records = lines.map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
  assert.equal(
    records[0].rejectionCodes,
    'SENDER_NOT_ALLOWED,SPAM_VERDICT_FAILED',
  );
  assert.deepEqual(
    records
      .slice(1)
      .map((record) => [record.Reason, record.SubmissionsRejected]),
    [
      ['SENDER_NOT_ALLOWED', 1],
      ['SPAM_VERDICT_FAILED', 1],
    ],
  );
});

test('a submission without a processable screenshot counts its attachment rejections', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  process.env.SENDER_ALLOWLIST_PARAMETER = ALLOWLIST_PARAMETER;
  const { result } = await processEmail(
    { bucket: 'raw', key: 'incoming/message' },
    attachmentDependencies(
      [{ filename: 'notes.txt', contentType: 'text/plain', body: 'text' }],
      {},
    ),
  );

  assert.equal(result.status, 'REJECTED');
  assert.equal(stageEvents.length, 1);
  assert.equal(stageEvents[0].outcome, 'REJECTED');
  assert.deepEqual(stageEvents[0].breakdowns, {
    submissionRejectionReasons: ['NO_PROCESSABLE_SCREENSHOTS'],
    attachmentRejectionReasons: { NOT_AN_IMAGE: 1 },
  });
});

for (const [label, options, matchDateReply, metrics] of [
  ['sent', {}, 'SENT', { SubmissionsRejected: 1 }],
  [
    'failed',
    { sendError: Object.assign(new Error('no'), { name: 'MessageRejected' }) },
    'FAILED',
    { SubmissionsRejected: 1, MatchDateReplyFailed: 1 },
  ],
  [
    'skipped',
    { replyDomain: undefined },
    'SKIPPED',
    { SubmissionsRejected: 1 },
  ],
] as Array<[string, ScreeningCase, string, Record<string, number>]>) {
  test(`the REJECTED event records a ${label} match date reply`, async () => {
    const run = await runScreening({ ...listedSender, ...options, text: '' });

    assert.equal(run.matchDateReply, matchDateReply);
    assert.equal(run.stageEvents.length, 1);
    assert.equal(run.stageEvents[0].outcome, 'REJECTED');
    assert.equal(run.stageEvents[0].properties.matchDateReply, matchDateReply);
    assert.deepEqual(run.stageEvents[0].metrics, metrics);
  });
}

test('an event without a match date reply leaves matchDateReply out', async () => {
  const run = await runScreening({
    ...listedSender,
    fromAddresses: ['stranger@example.test'],
    text: '',
  });

  assert.equal(run.stageEvents.length, 1);
  assert.ok(!('matchDateReply' in run.stageEvents[0].properties));
  assert.ok(!('MatchDateReplyFailed' in run.stageEvents[0].metrics));
});

for (const [label, override, errorName] of [
  [
    'the raw email read',
    {
      async getRawEmail() {
        throw Object.assign(new Error('gone'), { name: 'NoSuchKey' });
      },
    },
    'NoSuchKey',
  ],
  [
    'the MIME parse',
    {
      async parseEmail() {
        throw new TypeError('bad MIME');
      },
    },
    'TypeError',
  ],
  [
    'the SSM read',
    {
      async getSenderAllowlist() {
        throw Object.assign(new Error('denied'), {
          name: 'AccessDeniedException',
        });
      },
    },
    'AccessDeniedException',
  ],
] as Array<[string, Partial<ProcessEmailDependencies>, string]>) {
  test(`a failure in ${label} writes an ERROR event without a submission ID`, async () => {
    process.env.EVIDENCE_BUCKET = 'evidence-bucket';
    process.env.SENDER_ALLOWLIST_PARAMETER = ALLOWLIST_PARAMETER;
    await assert.rejects(
      processEmail(
        { bucket: 'raw', key: 'incoming/message', trace },
        { ...attachmentDependencies([], {}), ...override },
        'request-1',
      ),
      (error: Error) => {
        // The event is already written when the error reaches the caller.
        assert.equal(stageEvents.length, 1);
        return error.name === errorName;
      },
    );

    assert.deepEqual(stageEvents, [
      {
        stage: 'process-email',
        outcome: 'ERROR',
        durationMs: 250,
        ids: { submissionId: undefined },
        trace,
        requestId: 'request-1',
        errorName,
        properties: {
          ...(label === 'the SSM read' ? { attachmentCount: 0 } : {}),
          rejectedAttachmentCount: 0,
        },
        metrics: {},
      },
    ]);
    const lines: string[] = [];
    publishStageEvent(stageEvents[0], (line) => lines.push(line), {}, 0);
    const record = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(record.executionId, trace.executionId);
    assert.ok(!('submissionId' in record));
  });
}

test('a failure after the submission ID exists writes an ERROR event with it', async () => {
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  process.env.SENDER_ALLOWLIST_PARAMETER = ALLOWLIST_PARAMETER;
  await assert.rejects(
    processEmail(
      { bucket: 'raw', key: 'incoming/message' },
      {
        ...attachmentDependencies(
          [{ filename: 'scoreboard.png', contentType: 'image/png', body: 'p' }],
          {},
        ),
        async putObject() {
          throw Object.assign(new Error('denied'), { name: 'AccessDenied' });
        },
      },
    ),
    { name: 'AccessDenied' },
  );

  assert.equal(stageEvents.length, 1);
  assert.equal(stageEvents[0].outcome, 'ERROR');
  assert.equal(stageEvents[0].errorName, 'AccessDenied');
  assert.deepEqual(stageEvents[0].ids, { submissionId: 'id-1' });
  assert.equal(stageEvents[0].breakdowns, undefined);
});

test('a publisher failure is logged and never fails processEmail', async () => {
  const publisher = (): void => {
    throw new TypeError('cannot write');
  };
  process.env.EVIDENCE_BUCKET = 'evidence-bucket';
  process.env.SENDER_ALLOWLIST_PARAMETER = ALLOWLIST_PARAMETER;
  const captured = captureLogLines();
  try {
    const { result } = await processEmail(
      { bucket: 'raw', key: 'incoming/message' },
      {
        ...attachmentDependencies(
          [{ filename: 'scoreboard.png', contentType: 'image/png', body: 'p' }],
          {},
        ),
        publishStageEvent: publisher,
      },
    );
    assert.equal(result.status, 'ACCEPTED');
    await assert.rejects(
      processEmail(
        { bucket: 'raw', key: 'incoming/message' },
        {
          ...attachmentDependencies([], {}),
          async getRawEmail() {
            throw Object.assign(new Error('gone'), { name: 'NoSuchKey' });
          },
          publishStageEvent: publisher,
        },
      ),
      { name: 'NoSuchKey' },
    );
  } finally {
    captured.restore();
  }

  const errors = captured.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record.message === 'Stage event not written');
  assert.equal(errors.length, 2);
  for (const record of errors) {
    assert.equal(record.stage, 'process-email');
    assert.equal(record.errorName, 'TypeError');
  }
});

test('published process-email events hold no subject, address or body', async () => {
  for (const environment of [{}, { EMF_METRICS_ENABLED: 'false' }]) {
    const lines: string[] = [];
    process.env.EVIDENCE_BUCKET = 'evidence-bucket';
    process.env.SENDER_ALLOWLIST_PARAMETER = ALLOWLIST_PARAMETER;
    await processEmail(
      { bucket: 'raw', key: 'incoming/message', trace },
      {
        ...attachmentDependencies(
          [
            { filename: 'scoreboard.png', contentType: 'image/png', body: 'p' },
            { filename: 'notes.txt', contentType: 'text/plain', body: 't' },
          ],
          {},
        ),
        publishStageEvent(stageEvent) {
          publishStageEvent(
            stageEvent,
            (line) => lines.push(line),
            environment,
            0,
          );
        },
      },
    );

    const records = lines.map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    assert.equal(records[0].Stage, 'process-email');
    if (environment.EMF_METRICS_ENABLED === 'false') {
      assert.equal(records.length, 1, 'no breakdown records');
      assert.ok(!('_aws' in records[0]));
    } else {
      assert.equal(records[0].SubmissionsAccepted, 1);
      assert.equal(records[0].ScreenshotsAccepted, 1);
      assert.equal(records.length, 2);
      assert.equal(records[1].AttachmentsRejected, 1);
    }
    const visible = lines.join('');
    for (const fragment of [
      '@example.test',
      'Tonight',
      'original-id',
      MATCH_DATE,
      'notes.txt',
      'scoreboard.png',
    ]) {
      assert.ok(!visible.includes(fragment), fragment);
    }
  }
});
