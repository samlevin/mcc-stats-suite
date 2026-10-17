import type {
  CellErrorType,
  CsvRow,
  PlayerResolution,
  RosterEntry,
  UnmatchedReason,
} from '@mcc/contracts';
import { editMatrix, keyDistance, rosterKey } from './key';

/**
 * The matcher version a run records in its manifest (spec 6 §5.5). Any change
 * to the key, distance, thresholds, claim rule or error types bumps it.
 */
export const ROSTER_MATCHER_VERSION = 'roster-matcher-v1';

/** Readings longer than this, in code points, are never matched (§7.3 rule 1). */
export const MAX_READING_LENGTH = 32;

interface Candidate {
  entry: RosterEntry;
  key: string;
}

/**
 * Resolves each row's `player` against the active entries of one roster
 * version (spec 6 §7.3 and §7.4). Returns one resolution per row, in row
 * order, and never changes a row.
 */
export function resolvePlayers(
  rows: readonly Pick<CsvRow, 'player'>[],
  entries: readonly RosterEntry[],
): PlayerResolution[] {
  const candidates = entries.map((entry) => ({
    entry,
    key: rosterKey(entry.gamertag),
  }));
  return claimEntries(rows.map((row) => resolveRow(row.player, candidates)));
}

/**
 * The spec 3 error types that turn `asRead` into `gamertag` (spec 6 §7.5),
 * sorted and unique. The alignment is traced back from the end, preferring a
 * match or substitution, then a deletion from `asRead`, then an insertion.
 */
export function errorTypesFor(
  asRead: string,
  gamertag: string,
): CellErrorType[] {
  const read = Array.from(asRead);
  const target = Array.from(gamertag);
  const matrix = editMatrix(read, target);
  const types = new Set<CellErrorType>();
  let i = read.length;
  let j = target.length;
  while (i > 0 || j > 0) {
    const distance = matrix[i][j];
    if (i > 0 && j > 0) {
      const substitution = read[i - 1] === target[j - 1] ? 0 : 1;
      if (distance === matrix[i - 1][j - 1] + substitution) {
        if (substitution === 1) types.add('GLYPH_SUBSTITUTION');
        i -= 1;
        j -= 1;
        continue;
      }
    }
    if (i > 0 && distance === matrix[i - 1][j] + 1) {
      types.add('EXTRA_CHARACTERS');
      i -= 1;
    } else {
      types.add('MISSING_CHARACTERS');
      j -= 1;
    }
  }
  return [...types].sort();
}

/** Edits allowed for a reading to resolve to an entry with this key. */
function editBudget(key: string): number {
  return Math.min(2, Math.floor(Array.from(key).length / 5));
}

/** How much further the runner-up must be than the best entry. */
function margin(distance: number): number {
  return distance === 0 ? 1 : 2;
}

function resolveRow(
  asRead: string,
  candidates: readonly Candidate[],
): PlayerResolution {
  if (
    candidates.length === 0 ||
    Array.from(asRead).length > MAX_READING_LENGTH
  ) {
    return unmatched(asRead, 'NO_CANDIDATE', null, null);
  }

  const readingKey = rosterKey(asRead);
  const distances = candidates.map((candidate) =>
    keyDistance(readingKey, candidate.key),
  );

  const exact = candidates.findIndex(
    (candidate) => candidate.entry.gamertag === asRead,
  );
  if (exact !== -1) {
    const others = distances.filter((_, index) => index !== exact);
    return {
      status: 'EXACT',
      asRead,
      gamertagId: candidates[exact].entry.gamertagId,
      gamertag: candidates[exact].entry.gamertag,
      keyDistance: 0,
      runnerUpDistance: others.length === 0 ? null : Math.min(...others),
      textDistance: 0,
      errorTypes: [],
      unmatchedReason: null,
    };
  }

  // With one entry at the best distance, the second smallest distance is the
  // smallest among the other entries. With a tie, it equals the best.
  const sorted = [...distances].sort((left, right) => left - right);
  const best = sorted[0];
  const runnerUp = sorted[1] ?? null;
  const nearest = candidates.filter((_, index) => distances[index] === best);

  if (!nearest.some((candidate) => best <= editBudget(candidate.key))) {
    return unmatched(asRead, 'NO_CANDIDATE', best, runnerUp);
  }
  if (nearest.length > 1) {
    return unmatched(asRead, 'AMBIGUOUS', best, runnerUp);
  }
  if (runnerUp !== null && runnerUp < best + margin(best)) {
    return unmatched(asRead, 'AMBIGUOUS', best, runnerUp);
  }

  const { entry } = nearest[0];
  return {
    status: 'RESOLVED',
    asRead,
    gamertagId: entry.gamertagId,
    gamertag: entry.gamertag,
    keyDistance: best,
    runnerUpDistance: runnerUp,
    textDistance: keyDistance(asRead, entry.gamertag),
    errorTypes: errorTypesFor(asRead, entry.gamertag),
    unmatchedReason: null,
  };
}

/**
 * Applies the one-entry-per-game rule (§7.4): a `RESOLVED` row loses its
 * entry when another row is `EXACT` for it or another row is also `RESOLVED`
 * to it. Rows never move to another entry, and `EXACT` rows never change.
 */
function claimEntries(results: PlayerResolution[]): PlayerResolution[] {
  const exactIds = new Set<string>();
  const resolvedCounts = new Map<string, number>();
  for (const result of results) {
    if (result.gamertagId === null) continue;
    if (result.status === 'EXACT') exactIds.add(result.gamertagId);
    if (result.status === 'RESOLVED') {
      resolvedCounts.set(
        result.gamertagId,
        (resolvedCounts.get(result.gamertagId) ?? 0) + 1,
      );
    }
  }
  return results.map((result) =>
    result.status === 'RESOLVED' &&
    result.gamertagId !== null &&
    (exactIds.has(result.gamertagId) ||
      resolvedCounts.get(result.gamertagId)! > 1)
      ? unmatched(
          result.asRead,
          'ENTRY_CLAIMED',
          result.keyDistance,
          result.runnerUpDistance,
        )
      : result,
  );
}

function unmatched(
  asRead: string,
  reason: UnmatchedReason,
  keyDistance: number | null,
  runnerUpDistance: number | null,
): PlayerResolution {
  return {
    status: 'UNMATCHED',
    asRead,
    gamertagId: null,
    gamertag: null,
    keyDistance,
    runnerUpDistance,
    textDistance: null,
    errorTypes: [],
    unmatchedReason: reason,
  };
}
