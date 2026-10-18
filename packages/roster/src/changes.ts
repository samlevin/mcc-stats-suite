import { createHash } from 'node:crypto';
import type {
  RosterChange,
  RosterChangeAction,
  RosterEntry,
} from '@mcc/contracts';
import { keyDistance, rosterKey } from './key';

export type RosterEntryStatus = 'ACTIVE' | 'INACTIVE';

/** One roster entry at a version, with the versions that added and last changed it. */
export interface RosterEntryState extends RosterEntry {
  status: RosterEntryStatus;
  addedVersion: number;
  lastChangedVersion: number;
}

/** The roster at one version: every entry ever added, active or inactive. */
export interface Roster {
  rosterVersion: number;
  /** In the order the entries were added. */
  entries: readonly RosterEntryState[];
}

/** Version 0, the roster of a namespace with no changes. */
export const EMPTY_ROSTER: Roster = { rosterVersion: 0, entries: [] };

/**
 * The change log cannot be folded: a version is missing or repeated, an `ADD`
 * reuses a `gamertagId`, an action is unknown, or an action finds its entry
 * missing or in the wrong state. Messages name versions and IDs, never a
 * gamertag.
 */
export class RosterIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RosterIntegrityError';
  }
}

/**
 * Applies `changes` in order to `base` (spec 6 §5.1). The first change must
 * have version `base.rosterVersion + 1` and each later one the next version.
 * `base` defaults to the empty roster; pass a cached roster to fold only the
 * changes after it. `base` is never modified.
 */
export function foldRoster(
  changes: readonly RosterChange[],
  base: Roster = EMPTY_ROSTER,
): Roster {
  const entries = new Map<string, RosterEntryState>(
    base.entries.map((entry) => [entry.gamertagId, entry]),
  );
  let rosterVersion = base.rosterVersion;
  for (const change of changes) {
    if (change.rosterVersion !== rosterVersion + 1) {
      throw new RosterIntegrityError(
        `Expected roster version ${rosterVersion + 1}, found ${change.rosterVersion}`,
      );
    }
    rosterVersion = change.rosterVersion;
    const existing = entries.get(change.gamertagId);
    if (change.action === 'ADD') {
      if (existing) {
        throw new RosterIntegrityError(
          `Version ${rosterVersion} adds existing entry ${change.gamertagId}`,
        );
      }
      entries.set(change.gamertagId, {
        gamertagId: change.gamertagId,
        gamertag: change.gamertag,
        status: 'ACTIVE',
        addedVersion: rosterVersion,
        lastChangedVersion: rosterVersion,
      });
      continue;
    }
    if (change.action !== 'DEACTIVATE' && change.action !== 'REACTIVATE') {
      throw new RosterIntegrityError(
        `Version ${rosterVersion} has unknown action ${String(change.action)}`,
      );
    }
    const from: RosterEntryStatus =
      change.action === 'DEACTIVATE' ? 'ACTIVE' : 'INACTIVE';
    if (existing?.status !== from) {
      throw new RosterIntegrityError(
        `Version ${rosterVersion} cannot apply ${change.action} to entry ${change.gamertagId} (${existing?.status ?? 'missing'})`,
      );
    }
    entries.set(change.gamertagId, {
      ...existing,
      status: from === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      lastChangedVersion: rosterVersion,
    });
  }
  return { rosterVersion, entries: [...entries.values()] };
}

/**
 * The active entries of `roster` as `{ gamertagId, gamertag }`, sorted by
 * `gamertagId` bytewise: the entries of a roster snapshot and the input to
 * `resolvePlayers`.
 */
export function activeEntries(roster: Roster): RosterEntry[] {
  return roster.entries
    .filter((entry) => entry.status === 'ACTIVE')
    .map(({ gamertagId, gamertag }) => ({ gamertagId, gamertag }))
    .sort(byGamertagId);
}

/**
 * The roster hash (spec 6 §5.1): SHA-256, as lowercase hex, of the UTF-8 JSON
 * array of active entries `{ "gamertag", "gamertagId" }` sorted by
 * `gamertagId` bytewise, with sorted keys and no whitespace. Entries with
 * `status: 'INACTIVE'` are left out; entries without a status count as
 * active. The empty roster hashes `[]`.
 */
export function rosterSha256(
  entries: readonly (RosterEntry & { status?: RosterEntryStatus })[],
): string {
  const active = entries
    .filter((entry) => entry.status !== 'INACTIVE')
    // Literal key order is the sorted order: "gamertag" < "gamertagId".
    .map(({ gamertag, gamertagId }) => ({ gamertag, gamertagId }))
    .sort(byGamertagId);
  return createHash('sha256')
    .update(JSON.stringify(active), 'utf8')
    .digest('hex');
}

/** A roster write: an add, or a status change of the entry in the route. */
export type RosterChangeRequest =
  | { action: 'ADD'; body: unknown }
  | {
      action: Exclude<RosterChangeAction, 'ADD'>;
      gamertagId: string;
      body: unknown;
    };

export type RosterRefusalCode =
  | 'INVALID_REQUEST'
  | 'INVALID_GAMERTAG'
  | 'GAMERTAG_NOT_FOUND'
  | 'DUPLICATE_GAMERTAG'
  | 'KEY_CONFLICT'
  | 'ALREADY_INACTIVE'
  | 'ALREADY_ACTIVE';

/** A request refused by spec 6 §4.3. Nothing may be written. */
export interface RosterRefusal {
  accepted: false;
  status: 400 | 404 | 409;
  code: RosterRefusalCode;
  /** Names no gamertag, so it is safe to log. */
  message: string;
  /** The entries the refusal names: the duplicate or the key conflicts. */
  entries: readonly RosterEntryState[];
}

/** A request that passes every spec 6 §4.3 check against the roster. */
export interface AcceptedRosterChange {
  accepted: true;
  action: RosterChangeAction;
  /** Null for `ADD`; the caller assigns a new `evidenceId()`. */
  gamertagId: string | null;
  /** The validated gamertag for `ADD`, or the entry's gamertag. */
  gamertag: string;
  reason: string | null;
  clientRequestId: string;
  warnings: { nearKeyGamertags: string[] };
}

/** Spec 2's default `playerNamePattern` (spec 6 §4.3). */
const GAMERTAG_PATTERN = /^[A-Za-z0-9 ]{1,16}(#[0-9]{1,4})?$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 256;

/**
 * Checks a roster write against `roster` (spec 6 §4.3) and returns either
 * every value the change needs or the refusal. `body` is the parsed JSON
 * request body and is validated here, so it may hold anything. On an add or
 * reactivate, `warnings.nearKeyGamertags` lists active gamertags whose key is
 * one edit from the entry's key, sorted ignoring case.
 *
 * `CONCURRENT_CHANGE`, `ROSTER_INTEGRITY` and `UNAVAILABLE` come from storage
 * and `foldRoster`, not from this check.
 */
export function checkChange(
  roster: Roster,
  request: RosterChangeRequest,
): AcceptedRosterChange | RosterRefusal {
  const allowed =
    request.action === 'ADD'
      ? ['gamertag', 'reason', 'clientRequestId']
      : ['reason', 'clientRequestId'];
  const body = request.body;
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).some((field) => !allowed.includes(field))
  ) {
    return refuse(400, 'INVALID_REQUEST', 'The body fails the schema.');
  }
  const { gamertag, reason, clientRequestId } = body as Record<string, unknown>;
  if (
    typeof clientRequestId !== 'string' ||
    !UUID_PATTERN.test(clientRequestId)
  ) {
    return refuse(400, 'INVALID_REQUEST', 'clientRequestId must be a UUID.');
  }
  if (
    reason !== undefined &&
    (typeof reason !== 'string' ||
      Array.from(reason).length > MAX_REASON_LENGTH)
  ) {
    return refuse(
      400,
      'INVALID_REQUEST',
      `reason must be a string of at most ${MAX_REASON_LENGTH} characters.`,
    );
  }
  const accepted = {
    accepted: true as const,
    action: request.action,
    reason: reason ?? null,
    clientRequestId,
  };

  if (request.action === 'ADD') {
    if (typeof gamertag !== 'string') {
      return refuse(400, 'INVALID_REQUEST', 'gamertag must be a string.');
    }
    const normalized = gamertag.trim().replace(/\s+/gu, ' ');
    if (!GAMERTAG_PATTERN.test(normalized)) {
      return refuse(
        400,
        'INVALID_GAMERTAG',
        'The gamertag does not match the gamertag pattern.',
      );
    }
    const lowered = normalized.toLowerCase();
    const duplicates = roster.entries.filter(
      (entry) => entry.gamertag.toLowerCase() === lowered,
    );
    if (duplicates.length > 0) {
      return refuse(
        409,
        'DUPLICATE_GAMERTAG',
        'An entry has the same gamertag ignoring case.',
        duplicates,
      );
    }
    return checkKey(roster, normalized, null, {
      ...accepted,
      gamertagId: null,
      gamertag: normalized,
    });
  }

  const entry = roster.entries.find(
    (candidate) => candidate.gamertagId === request.gamertagId,
  );
  if (!entry) {
    return refuse(404, 'GAMERTAG_NOT_FOUND', 'No entry has this gamertagId.');
  }
  const change = {
    ...accepted,
    gamertagId: entry.gamertagId,
    gamertag: entry.gamertag,
  };
  if (request.action === 'DEACTIVATE') {
    if (entry.status === 'INACTIVE') {
      return refuse(409, 'ALREADY_INACTIVE', 'The entry is already inactive.');
    }
    return { ...change, warnings: { nearKeyGamertags: [] } };
  }
  if (entry.status === 'ACTIVE') {
    return refuse(409, 'ALREADY_ACTIVE', 'The entry is already active.');
  }
  return checkKey(roster, entry.gamertag, entry.gamertagId, change);
}

/**
 * Refuses a gamertag whose key equals an active entry's, and otherwise lists
 * the active gamertags one key edit away.
 */
function checkKey(
  roster: Roster,
  gamertag: string,
  gamertagId: string | null,
  change: Omit<AcceptedRosterChange, 'warnings'>,
): AcceptedRosterChange | RosterRefusal {
  const key = rosterKey(gamertag);
  const others = roster.entries
    .filter(
      (entry) => entry.status === 'ACTIVE' && entry.gamertagId !== gamertagId,
    )
    .map((entry) => ({
      entry,
      distance: keyDistance(key, rosterKey(entry.gamertag)),
    }));
  const conflicts = others.filter(({ distance }) => distance === 0);
  if (conflicts.length > 0) {
    return refuse(
      409,
      'KEY_CONFLICT',
      'An active entry shares the matching key.',
      conflicts.map(({ entry }) => entry),
    );
  }
  const nearKeyGamertags = others
    .filter(({ distance }) => distance === 1)
    .map(({ entry }) => entry.gamertag)
    .sort(
      (left, right) =>
        compareBytes(left.toLowerCase(), right.toLowerCase()) ||
        compareBytes(left, right),
    );
  return { ...change, warnings: { nearKeyGamertags } };
}

function refuse(
  status: RosterRefusal['status'],
  code: RosterRefusalCode,
  message: string,
  entries: readonly RosterEntryState[] = [],
): RosterRefusal {
  return { accepted: false, status, code, message, entries };
}

function byGamertagId(left: RosterEntry, right: RosterEntry): number {
  return compareBytes(left.gamertagId, right.gamertagId);
}

function compareBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}
