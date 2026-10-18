/**
 * `@mcc/recipients`: the CSV recipient list fold, hash and change check of
 * spec 1.1 §4.5. It performs no I/O, reads no clock and holds no state, and
 * imports only `@mcc/contracts` types and Node's `crypto`.
 */
export {
  EMPTY_RECIPIENTS,
  MAX_ADDRESS_LENGTH,
  RecipientsIntegrityError,
  activeRecipients,
  checkRecipientChange,
  foldRecipients,
  normalizeAddress,
  recipientsSha256,
} from './recipients';
export type {
  AcceptedRecipientChange,
  RecipientChangeRequest,
  RecipientEntryState,
  RecipientEntryStatus,
  RecipientList,
  RecipientRefusal,
  RecipientRefusalCode,
} from './recipients';
