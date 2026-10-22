import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { CsvEmailDelivery, EmailGamertagCsvsInput } from '@mcc/contracts';
import { RecipientsIntegrityError } from '@mcc/recipients';
import {
  csvEmail,
  emailGamertagCsvs,
  type CsvEmail,
  type EmailGamertagCsvsDependencies,
} from '../src/lambdas/email-gamertag-csvs';
import type { LoadedRecipients } from '../src/lib/recipient-source';
import { captureLogLines, withoutTimestamp } from './support/log-lines';

const bucket = 'evidence';
const exportPrefix = 'submissions/submission-1/export/gamertags/';
const recordKey = 'submissions/submission-1/export/csv-email.json';
const files: Record<string, string> = {
  'Player01.csv': '3/7/2026,12,3,4,1,\n3/7/2026,9,4,7,,1\n',
  'Player_02.csv': '3/7/2026,8,5,6,1,\n',
};
const gamertags = ['Player01', 'Player 02', 'Player_02'];
const addresses = ['person1@example.test', 'person2@example.test'];

const event: EmailGamertagCsvsInput = {
  submissionId: 'submission-1',
  matchDate: '2026-03-07',
  screenshotCount: 2,
  gamertagCsvs: {
    submissionId: 'submission-1',
    prefix: exportPrefix,
    fileCount: 2,
    rowCount: 3,
  },
  trace: {
    executionId:
      'arn:aws:states:us-east-1:000000000000:execution:match-to-csv-dev:example',
    retryCount: 0,
    workflow: 'INGEST',
  },
};

const configuration = { bucket, fromDomain: 'mail.example.test' };

const recipients: LoadedRecipients = {
  recipientsVersion: 3,
  recipientsSha256: 'a'.repeat(64),
  entries: addresses.map((address, index) => ({
    recipientId: `00000000-0000-4000-8000-00000000000${index + 1}`,
    address,
  })),
};

interface Harness {
  dependencies: EmailGamertagCsvsDependencies;
  objects: Map<string, string>;
  sent: CsvEmail[];
  calls: string[];
}

function harness(
  overrides: Partial<EmailGamertagCsvsDependencies> = {},
  stored: Record<string, string> = files,
  list: LoadedRecipients = recipients,
): Harness {
  const objects = new Map(
    Object.entries(stored).map(([name, body]) => [
      `${exportPrefix}${name}`,
      body,
    ]),
  );
  const sent: CsvEmail[] = [];
  const calls: string[] = [];
  return {
    objects,
    sent,
    calls,
    dependencies: {
      async listKeys(listBucket, prefix) {
        assert.equal(listBucket, bucket);
        calls.push(`list ${prefix}`);
        return [...objects.keys()].filter((key) => key.startsWith(prefix));
      },
      async getObject(getBucket, key) {
        assert.equal(getBucket, bucket);
        calls.push(`get ${key}`);
        const body = objects.get(key);
        if (body === undefined) throw new Error('missing');
        return Buffer.from(body);
      },
      async putIfAbsent(putBucket, key, body) {
        assert.equal(putBucket, bucket);
        calls.push(`put ${key}`);
        if (objects.has(key)) return 'EXISTS';
        objects.set(key, body);
        return 'CREATED';
      },
      async readRecipients() {
        calls.push('recipients');
        return list;
      },
      async sendEmail(email) {
        calls.push('send');
        sent.push(email);
        return 'ses-message-1';
      },
      now: () => '2026-03-08T00:00:00.000Z',
      ...overrides,
    },
  };
}

function record(objects: Map<string, string>): CsvEmailDelivery {
  return JSON.parse(objects.get(recordKey) ?? 'null') as CsvEmailDelivery;
}

/** The MIME parts of a raw email, split on its boundary. */
function parts(email: CsvEmail): { headers: string; parts: string[] } {
  const text = email.raw.toString('utf8');
  const boundary = /boundary="([^"]+)"/.exec(text)?.[1];
  assert.ok(boundary);
  const [headers, ...rest] = text.split(`--${boundary}`);
  assert.equal(rest.pop(), '--\r\n');
  return { headers, parts: rest };
}

let logLines: string[] = [];
let restoreStdout = () => {};
beforeEach(() => {
  ({ lines: logLines, restore: restoreStdout } = captureLogLines());
  delete process.env.OBJECT_PREFIX;
});
afterEach(() => {
  restoreStdout();
  delete process.env.OBJECT_PREFIX;
});

test('sends one email with every gamertag CSV to every recipient and records it', async () => {
  const { dependencies, objects, sent } = harness();
  const output = await emailGamertagCsvs(event, configuration, dependencies);

  assert.equal(sent.length, 1);
  const [email] = sent;
  assert.equal(email.from, 'noreply@mail.example.test');
  assert.deepEqual(email.to, addresses);
  const { headers, parts: mimeParts } = parts(email);
  assert.match(headers, /^From: noreply@mail\.example\.test\r\n/);
  assert.match(
    headers,
    /\r\nTo: person1@example\.test, person2@example\.test\r\n/,
  );
  assert.match(headers, /\r\nSubject: MCC match 3\/7\/2026: gamertag CSVs\r\n/);
  assert.match(headers, /\r\nContent-Type: multipart\/mixed; boundary=/);
  assert.equal(mimeParts.length, 3);
  assert.match(mimeParts[0], /Content-Type: text\/plain; charset=UTF-8/);
  assert.match(mimeParts[0], /2 files from 2 screenshots\./);
  assert.match(mimeParts[0], /the match on 3\/7\/2026/);
  for (const [index, name] of Object.keys(files).entries()) {
    const part = mimeParts[index + 1];
    assert.match(
      part,
      new RegExp(`Content-Type: text/csv; charset=UTF-8; name="${name}"`),
    );
    assert.match(
      part,
      new RegExp(`Content-Disposition: attachment; filename="${name}"`),
    );
    const content = part.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    assert.equal(Buffer.from(content, 'base64').toString('utf8'), files[name]);
  }

  assert.deepEqual(record(objects), {
    schemaVersion: 'csv-email-delivery/v1',
    submissionId: 'submission-1',
    status: 'SENT',
    sesMessageId: 'ses-message-1',
    recipientsVersion: 3,
    recipientCount: 2,
    screenshotCount: 2,
    attachments: ['Player01.csv', 'Player_02.csv'],
    recordedAt: '2026-03-08T00:00:00.000Z',
  });
  assert.deepEqual(output, {
    submissionId: 'submission-1',
    status: 'SENT',
    sesMessageId: 'ses-message-1',
    recipientsVersion: 3,
    recipientCount: 2,
    attachmentCount: 2,
    key: recordKey,
  });
  assert.deepEqual(
    logLines.map((line) =>
      withoutTimestamp(JSON.parse(line) as Record<string, unknown>),
    ),
    [{ level: 'INFO', message: 'Gamertag CSV email sent', ...output }],
  );
});

test('an empty recipient list sends nothing and records NOT_CONFIGURED', async () => {
  const { dependencies, objects, calls } = harness({}, files, {
    recipientsVersion: 2,
    recipientsSha256: 'b'.repeat(64),
    entries: [],
  });
  const output = await emailGamertagCsvs(event, configuration, dependencies);
  assert.ok(!calls.includes('send'));
  assert.ok(!calls.some((call) => call.startsWith(`get ${exportPrefix}`)));
  assert.equal(output.status, 'NOT_CONFIGURED');
  assert.deepEqual(record(objects), {
    schemaVersion: 'csv-email-delivery/v1',
    submissionId: 'submission-1',
    status: 'NOT_CONFIGURED',
    sesMessageId: null,
    recipientsVersion: 2,
    recipientCount: 0,
    screenshotCount: 2,
    attachments: ['Player01.csv', 'Player_02.csv'],
    recordedAt: '2026-03-08T00:00:00.000Z',
  });
  assert.equal(JSON.parse(logLines[0]).level, 'WARN');
});

test('a submission without a gamertag CSV sends nothing and records NO_FILES', async () => {
  const { dependencies, objects, calls } = harness({}, {});
  const output = await emailGamertagCsvs(
    {
      ...event,
      gamertagCsvs: { ...event.gamertagCsvs, fileCount: 0, rowCount: 0 },
    },
    configuration,
    dependencies,
  );
  assert.ok(!calls.includes('send'));
  assert.equal(output.status, 'NO_FILES');
  assert.equal(output.attachmentCount, 0);
  assert.equal(record(objects).status, 'NO_FILES');
  assert.equal(record(objects).sesMessageId, null);
  assert.deepEqual(record(objects).attachments, []);
});

test('a recipient list integrity failure fails before sending or recording', async () => {
  const { dependencies, objects, calls } = harness({
    async readRecipients() {
      throw new RecipientsIntegrityError(
        'The change log does not reproduce HEAD version 3',
      );
    },
  });
  await assert.rejects(emailGamertagCsvs(event, configuration, dependencies), {
    name: 'RecipientsIntegrityError',
  });
  assert.ok(!calls.includes('send'));
  assert.ok(!objects.has(recordKey));
});

test('fails unless every reported gamertag CSV exists', async () => {
  const { dependencies, calls } = harness({}, { 'Player01.csv': 'x\n' });
  await assert.rejects(emailGamertagCsvs(event, configuration, dependencies), {
    name: 'GamertagCsvsMissingError',
    message: 'Found 1 of 2 gamertag CSVs',
  });
  assert.ok(!calls.includes('send'));
});

test('a record that is not csv-email-delivery/v1 fails without quoting it', async () => {
  for (const body of [
    '{"attachments":["Player01.csv"',
    '{"schemaVersion":1}',
  ]) {
    const { dependencies, objects, sent } = harness();
    objects.set(recordKey, body);
    await assert.rejects(
      emailGamertagCsvs(event, configuration, dependencies),
      (error: Error) =>
        error.name === 'CsvEmailDeliveryMismatchError' &&
        !error.message.includes('Player'),
    );
    assert.equal(sent.length, 0);
  }
});

test('a retried step finds the record and sends nothing more', async () => {
  const first = harness();
  await emailGamertagCsvs(event, configuration, first.dependencies);
  const second = harness();
  second.objects.set(recordKey, first.objects.get(recordKey) ?? '');
  const output = await emailGamertagCsvs(
    event,
    configuration,
    second.dependencies,
  );
  assert.equal(second.sent.length, 0);
  assert.equal(output.sesMessageId, 'ses-message-1');
  assert.deepEqual(second.calls, [`list ${recordKey}`, `get ${recordKey}`]);
});

test('a record written by a concurrent attempt is returned instead', async () => {
  const other = harness();
  await emailGamertagCsvs(event, configuration, other.dependencies);
  const otherRecord = other.objects.get(recordKey) ?? '';
  // The other attempt's record appears between this attempt's check and its
  // write.
  const racing: Harness = harness({
    async putIfAbsent() {
      racing.objects.set(
        recordKey,
        otherRecord.replace('ses-message-1', 'ses-message-0'),
      );
      return 'EXISTS';
    },
  });
  const output = await emailGamertagCsvs(
    event,
    configuration,
    racing.dependencies,
  );
  assert.equal(output.sesMessageId, 'ses-message-0');
});

test('transient SES errors take names the retry policy matches; others keep theirs', async () => {
  const cases: [Error & { $fault?: string }, string][] = [
    [
      Object.assign(new Error('Rate exceeded for person1@example.test'), {
        name: 'TooManyRequestsException',
      }),
      'ThrottlingException',
    ],
    [
      Object.assign(new Error('person1@example.test'), {
        name: 'ServiceUnavailable',
        $fault: 'server',
      }),
      'InternalServerError',
    ],
    [
      Object.assign(
        new Error('Email address is not verified: person1@example.test'),
        { name: 'MessageRejected', $fault: 'client' },
      ),
      'MessageRejected',
    ],
  ];
  for (const [failure, name] of cases) {
    const { dependencies, objects } = harness({
      async sendEmail() {
        throw failure;
      },
    });
    await assert.rejects(
      emailGamertagCsvs(event, configuration, dependencies),
      (error: Error) => {
        assert.equal(error.name, name);
        assert.equal(
          error.message,
          `Sending the gamertag CSV email failed with ${failure.name}`,
        );
        return true;
      },
    );
    // The CSVs stay; no record is written for a failed send.
    assert.ok(!objects.has(recordKey));
    assert.equal(objects.size, 2);
  }
});

test('storage errors keep their name and leave out the key', async () => {
  const { dependencies } = harness({
    async getObject(_bucket, key) {
      const error = new Error(`Access denied for ${key}`);
      error.name = 'AccessDenied';
      throw error;
    },
  });
  // The record check lists first, so the first read is an attachment.
  await assert.rejects(emailGamertagCsvs(event, configuration, dependencies), {
    name: 'AccessDenied',
    message: 'Reading gamertag CSV 1 of 2 failed with AccessDenied',
  });
});

test('logs, output and errors never hold an address or a gamertag', async () => {
  const outputs: unknown[] = [];
  const errors: string[] = [];
  const cases: [
    Partial<EmailGamertagCsvsDependencies>,
    Record<string, string>,
    LoadedRecipients,
  ][] = [
    [{}, files, recipients],
    [{}, files, { ...recipients, entries: [] }],
    [{}, {}, recipients],
    [
      {
        async sendEmail() {
          throw Object.assign(new Error(addresses[0]), {
            name: 'MessageRejected',
          });
        },
      },
      files,
      recipients,
    ],
  ];
  for (const [overrides, stored, list] of cases) {
    const { dependencies } = harness(overrides, stored, list);
    const fileCount = Object.keys(stored).length;
    try {
      outputs.push(
        await emailGamertagCsvs(
          {
            ...event,
            gamertagCsvs: { ...event.gamertagCsvs, fileCount },
          },
          configuration,
          dependencies,
        ),
      );
    } catch (error) {
      errors.push(`${(error as Error).name} ${(error as Error).message}`);
    }
  }
  assert.equal(outputs.length, 3);
  assert.equal(errors.length, 1);
  const text = JSON.stringify({ outputs, errors, logLines });
  for (const secret of [...addresses, ...gamertags, '@']) {
    assert.ok(!text.includes(secret), secret);
  }
});

test('refuses input that is not this submission’s gamertag export', async () => {
  for (const input of [
    { ...event, submissionId: '../other' },
    { ...event, matchDate: '3/7/2026' },
    { ...event, screenshotCount: -1 },
    {
      ...event,
      gamertagCsvs: { ...event.gamertagCsvs, submissionId: 'submission-2' },
    },
    {
      ...event,
      gamertagCsvs: {
        ...event.gamertagCsvs,
        prefix: 'submissions/submission-2/export/gamertags/',
      },
    },
  ]) {
    const { dependencies, calls } = harness();
    await assert.rejects(
      emailGamertagCsvs(input, configuration, dependencies),
      {
        name: 'InvalidCsvEmailInputError',
      },
    );
    assert.deepEqual(calls, []);
  }
});

test('an ephemeral stack lists and records only under its namespace', async () => {
  process.env.OBJECT_PREFIX = 'ephemeral/test';
  const prefix = `ephemeral/test/${exportPrefix}`;
  const { dependencies, calls } = harness({}, {});
  await emailGamertagCsvs(
    {
      ...event,
      gamertagCsvs: { ...event.gamertagCsvs, prefix, fileCount: 0 },
    },
    configuration,
    dependencies,
  );
  assert.deepEqual(calls, [
    `list ephemeral/test/${recordKey}`,
    `list ${prefix}`,
    'recipients',
    `put ephemeral/test/${recordKey}`,
  ]);
});

test('the email counts one file and one screenshot in the singular', () => {
  const email = csvEmail({
    from: 'noreply@mail.example.test',
    to: [addresses[0]],
    submissionId: 'submission-1',
    matchDate: '2026-12-25',
    screenshotCount: 1,
    attachments: [{ fileName: 'Player01.csv', content: Buffer.from('x\n') }],
  });
  const text = email.raw.toString('utf8');
  assert.match(text, /Subject: MCC match 12\/25\/2026: gamertag CSVs/);
  assert.match(text, /1 file from 1 screenshot\./);
  assert.throws(
    () =>
      csvEmail({
        from: 'noreply@mail.example.test',
        to: [addresses[0]],
        submissionId: 'submission-1',
        matchDate: '2026-12-25',
        screenshotCount: 1,
        attachments: [{ fileName: 'a"b.csv', content: Buffer.from('x\n') }],
      }),
    { name: 'InvalidCsvEmailInputError' },
  );
});
