import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type {
  RosterChange,
  RosterChangeAction,
  RosterEntry,
  RosterReference,
  RosterSnapshot,
} from '@mcc/contracts';
import {
  EMPTY_ROSTER,
  RosterIntegrityError,
  activeEntries,
  foldRoster,
  rosterSha256,
  type Roster,
} from '@mcc/roster';
import { bodyToBuffer } from './s3';

/** The `HEAD` item of a roster partition (spec 1.2 §5.1). */
export interface RosterHead {
  rosterVersion: number;
  rosterSha256: string;
}

/** Reads one roster partition of the roster table. */
export interface RosterTable {
  /** Reads `HEAD` with a consistent read; undefined when the partition has none. */
  readHead(partitionKey: string): Promise<RosterHead | undefined>;
  /**
   * Reads the change items with versions after `afterVersion` up to
   * `throughVersion`, with consistent reads, in version order.
   */
  readChanges(
    partitionKey: string,
    afterVersion: number,
    throughVersion: number,
  ): Promise<RosterChange[]>;
}

/** The outcome of one create-only snapshot write. */
export type SnapshotWriteResult = 'CREATED' | 'EXISTS' | 'CONFLICT';

/** Writes and reads roster snapshots in the evidence bucket. */
export interface SnapshotStore {
  /**
   * Writes `body` with `If-None-Match: *`. Resolves `EXISTS` on HTTP 412 and
   * `CONFLICT` on HTTP 409, when another create-only write of the same key is
   * in flight.
   */
  putIfAbsent(
    bucket: string,
    key: string,
    body: string,
  ): Promise<SnapshotWriteResult>;
  read(bucket: string, key: string): Promise<Buffer>;
  /** Waits before retrying a write that ended in `CONFLICT`. */
  pause(attempt: number): Promise<void>;
}

/** The roster version one run uses. */
export interface LoadedRoster {
  /** Recorded on the run only after its snapshot exists and matches. */
  reference: RosterReference;
  /** Active entries sorted by `gamertagId`: the snapshot entries and the `resolvePlayers` input. */
  entries: RosterEntry[];
}

/**
 * The roster snapshot already in the evidence bucket has a different hash
 * from the roster this run read. The run fails and is not retried.
 */
export class RosterSnapshotMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterSnapshotMismatchError';
  }
}

const NAMESPACE_PATTERN = /^(stable|ephemeral\/[a-z0-9][a-z0-9-]{0,19})$/;
const SNAPSHOT_WRITE_ATTEMPTS = 3;

export function rosterPartitionKey(namespace: string): string {
  return `ROSTER#${namespace}`;
}

/** `[<objectPrefix>/]roster/versions/<rosterVersion, 10 digits>.json` (spec 1.2 §5.2). */
export function rosterSnapshotKey(
  objectPrefix: string,
  rosterVersion: number,
): string {
  const key = `roster/versions/${String(rosterVersion).padStart(10, '0')}.json`;
  const prefix = objectPrefix.replace(/^\/+|\/+$/g, '');
  return prefix ? `${prefix}/${key}` : key;
}

/**
 * The snapshot document of one roster version. Its bytes depend only on the
 * namespace and the roster, so every writer of a version writes the same
 * object.
 */
export function rosterSnapshotBody(
  namespace: string,
  rosterVersion: number,
  entries: readonly RosterEntry[],
): string {
  const snapshot: RosterSnapshot = {
    schemaVersion: 'roster-snapshot/v1',
    namespace,
    rosterVersion,
    rosterSha256: rosterSha256(entries),
    entries: entries.map(({ gamertagId, gamertag }) => ({
      gamertagId,
      gamertag,
    })),
  };
  return JSON.stringify(snapshot);
}

/**
 * Reads the roster of a namespace for `extract-text` (spec 1.2 §6.2 step 4).
 * One instance lives for the execution environment and caches the last
 * roster it folded per namespace, so a warm Lambda queries only the changes
 * after it. It also remembers the snapshots it has confirmed, and writes or
 * checks each snapshot once.
 */
export class DynamoRosterSource {
  private readonly cache = new Map<string, Roster>();
  private readonly confirmedSnapshots = new Set<string>();

  constructor(
    private readonly table: RosterTable,
    private readonly snapshots: SnapshotStore,
    private readonly objectPrefix: string,
  ) {}

  /**
   * Reads `HEAD`, folds the change log onto the cached roster, checks the
   * result against `HEAD.rosterSha256`, and makes sure the version's
   * snapshot exists in `bucket`. A namespace without `HEAD` is version 0 with
   * no entries. Fails with `RosterIntegrityError` when the log does not
   * reproduce `HEAD`, and with `RosterSnapshotMismatchError` when the stored
   * snapshot differs.
   */
  async read(namespace: string, bucket: string): Promise<LoadedRoster> {
    if (!NAMESPACE_PATTERN.test(namespace)) {
      throw new RosterIntegrityError(`Invalid roster namespace ${namespace}`);
    }
    const partitionKey = rosterPartitionKey(namespace);
    const head = await this.table.readHead(partitionKey);
    const rosterVersion = head?.rosterVersion ?? 0;
    const cached = this.cache.get(namespace);
    const base =
      cached && cached.rosterVersion <= rosterVersion ? cached : EMPTY_ROSTER;

    let roster = base;
    if (rosterVersion > base.rosterVersion) {
      const changes = await this.table.readChanges(
        partitionKey,
        base.rosterVersion,
        rosterVersion,
      );
      const foreign = changes.find((change) => change.namespace !== namespace);
      if (foreign) {
        throw new RosterIntegrityError(
          `Version ${foreign.rosterVersion} belongs to another namespace`,
        );
      }
      roster = foldRoster(changes, base);
    }
    const entries = activeEntries(roster);
    const hash = rosterSha256(entries);
    if (
      roster.rosterVersion !== rosterVersion ||
      (head !== undefined && hash !== head.rosterSha256)
    ) {
      // A restored or altered table can disagree with the cached fold, so
      // the next read folds the whole log again.
      this.cache.delete(namespace);
      throw new RosterIntegrityError(
        `The change log does not reproduce HEAD version ${rosterVersion}`,
      );
    }
    this.cache.set(namespace, roster);

    const reference: RosterReference = {
      namespace,
      rosterVersion,
      rosterSha256: hash,
      snapshot: {
        bucket,
        key: rosterSnapshotKey(this.objectPrefix, rosterVersion),
      },
    };
    await this.ensureSnapshot(reference, entries);
    return { reference, entries };
  }

  /**
   * Writes the snapshot of `reference` create-only, unless this execution
   * environment has already confirmed it. When the object exists, it reads
   * it and fails with `RosterSnapshotMismatchError` unless its namespace,
   * version and `rosterSha256` match. A write that conflicts with another
   * in-flight write of the same key is retried.
   */
  async ensureSnapshot(
    reference: RosterReference,
    entries: readonly RosterEntry[],
  ): Promise<void> {
    const { bucket, key } = reference.snapshot;
    const id = `${bucket}/${key}`;
    if (this.confirmedSnapshots.has(id)) return;
    const body = rosterSnapshotBody(
      reference.namespace,
      reference.rosterVersion,
      entries,
    );
    for (let attempt = 1; ; attempt += 1) {
      const result = await this.snapshots.putIfAbsent(bucket, key, body);
      if (result === 'CREATED') break;
      if (result === 'EXISTS') {
        await this.checkExistingSnapshot(reference);
        break;
      }
      if (attempt >= SNAPSHOT_WRITE_ATTEMPTS) {
        const error = new Error(
          `Roster snapshot ${reference.rosterVersion} write conflicted ${attempt} times`,
        );
        error.name = 'RosterSnapshotConflictError';
        throw error;
      }
      await this.snapshots.pause(attempt);
    }
    this.confirmedSnapshots.add(id);
  }

  private async checkExistingSnapshot(
    reference: RosterReference,
  ): Promise<void> {
    const { bucket, key } = reference.snapshot;
    let existing: Partial<RosterSnapshot> | undefined;
    try {
      existing = JSON.parse(
        (await this.snapshots.read(bucket, key)).toString('utf8'),
      ) as Partial<RosterSnapshot>;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (
      existing?.namespace !== reference.namespace ||
      existing.rosterVersion !== reference.rosterVersion ||
      existing.rosterSha256 !== reference.rosterSha256
    ) {
      throw new RosterSnapshotMismatchError(
        `Roster snapshot ${reference.rosterVersion} does not match the roster table`,
      );
    }
  }
}

/** The roster table through the DynamoDB API. */
export function dynamoRosterTable(
  tableName: string,
  client: DynamoDBClient = new DynamoDBClient({}),
): RosterTable {
  return {
    async readHead(partitionKey) {
      const { Item } = await client.send(
        new GetItemCommand({
          TableName: tableName,
          Key: { pk: { S: partitionKey }, sk: { S: 'HEAD' } },
          ConsistentRead: true,
        }),
      );
      if (!Item) return undefined;
      return {
        rosterVersion: numberAttribute(Item, 'rosterVersion'),
        rosterSha256: stringAttribute(Item, 'rosterSha256'),
      };
    },
    async readChanges(partitionKey, afterVersion, throughVersion) {
      const changes: RosterChange[] = [];
      let exclusiveStartKey: Record<string, AttributeValue> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'pk = :pk AND sk BETWEEN :first AND :last',
            ExpressionAttributeValues: {
              ':pk': { S: partitionKey },
              ':first': { S: changeSortKey(afterVersion + 1) },
              ':last': { S: changeSortKey(throughVersion) },
            },
            ConsistentRead: true,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
        changes.push(...(page.Items ?? []).map(changeFromItem));
        exclusiveStartKey = page.LastEvaluatedKey;
      } while (exclusiveStartKey);
      return changes.sort(
        (left, right) => left.rosterVersion - right.rosterVersion,
      );
    },
  };
}

/** Roster snapshots in S3, written create-only. */
export function s3SnapshotStore(
  client: S3Client = new S3Client({}),
): SnapshotStore {
  return {
    async putIfAbsent(bucket, key, body) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: 'application/json',
            IfNoneMatch: '*',
          }),
        );
        return 'CREATED';
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } })
          ?.$metadata?.httpStatusCode;
        if (status === 412) return 'EXISTS';
        if (status === 409) return 'CONFLICT';
        throw error;
      }
    },
    async read(bucket, key) {
      const object = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      return bodyToBuffer(object.Body);
    },
    pause: (attempt) =>
      new Promise((resolve) => setTimeout(resolve, 200 * attempt)),
  };
}

export function changeSortKey(rosterVersion: number): string {
  return `CHANGE#${String(rosterVersion).padStart(10, '0')}`;
}

const ACTIONS: readonly RosterChangeAction[] = [
  'ADD',
  'DEACTIVATE',
  'REACTIVATE',
];

/** Reads a `roster-change/v1` item. Errors name the item key, never a gamertag. */
export function changeFromItem(
  item: Record<string, AttributeValue>,
): RosterChange {
  const schemaVersion = stringAttribute(item, 'schemaVersion');
  const action = stringAttribute(item, 'action');
  if (
    schemaVersion !== 'roster-change/v1' ||
    !ACTIONS.includes(action as RosterChangeAction)
  ) {
    throw new RosterIntegrityError(
      `Item ${item.sk?.S ?? '?'} is not a roster-change/v1 change`,
    );
  }
  return {
    schemaVersion,
    namespace: stringAttribute(item, 'namespace'),
    rosterVersion: numberAttribute(item, 'rosterVersion'),
    action: action as RosterChangeAction,
    gamertagId: stringAttribute(item, 'gamertagId'),
    gamertag: stringAttribute(item, 'gamertag'),
    reason: item.reason?.NULL ? null : stringAttribute(item, 'reason'),
    actorArn: stringAttribute(item, 'actorArn'),
    clientRequestId: stringAttribute(item, 'clientRequestId'),
    changedAt: stringAttribute(item, 'changedAt'),
    rosterSha256: stringAttribute(item, 'rosterSha256'),
  };
}

function stringAttribute(
  item: Record<string, AttributeValue>,
  name: string,
): string {
  const value = item[name]?.S;
  if (value === undefined) {
    throw new RosterIntegrityError(
      `Item ${item.sk?.S ?? '?'} has no string ${name}`,
    );
  }
  return value;
}

function numberAttribute(
  item: Record<string, AttributeValue>,
  name: string,
): number {
  const value = Number(item[name]?.N);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RosterIntegrityError(
      `Item ${item.sk?.S ?? '?'} has no number ${name}`,
    );
  }
  return value;
}
