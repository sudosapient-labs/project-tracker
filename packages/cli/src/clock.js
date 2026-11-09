/* Starts, dues and times are read and shown on this computer's clock (TZ overrides it); the rules
   for them are @sudosapient/client/dates'. --json output keeps the API's values (times in UTC). */
import { label } from '@sudosapient/client/dates';

export const localTz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
/* '2026-11-20', or '2026-11-20 17:00' for a time of day. */
export const showDate = v => (v ? label(v, localTz()) : '');
