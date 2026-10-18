import { createHash } from 'node:crypto';
import type {
  RecipientChange,
  RecipientChangeAction,
  RecipientEntry,
} from '@mcc/contracts';

export type RecipientEntryStatus = 'ACTIVE' | 'INACTIVE';

/** One recipient at a version, with the versions that added and last changed it. */
export interface RecipientEntryState extends RecipientEntry {
  status: RecipientEntryStatus;
  addedVersion: number;
  lastChangedVersion: number;
}

/** The recipient list at one version: every entry ever added, active or inactive. */
export interface RecipientList {
  recipientsVersion: number;
  /** In the order the entries were added. */
  entries: readonly RecipientEntryState[];
}

/** Version 0, the recipient list of a namespace with no changes. */
export const EMPTY_RECIPIENTS: RecipientList = {
  recipientsVersion: 0,
  entries: [],
};

/**
 * The change log cannot be folded: a version is missing or repeated, an `ADD`
 * reuses a `recipientId`, an action is unknown, or an action finds its entry
 * missing or in the wrong state. Messages name versions and IDs, never an
 * address.
 */
export class RecipientsIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipientsIntegrityError';
  }
}

/**
 * Applies `changes` in order to `base` (spec 1.1 §4.5, with the fold of spec
 * 1.2 §5.1). The first change must have version `base.recipientsVersion + 1`
 * and each later one the next version. `base` defaults to the empty list; pass
 * a cached list to fold only the changes after it. `base` is never modified.
 */
export function foldRecipients(
  changes: readonly RecipientChange[],
  base: RecipientList = EMPTY_RECIPIENTS,
): RecipientList {
  const entries = new Map<string, RecipientEntryState>(
    base.entries.map((entry) => [entry.recipientId, entry]),
  );
  let recipientsVersion = base.recipientsVersion;
  for (const change of changes) {
    if (change.recipientsVersion !== recipientsVersion + 1) {
      throw new RecipientsIntegrityError(
        `Expected recipients version ${recipientsVersion + 1}, found ${change.recipientsVersion}`,
      );
    }
    recipientsVersion = change.recipientsVersion;
    const existing = entries.get(change.recipientId);
    if (change.action === 'ADD') {
      if (existing) {
        throw new RecipientsIntegrityError(
          `Version ${recipientsVersion} adds existing entry ${change.recipientId}`,
        );
      }
      entries.set(change.recipientId, {
        recipientId: change.recipientId,
        address: change.address,
        status: 'ACTIVE',
        addedVersion: recipientsVersion,
        lastChangedVersion: recipientsVersion,
      });
      continue;
    }
    if (change.action !== 'DEACTIVATE' && change.action !== 'REACTIVATE') {
      throw new RecipientsIntegrityError(
        `Version ${recipientsVersion} has unknown action ${String(change.action)}`,
      );
    }
    const from: RecipientEntryStatus =
      change.action === 'DEACTIVATE' ? 'ACTIVE' : 'INACTIVE';
    if (existing?.status !== from) {
      throw new RecipientsIntegrityError(
        `Version ${recipientsVersion} cannot apply ${change.action} to entry ${change.recipientId} (${existing?.status ?? 'missing'})`,
      );
    }
    entries.set(change.recipientId, {
      ...existing,
      status: from === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      lastChangedVersion: recipientsVersion,
    });
  }
  return { recipientsVersion, entries: [...entries.values()] };
}

/**
 * The active entries of `list` as `{ recipientId, address }`, sorted by
 * `recipientId` bytewise: the addresses that receive the CSVs.
 */
export function activeRecipients(list: RecipientList): RecipientEntry[] {
  return list.entries
    .filter((entry) => entry.status === 'ACTIVE')
    .map(({ recipientId, address }) => ({ recipientId, address }))
    .sort(byRecipientId);
}

/**
 * The recipient list hash: SHA-256, as lowercase hex, of the UTF-8 JSON array
 * of active entries `{ "address", "recipientId" }` sorted by `recipientId`
 * bytewise, with sorted keys and no whitespace. Entries with
 * `status: 'INACTIVE'` are left out; entries without a status count as active.
 * The empty list hashes `[]`.
 */
export function recipientsSha256(
  entries: readonly (RecipientEntry & { status?: RecipientEntryStatus })[],
): string {
  const active = entries
    .filter((entry) => entry.status !== 'INACTIVE')
    // Literal key order is the sorted order: "address" < "recipientId".
    .map(({ address, recipientId }) => ({ address, recipientId }))
    .sort(byRecipientId);
  return createHash('sha256')
    .update(JSON.stringify(active), 'utf8')
    .digest('hex');
}

/** The longest address accepted, in characters. */
export const MAX_ADDRESS_LENGTH = 254;

/**
 * Returns `text` trimmed when it is a valid address, else null. A valid address
 * has no whitespace or comma, exactly one `@` with a non-empty local part and
 * domain, and at most `MAX_ADDRESS_LENGTH` characters.
 */
export function normalizeAddress(text: string): string | null {
  const address = text.trim();
  const [local, domain, ...rest] = address.split('@');
  if (
    /[\s,]/u.test(address) ||
    rest.length > 0 ||
    !local ||
    !domain ||
    Array.from(address).length > MAX_ADDRESS_LENGTH
  ) {
    return null;
  }
  return address;
}

/**
 * A recipient write. `ADD` takes the new address; `DEACTIVATE` and
 * `REACTIVATE` find their entry by `address`, matched exactly ignoring case
 * after trimming.
 */
export interface RecipientChangeRequest {
  action: RecipientChangeAction;
  address: string;
  reason?: string;
  clientRequestId: string;
}

export type RecipientRefusalCode =
  | 'INVALID_REQUEST'
  | 'INVALID_ADDRESS'
  | 'DUPLICATE_ADDRESS'
  | 'RECIPIENT_NOT_FOUND'
  | 'ALREADY_INACTIVE'
  | 'ALREADY_ACTIVE';

/** A request the change check refuses. Nothing may be written. */
export interface RecipientRefusal {
  accepted: false;
  code: RecipientRefusalCode;
  /** Names no address, so it is safe to log. */
  message: string;
  /** The entries the refusal names: the duplicate, or several matches. */
  entries: readonly RecipientEntryState[];
}

/** A request that passes every check against the recipient list. */
export interface AcceptedRecipientChange {
  accepted: true;
  action: RecipientChangeAction;
  /** Null for `ADD`; the caller assigns a new UUID. */
  recipientId: string | null;
  /** The validated address for `ADD`, or the entry's address. */
  address: string;
  reason: string | null;
  clientRequestId: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 256;

/**
 * Checks a recipient write against `list` and returns either every value the
 * change needs or the refusal. `reason` is at most 256 characters and
 * `clientRequestId` is a UUID, as for the roster (spec 1.2 §4.3). There is no
 * key conflict or near-match check.
 *
 * `CONCURRENT_CHANGE` and `RECIPIENTS_INTEGRITY` come from storage and
 * `foldRecipients`, not from this check.
 */
export function checkRecipientChange(
  list: RecipientList,
  request: RecipientChangeRequest,
): AcceptedRecipientChange | RecipientRefusal {
  const { action, address, reason, clientRequestId } = request;
  if (
    typeof clientRequestId !== 'string' ||
    !UUID_PATTERN.test(clientRequestId)
  ) {
    return refuse('INVALID_REQUEST', 'clientRequestId must be a UUID.');
  }
  if (
    reason !== undefined &&
    (typeof reason !== 'string' ||
      Array.from(reason).length > MAX_REASON_LENGTH)
  ) {
    return refuse(
      'INVALID_REQUEST',
      `reason must be a string of at most ${MAX_REASON_LENGTH} characters.`,
    );
  }
  if (typeof address !== 'string') {
    return refuse('INVALID_REQUEST', 'address must be a string.');
  }
  const accepted = {
    accepted: true as const,
    action,
    reason: reason ?? null,
    clientRequestId,
  };

  if (action === 'ADD') {
    const normalized = normalizeAddress(address);
    if (normalized === null) {
      return refuse('INVALID_ADDRESS', 'The address is not valid.');
    }
    const duplicates = matching(list, normalized);
    if (duplicates.length > 0) {
      return refuse(
        'DUPLICATE_ADDRESS',
        'An entry has the same address ignoring case.',
        duplicates,
      );
    }
    return { ...accepted, recipientId: null, address: normalized };
  }
  if (action !== 'DEACTIVATE' && action !== 'REACTIVATE') {
    return refuse('INVALID_REQUEST', 'action is not a recipient action.');
  }

  const matches = matching(list, address.trim());
  if (matches.length !== 1) {
    return refuse(
      'RECIPIENT_NOT_FOUND',
      matches.length === 0
        ? 'No entry has this address.'
        : 'More than one entry has this address.',
      matches,
    );
  }
  const [entry] = matches;
  const change = {
    ...accepted,
    recipientId: entry.recipientId,
    address: entry.address,
  };
  if (action === 'DEACTIVATE' && entry.status === 'INACTIVE') {
    return refuse('ALREADY_INACTIVE', 'The entry is already inactive.');
  }
  if (action === 'REACTIVATE' && entry.status === 'ACTIVE') {
    return refuse('ALREADY_ACTIVE', 'The entry is already active.');
  }
  return change;
}

/** Entries, active or inactive, whose address equals `address` ignoring case. */
function matching(list: RecipientList, address: string): RecipientEntryState[] {
  const lowered = address.toLowerCase();
  return list.entries.filter(
    (entry) => entry.address.toLowerCase() === lowered,
  );
}

function refuse(
  code: RecipientRefusalCode,
  message: string,
  entries: readonly RecipientEntryState[] = [],
): RecipientRefusal {
  return { accepted: false, code, message, entries };
}

function byRecipientId(left: RecipientEntry, right: RecipientEntry): number {
  return compareBytes(left.recipientId, right.recipientId);
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
