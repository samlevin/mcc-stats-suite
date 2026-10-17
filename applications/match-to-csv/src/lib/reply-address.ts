/**
 * The local part of the address `process-email` replies from; SSM supplies
 * the domain. The stack's `ses:SendEmail` grant allows only this `From`
 * address, so both read this constant.
 */
export const REPLY_LOCAL_PART = 'noreply';
