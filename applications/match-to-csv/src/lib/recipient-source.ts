import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  type AttributeValue,
} from '@aws-sdk/client-dynamodb';
import type {
  RecipientChange,
  RecipientChangeAction,
  RecipientEntry,
} from '@mcc/contracts';
import {
  RecipientsIntegrityError,
  activeRecipients,
  foldRecipients,
  normalizeAddress,
  recipientsSha256,
} from '@mcc/recipients';

/** The `HEAD` item of a recipient list partition (spec 1.1 §4.5). */
export interface RecipientsHead {
  recipientsVersion: number;
  recipientsSha256: string;
}

/** Reads one partition of the CSV recipient table. */
export interface RecipientTable {
  /** Reads `HEAD` with a consistent read; undefined when the partition has none. */
  readHead(partitionKey: string): Promise<RecipientsHead | undefined>;
  /** Reads change items 1 to `throughVersion` with consistent reads, in version order. */
  readChanges(
    partitionKey: string,
    throughVersion: number,
  ): Promise<RecipientChange[]>;
}

/** The active recipients of one recipient list version. */
export interface LoadedRecipients {
  recipientsVersion: number;
  recipientsSha256: string;
  /** Sorted by `recipientId`. */
  entries: RecipientEntry[];
}

const NAMESPACE_PATTERN = /^(stable|ephemeral\/[a-z0-9][a-z0-9-]{0,19})$/;

export function recipientsPartitionKey(namespace: string): string {
  return `RECIPIENTS#${namespace}`;
}

/**
 * Reads `HEAD` of the namespace's partition, folds its change log with
 * `foldRecipients`, and checks the result against `HEAD.recipientsSha256`. A
 * namespace without `HEAD` is version 0 with no entries. Fails with
 * `RecipientsIntegrityError`, whose message names versions and IDs only, when
 * the log does not reproduce `HEAD` or an active address is not valid.
 */
export async function readRecipients(
  table: RecipientTable,
  namespace: string,
): Promise<LoadedRecipients> {
  if (!NAMESPACE_PATTERN.test(namespace)) {
    throw new RecipientsIntegrityError(
      `Invalid recipients namespace ${namespace}`,
    );
  }
  const partitionKey = recipientsPartitionKey(namespace);
  const head = await table.readHead(partitionKey);
  const recipientsVersion = head?.recipientsVersion ?? 0;
  const list = foldRecipients(
    recipientsVersion === 0
      ? []
      : await table.readChanges(partitionKey, recipientsVersion),
  );
  const entries = activeRecipients(list);
  const hash = recipientsSha256(entries);
  if (
    list.recipientsVersion !== recipientsVersion ||
    (head !== undefined && hash !== head.recipientsSha256)
  ) {
    throw new RecipientsIntegrityError(
      `The change log does not reproduce HEAD version ${recipientsVersion}`,
    );
  }
  // Addresses go into message headers, so each must still pass the check
  // the recipient script applied when it was added.
  const invalid = entries.find(
    (entry) => normalizeAddress(entry.address) !== entry.address,
  );
  if (invalid) {
    throw new RecipientsIntegrityError(
      `Entry ${invalid.recipientId} has an invalid address`,
    );
  }
  return { recipientsVersion, recipientsSha256: hash, entries };
}

/** The recipient table through the DynamoDB API. */
export function dynamoRecipientTable(
  tableName: string,
  client: DynamoDBClient = new DynamoDBClient({}),
): RecipientTable {
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
        recipientsVersion: numberAttribute(Item, 'recipientsVersion'),
        recipientsSha256: stringAttribute(Item, 'recipientsSha256'),
      };
    },
    async readChanges(partitionKey, throughVersion) {
      const changes: RecipientChange[] = [];
      let exclusiveStartKey: Record<string, AttributeValue> | undefined;
      do {
        const page = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'pk = :pk AND sk BETWEEN :first AND :last',
            ExpressionAttributeValues: {
              ':pk': { S: partitionKey },
              ':first': { S: changeSortKey(1) },
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
        (left, right) => left.recipientsVersion - right.recipientsVersion,
      );
    },
  };
}

export function changeSortKey(recipientsVersion: number): string {
  return `CHANGE#${String(recipientsVersion).padStart(10, '0')}`;
}

const ACTIONS: readonly RecipientChangeAction[] = [
  'ADD',
  'DEACTIVATE',
  'REACTIVATE',
];

/** Reads a recipient change item. Errors name the item key, never an address. */
export function changeFromItem(
  item: Record<string, AttributeValue>,
): RecipientChange {
  const action = stringAttribute(item, 'action');
  if (!ACTIONS.includes(action as RecipientChangeAction)) {
    throw new RecipientsIntegrityError(
      `Item ${item.sk?.S ?? '?'} has an unknown action`,
    );
  }
  return {
    recipientsVersion: numberAttribute(item, 'recipientsVersion'),
    action: action as RecipientChangeAction,
    recipientId: stringAttribute(item, 'recipientId'),
    address: stringAttribute(item, 'address'),
    reason: item.reason?.NULL ? null : stringAttribute(item, 'reason'),
    actorArn: stringAttribute(item, 'actorArn'),
    clientRequestId: stringAttribute(item, 'clientRequestId'),
    changedAt: stringAttribute(item, 'changedAt'),
  };
}

function stringAttribute(
  item: Record<string, AttributeValue>,
  name: string,
): string {
  const value = item[name]?.S;
  if (value === undefined) {
    throw new RecipientsIntegrityError(
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
    throw new RecipientsIntegrityError(
      `Item ${item.sk?.S ?? '?'} has no number ${name}`,
    );
  }
  return value;
}
