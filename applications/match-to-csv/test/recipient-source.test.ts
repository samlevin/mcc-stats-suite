import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import type { RecipientChange } from '@mcc/contracts';
import { RecipientsIntegrityError, recipientsSha256 } from '@mcc/recipients';
import {
  changeFromItem,
  changeSortKey,
  readRecipients,
  recipientsPartitionKey,
  type RecipientTable,
  type RecipientsHead,
} from '../src/lib/recipient-source';

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
];

function change(
  recipientsVersion: number,
  action: RecipientChange['action'],
  index: number,
): RecipientChange {
  return {
    recipientsVersion,
    action,
    recipientId: ids[index],
    address: `person${index + 1}@example.test`,
    reason: null,
    actorArn: 'arn:aws:sts::000000000000:assumed-role/admin/test',
    clientRequestId: '00000000-0000-4000-8000-0000000000ff',
    changedAt: '2026-10-01T00:00:00Z',
  };
}

const log = [
  change(1, 'ADD', 1),
  change(2, 'ADD', 0),
  change(3, 'ADD', 2),
  change(4, 'DEACTIVATE', 2),
];
const active = [
  { recipientId: ids[0], address: 'person1@example.test' },
  { recipientId: ids[1], address: 'person2@example.test' },
];

function table(
  head: RecipientsHead | undefined,
  changes: RecipientChange[],
  reads: string[] = [],
): RecipientTable {
  return {
    async readHead(partitionKey) {
      reads.push(`head ${partitionKey}`);
      return head;
    },
    async readChanges(partitionKey, throughVersion) {
      reads.push(`changes ${partitionKey} ${throughVersion}`);
      return changes.filter((item) => item.recipientsVersion <= throughVersion);
    },
  };
}

test('folds the namespace partition to its active entries and checks HEAD', async () => {
  const reads: string[] = [];
  const head = {
    recipientsVersion: 4,
    recipientsSha256: recipientsSha256(active),
  };
  const loaded = await readRecipients(
    table(head, log, reads),
    'ephemeral/test',
  );
  assert.deepEqual(loaded, {
    recipientsVersion: 4,
    recipientsSha256: head.recipientsSha256,
    entries: active,
  });
  assert.deepEqual(reads, [
    'head RECIPIENTS#ephemeral/test',
    'changes RECIPIENTS#ephemeral/test 4',
  ]);
});

test('a partition without HEAD is version 0 with no entries', async () => {
  const reads: string[] = [];
  const loaded = await readRecipients(table(undefined, log, reads), 'stable');
  assert.deepEqual(loaded, {
    recipientsVersion: 0,
    recipientsSha256: recipientsSha256([]),
    entries: [],
  });
  assert.deepEqual(reads, ['head RECIPIENTS#stable']);
});

test('a log that does not reproduce HEAD fails without naming an address', async () => {
  for (const [head, changes] of [
    [{ recipientsVersion: 4, recipientsSha256: 'f'.repeat(64) }, log],
    [
      { recipientsVersion: 4, recipientsSha256: recipientsSha256(active) },
      log.slice(0, 3),
    ],
  ] as const) {
    await assert.rejects(
      readRecipients(table(head, [...changes]), 'stable'),
      (error: Error) =>
        error instanceof RecipientsIntegrityError &&
        error.message === 'The change log does not reproduce HEAD version 4',
    );
  }
  await assert.rejects(
    readRecipients(
      table({ recipientsVersion: 2, recipientsSha256: 'x' }, [
        change(2, 'ADD', 0),
      ]),
      'stable',
    ),
    (error: Error) =>
      error instanceof RecipientsIntegrityError && !error.message.includes('@'),
  );
});

test('an active address that is not valid fails with its entry ID', async () => {
  const bad = { ...change(1, 'ADD', 0), address: 'a@b\r\nBcc: c@d' };
  const entries = [{ recipientId: bad.recipientId, address: bad.address }];
  await assert.rejects(
    readRecipients(
      table(
        { recipientsVersion: 1, recipientsSha256: recipientsSha256(entries) },
        [bad],
      ),
      'stable',
    ),
    {
      name: 'RecipientsIntegrityError',
      message: `Entry ${ids[0]} has an invalid address`,
    },
  );
});

test('refuses a namespace outside the stable and ephemeral forms', async () => {
  await assert.rejects(readRecipients(table(undefined, []), 'ROSTER#stable'), {
    name: 'RecipientsIntegrityError',
  });
});

test('reads change items as the recipient script writes them', () => {
  const item: Record<string, AttributeValue> = {
    pk: { S: recipientsPartitionKey('stable') },
    sk: { S: changeSortKey(7) },
    recipientsVersion: { N: '7' },
    action: { S: 'ADD' },
    recipientId: { S: ids[0] },
    address: { S: 'person1@example.test' },
    reason: { NULL: true },
    actorArn: { S: 'arn' },
    clientRequestId: { S: 'request' },
    changedAt: { S: '2026-10-01T00:00:00Z' },
  };
  assert.equal(changeSortKey(7), 'CHANGE#0000000007');
  assert.deepEqual(changeFromItem(item), {
    recipientsVersion: 7,
    action: 'ADD',
    recipientId: ids[0],
    address: 'person1@example.test',
    reason: null,
    actorArn: 'arn',
    clientRequestId: 'request',
    changedAt: '2026-10-01T00:00:00Z',
  });
  assert.equal(changeFromItem({ ...item, reason: { S: 'why' } }).reason, 'why');
  for (const broken of [
    { ...item, action: { S: 'REMOVE' } },
    { ...item, address: { N: '1' } },
    { ...item, recipientsVersion: { N: '-1' } },
  ]) {
    assert.throws(
      () => changeFromItem(broken),
      (error: Error) =>
        error instanceof RecipientsIntegrityError &&
        error.message.startsWith('Item CHANGE#0000000007') &&
        !error.message.includes('@'),
    );
  }
});
