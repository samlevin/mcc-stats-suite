/**
 * `@mcc/roster`: the pure gamertag matcher, roster fold and hash of spec 1.2.
 * It performs no I/O, reads no clock and holds no state, and imports only
 * `@mcc/contracts` types and Node's `crypto`.
 */
export { keyDistance, rosterKey } from './key';
export {
  MAX_READING_LENGTH,
  ROSTER_MATCHER_VERSION,
  errorTypesFor,
  resolvePlayers,
} from './resolve';
export {
  EMPTY_ROSTER,
  RosterIntegrityError,
  activeEntries,
  checkChange,
  foldRoster,
  rosterSha256,
} from './changes';
export type {
  AcceptedRosterChange,
  Roster,
  RosterChangeRequest,
  RosterEntryState,
  RosterEntryStatus,
  RosterRefusal,
  RosterRefusalCode,
} from './changes';
