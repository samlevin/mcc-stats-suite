/**
 * The local part of the address `process-email` replies from and
 * `email-gamertag-csvs` sends results from; SSM supplies the domain. The
 * stack's `ses:SendEmail` grants allow only this `From` address, so they read
 * this constant too.
 */
export const REPLY_LOCAL_PART = 'noreply';
