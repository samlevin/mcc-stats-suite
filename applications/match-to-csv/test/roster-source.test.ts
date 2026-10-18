import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AttributeValue, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { S3Client } from '@aws-sdk/client-s3';
import type { RosterChange, RosterSnapshot } from '@mcc/contracts';
import { activeEntries, foldRoster, rosterSha256 } from '@mcc/roster';
import {
  DynamoRosterSource,
  RosterSnapshotMismatchError,
  changeFromItem,
  dynamoRosterTable,
  rosterSnapshotBody,
  rosterSnapshotKey,
  s3SnapshotStore,
  type RosterHead,
  type RosterTable,
  type SnapshotStore,
  type SnapshotWriteResult,
} from '../src/lib/roster-source';

const NAMESPACE = 'ephemeral/tester';
const PARTITION = 'ROSTER#ephemeral/tester';

/** Synthetic changes; never real gamertags. */
function change(
  rosterVersion: number,
  action: RosterChange['action'],
  gamertagId: string,
  gamertag: string,
  namespace = NAMESPACE,
): RosterChange {
  return {
    schemaVersion: 'roster-change/v1',
    namespace,
    rosterVersion,
    action,
    gamertagId,
    gamertag,
    reason: null,
    actorArn: 'arn:aws:sts::000000000000:assumed-role/operator/session',
    clientRequestId: `00000000-0000-4000-8000-${String(rosterVersion).padStart(12, '0')}`,
    changedAt: '2026-01-01T00:00:00.000Z',
    rosterSha256: '',
  };
}

const LOG: RosterChange[] = [
  change(1, 'ADD', 'id-b', 'Player Two'),
  change(2, 'ADD', 'id-a', 'PlayerOne'),
  change(3, 'DEACTIVATE', 'id-b', 'Player Two'),
  change(4, 'ADD', 'id-c', 'Player03'),
];

function headAt(rosterVersion: number, log = LOG): RosterHead {
  return {
    rosterVersion,
    rosterSha256: rosterSha256(
      activeEntries(foldRoster(log.slice(0, rosterVersion))),
    ),
  };
}

class FakeTable implements RosterTable {
  head: RosterHead | undefined;
  log: RosterChange[] = LOG;
  readonly reads: Array<[string, number, number]> = [];
  readonly heads: string[] = [];

  async readHead(partitionKey: string) {
    this.heads.push(partitionKey);
    return this.head;
  }

  async readChanges(
    partitionKey: string,
    afterVersion: number,
    throughVersion: number,
  ) {
    this.reads.push([partitionKey, afterVersion, throughVersion]);
    return this.log.filter(
      (item) =>
        item.rosterVersion > afterVersion &&
        item.rosterVersion <= throughVersion,
    );
  }
}

class FakeSnapshots implements SnapshotStore {
  readonly objects = new Map<string, string>();
  readonly puts: string[] = [];
  readonly pauses: number[] = [];
  conflicts = 0;

  async putIfAbsent(
    bucket: string,
    key: string,
    body: string,
  ): Promise<SnapshotWriteResult> {
    const id = `${bucket}/${key}`;
    this.puts.push(id);
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      return 'CONFLICT';
    }
    if (this.objects.has(id)) return 'EXISTS';
    this.objects.set(id, body);
    return 'CREATED';
  }

  async read(bucket: string, key: string) {
    const body = this.objects.get(`${bucket}/${key}`);
    if (body === undefined) throw new Error('missing object');
    return Buffer.from(body);
  }

  async pause(attempt: number) {
    this.pauses.push(attempt);
  }
}

function source(table = new FakeTable(), snapshots = new FakeSnapshots()) {
  return {
    table,
    snapshots,
    roster: new DynamoRosterSource(table, snapshots, 'ephemeral/tester'),
  };
}

test('a namespace without HEAD is version 0 with no entries and an empty snapshot', async () => {
  const { table, snapshots, roster } = source();
  const loaded = await roster.read(NAMESPACE, 'evidence');

  assert.deepEqual(table.heads, [PARTITION]);
  assert.deepEqual(table.reads, [], 'version 0 has no changes to read');
  assert.deepEqual(loaded.entries, []);
  assert.deepEqual(loaded.reference, {
    namespace: NAMESPACE,
    rosterVersion: 0,
    rosterSha256: rosterSha256([]),
    snapshot: {
      bucket: 'evidence',
      key: 'ephemeral/tester/roster/versions/0000000000.json',
    },
  });
  const snapshot = JSON.parse(
    snapshots.objects.get(
      'evidence/ephemeral/tester/roster/versions/0000000000.json',
    )!,
  ) as RosterSnapshot;
  assert.deepEqual(snapshot, {
    schemaVersion: 'roster-snapshot/v1',
    namespace: NAMESPACE,
    rosterVersion: 0,
    rosterSha256: rosterSha256([]),
    entries: [],
  });
});

test('read folds the log to HEAD and returns the active entries sorted by gamertagId', async () => {
  const { table, snapshots, roster } = source();
  table.head = headAt(4);
  const loaded = await roster.read(NAMESPACE, 'evidence');

  assert.deepEqual(table.reads, [[PARTITION, 0, 4]]);
  assert.deepEqual(loaded.entries, [
    { gamertagId: 'id-a', gamertag: 'PlayerOne' },
    { gamertagId: 'id-c', gamertag: 'Player03' },
  ]);
  assert.equal(loaded.reference.rosterVersion, 4);
  assert.equal(loaded.reference.rosterSha256, table.head.rosterSha256);
  const key = 'ephemeral/tester/roster/versions/0000000004.json';
  assert.equal(loaded.reference.snapshot.key, key);
  // The snapshot exists before read returns the reference a run records.
  assert.equal(
    snapshots.objects.get(`evidence/${key}`),
    rosterSnapshotBody(NAMESPACE, 4, loaded.entries),
  );
});

test('a warm source folds only the changes after its cached version', async () => {
  const { table, snapshots, roster } = source();
  table.head = headAt(2);
  await roster.read(NAMESPACE, 'evidence');
  table.head = headAt(4);
  const loaded = await roster.read(NAMESPACE, 'evidence');

  assert.deepEqual(table.reads, [
    [PARTITION, 0, 2],
    [PARTITION, 2, 4],
  ]);
  assert.deepEqual(
    loaded.entries.map((entry) => entry.gamertagId),
    ['id-a', 'id-c'],
  );
  assert.equal(snapshots.objects.size, 2);

  // An unchanged HEAD reads no changes and writes no snapshot again.
  await roster.read(NAMESPACE, 'evidence');
  assert.equal(table.reads.length, 2);
  assert.equal(snapshots.puts.length, 2);
});

test('a HEAD behind the cache folds the whole log again', async () => {
  const { table, roster } = source();
  table.head = headAt(4);
  await roster.read(NAMESPACE, 'evidence');
  table.head = headAt(2);
  const loaded = await roster.read(NAMESPACE, 'evidence');

  assert.deepEqual(table.reads, [
    [PARTITION, 0, 4],
    [PARTITION, 0, 2],
  ]);
  assert.equal(loaded.reference.rosterVersion, 2);
  assert.deepEqual(
    loaded.entries.map((entry) => entry.gamertagId),
    ['id-a', 'id-b'],
  );
});

test('a hash mismatch fails with RosterIntegrityError and drops the cache', async () => {
  const { table, snapshots, roster } = source();
  table.head = headAt(2);
  await roster.read(NAMESPACE, 'evidence');
  table.head = { rosterVersion: 4, rosterSha256: 'f'.repeat(64) };

  await assert.rejects(roster.read(NAMESPACE, 'evidence'), {
    name: 'RosterIntegrityError',
    message: 'The change log does not reproduce HEAD version 4',
  });
  assert.equal(snapshots.puts.length, 1, 'no snapshot for a failed read');

  table.head = headAt(4);
  await roster.read(NAMESPACE, 'evidence');
  assert.deepEqual(table.reads.at(-1), [PARTITION, 0, 4]);
});

test('a log that stops short of HEAD fails with RosterIntegrityError', async () => {
  const { table, roster } = source();
  table.head = headAt(4);
  table.log = LOG.slice(0, 3);
  await assert.rejects(roster.read(NAMESPACE, 'evidence'), {
    name: 'RosterIntegrityError',
  });
});

test('a gap in the log fails the fold with RosterIntegrityError', async () => {
  const { table, roster } = source();
  table.head = headAt(4);
  table.log = [LOG[0], LOG[2], LOG[3]];
  await assert.rejects(roster.read(NAMESPACE, 'evidence'), {
    name: 'RosterIntegrityError',
  });
});

test('a change from another namespace fails with RosterIntegrityError', async () => {
  const { table, roster } = source();
  table.head = headAt(1);
  table.log = [change(1, 'ADD', 'id-a', 'PlayerOne', 'stable')];
  await assert.rejects(roster.read(NAMESPACE, 'evidence'), {
    name: 'RosterIntegrityError',
  });
});

test('read refuses a namespace outside stable and ephemeral/<name>', async () => {
  const { table, roster } = source();
  for (const namespace of ['', 'Stable', 'ephemeral/', 'ephemeral/a/b']) {
    await assert.rejects(roster.read(namespace, 'evidence'), {
      name: 'RosterIntegrityError',
    });
  }
  assert.deepEqual(table.heads, []);
});

test('a snapshot is written once per execution environment', async () => {
  const { table, snapshots, roster } = source();
  table.head = headAt(4);
  await roster.read(NAMESPACE, 'evidence');
  await roster.read(NAMESPACE, 'evidence');
  assert.equal(snapshots.puts.length, 1);
});

test('an existing matching snapshot (412) is accepted', async () => {
  const snapshots = new FakeSnapshots();
  const table = new FakeTable();
  table.head = headAt(4);
  // Another execution environment wrote the same version first.
  await source(table, snapshots).roster.read(NAMESPACE, 'evidence');
  const { roster } = source(table, snapshots);
  const loaded = await roster.read(NAMESPACE, 'evidence');

  assert.equal(snapshots.puts.length, 2);
  assert.equal(snapshots.objects.size, 1);
  assert.equal(loaded.reference.rosterVersion, 4);
});

test('an existing snapshot with a different hash fails with RosterSnapshotMismatchError', async () => {
  const snapshots = new FakeSnapshots();
  const table = new FakeTable();
  table.head = headAt(4);
  const key = 'evidence/ephemeral/tester/roster/versions/0000000004.json';
  snapshots.objects.set(
    key,
    JSON.stringify({
      schemaVersion: 'roster-snapshot/v1',
      namespace: NAMESPACE,
      rosterVersion: 4,
      rosterSha256: 'e'.repeat(64),
      entries: [],
    }),
  );
  const { roster } = source(table, snapshots);
  await assert.rejects(
    roster.read(NAMESPACE, 'evidence'),
    (error: unknown) =>
      error instanceof RosterSnapshotMismatchError &&
      error.name === 'RosterSnapshotMismatchError',
  );

  snapshots.objects.set(key, 'not json');
  await assert.rejects(roster.read(NAMESPACE, 'evidence'), {
    name: 'RosterSnapshotMismatchError',
  });
});

test('a conflicting in-flight snapshot write is retried, then fails', async () => {
  const table = new FakeTable();
  table.head = headAt(4);
  const snapshots = new FakeSnapshots();
  snapshots.conflicts = 2;
  await source(table, snapshots).roster.read(NAMESPACE, 'evidence');
  assert.equal(snapshots.puts.length, 3);
  assert.deepEqual(snapshots.pauses, [1, 2]);

  const failing = new FakeSnapshots();
  failing.conflicts = 3;
  await assert.rejects(
    source(table, failing).roster.read(NAMESPACE, 'evidence'),
    {
      name: 'RosterSnapshotConflictError',
    },
  );
  assert.equal(failing.puts.length, 3);
});

test('snapshot keys are zero-padded under the object prefix', () => {
  assert.equal(rosterSnapshotKey('', 12), 'roster/versions/0000000012.json');
  assert.equal(
    rosterSnapshotKey('/ephemeral/tester/', 0),
    'ephemeral/tester/roster/versions/0000000000.json',
  );
});

/** A DynamoDB client double that records each command's input. */
function dynamoClient(respond: (name: string, input: any) => unknown): {
  client: DynamoDBClient;
  inputs: Array<[string, any]>;
} {
  const inputs: Array<[string, any]> = [];
  const client = {
    async send(command: { constructor: { name: string }; input: unknown }) {
      inputs.push([command.constructor.name, command.input]);
      return respond(command.constructor.name, command.input);
    },
  } as unknown as DynamoDBClient;
  return { client, inputs };
}

function changeItem(value: RosterChange): Record<string, AttributeValue> {
  return {
    pk: { S: `ROSTER#${value.namespace}` },
    sk: { S: `CHANGE#${String(value.rosterVersion).padStart(10, '0')}` },
    schemaVersion: { S: value.schemaVersion },
    namespace: { S: value.namespace },
    rosterVersion: { N: String(value.rosterVersion) },
    action: { S: value.action },
    gamertagId: { S: value.gamertagId },
    gamertag: { S: value.gamertag },
    reason: value.reason === null ? { NULL: true } : { S: value.reason },
    actorArn: { S: value.actorArn },
    clientRequestId: { S: value.clientRequestId },
    changedAt: { S: value.changedAt },
    rosterSha256: { S: value.rosterSha256 },
  };
}

test('the DynamoDB table reads HEAD with a consistent read', async () => {
  const { client, inputs } = dynamoClient(() => ({
    Item: {
      pk: { S: PARTITION },
      sk: { S: 'HEAD' },
      rosterVersion: { N: '4' },
      rosterSha256: { S: 'a'.repeat(64) },
    },
  }));
  const table = dynamoRosterTable('roster-table', client);
  assert.deepEqual(await table.readHead(PARTITION), {
    rosterVersion: 4,
    rosterSha256: 'a'.repeat(64),
  });
  assert.deepEqual(inputs, [
    [
      'GetItemCommand',
      {
        TableName: 'roster-table',
        Key: { pk: { S: PARTITION }, sk: { S: 'HEAD' } },
        ConsistentRead: true,
      },
    ],
  ]);

  const empty = dynamoRosterTable(
    'roster-table',
    dynamoClient(() => ({})).client,
  );
  assert.equal(await empty.readHead(PARTITION), undefined);

  const broken = dynamoRosterTable(
    'roster-table',
    dynamoClient(() => ({ Item: { sk: { S: 'HEAD' } } })).client,
  );
  await assert.rejects(broken.readHead(PARTITION), {
    name: 'RosterIntegrityError',
  });
});

test('the DynamoDB table queries the version range in pages with consistent reads', async () => {
  const withReason = { ...LOG[2], reason: 'left the league' };
  const { client, inputs } = dynamoClient((_name, input) =>
    input.ExclusiveStartKey
      ? { Items: [changeItem(LOG[1])] }
      : {
          Items: [changeItem(withReason)],
          LastEvaluatedKey: { pk: { S: PARTITION }, sk: { S: 'CHANGE#3' } },
        },
  );
  const table = dynamoRosterTable('roster-table', client);
  const changes = await table.readChanges(PARTITION, 1, 3);

  assert.deepEqual(changes, [LOG[1], withReason]);
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs[0], [
    'QueryCommand',
    {
      TableName: 'roster-table',
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :first AND :last',
      ExpressionAttributeValues: {
        ':pk': { S: PARTITION },
        ':first': { S: 'CHANGE#0000000002' },
        ':last': { S: 'CHANGE#0000000003' },
      },
      ConsistentRead: true,
      ExclusiveStartKey: undefined,
    },
  ]);
  assert.deepEqual(inputs[1][1].ExclusiveStartKey, {
    pk: { S: PARTITION },
    sk: { S: 'CHANGE#3' },
  });
});

test('change items that are not roster-change/v1 fail with RosterIntegrityError', () => {
  const item = changeItem(LOG[0]);
  assert.deepEqual(changeFromItem(item), LOG[0]);
  for (const broken of [
    { ...item, schemaVersion: { S: 'roster-change/v2' } },
    { ...item, action: { S: 'DELETE' } },
    { ...item, rosterVersion: { N: '-1' } },
    { ...item, gamertagId: { N: '1' } },
  ]) {
    assert.throws(
      () => changeFromItem(broken),
      (error: Error) => {
        assert.equal(error.name, 'RosterIntegrityError');
        assert.ok(!error.message.includes('Player'), 'no gamertag in errors');
        return true;
      },
    );
  }
});

test('the S3 snapshot store writes create-only and maps 412 and 409', async () => {
  const inputs: unknown[] = [];
  let failure: unknown;
  const client = {
    async send(command: { constructor: { name: string }; input: unknown }) {
      inputs.push(command.input);
      if (command.constructor.name === 'GetObjectCommand') {
        return {
          Body: { transformToByteArray: async () => Buffer.from('{}') },
        };
      }
      if (failure) throw failure;
      return {};
    },
  } as unknown as S3Client;
  const store = s3SnapshotStore(client);

  assert.equal(await store.putIfAbsent('evidence', 'key', 'body'), 'CREATED');
  assert.deepEqual(inputs[0], {
    Bucket: 'evidence',
    Key: 'key',
    Body: 'body',
    ContentType: 'application/json',
    IfNoneMatch: '*',
  });
  failure = { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } };
  assert.equal(await store.putIfAbsent('evidence', 'key', 'body'), 'EXISTS');
  failure = {
    name: 'ConditionalRequestConflict',
    $metadata: { httpStatusCode: 409 },
  };
  assert.equal(await store.putIfAbsent('evidence', 'key', 'body'), 'CONFLICT');
  failure = { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } };
  await assert.rejects(store.putIfAbsent('evidence', 'key', 'body'), {
    name: 'AccessDenied',
  });
  assert.equal((await store.read('evidence', 'key')).toString('utf8'), '{}');
  await store.pause(0);
});
