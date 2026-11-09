/* Whose clock: starts, dues and times are read and shown on the person's clock, the time zone the
   server reads their dates in (`timeZone` on /me/preferences: their own, else the workspace's, else
   UTC). This computer's clock (TZ overrides it) only when the server is too old to say or can't be
   asked. The rules for the values are @sudosapient/client/dates'. --json output keeps the API's
   values (times in UTC). */
import { label, modernZone, validZone } from '@sudosapient/client/dates';

/* This computer's zone: only the fallback. */
export const localTz = () => modernZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
/* The person's zone from the server; `api` makes the client (it throws when not logged in). */
export async function personTz(api) {
  try {
    return validZone((await api().get('/me/preferences'))?.timeZone) || localTz();
  } catch {
    return localTz();
  }
}
/* '2026-11-20', or '2026-11-20 17:00' for a time of day, on `tz`'s clock. */
export const showDate = (v, tz) => (v ? label(v, tz) : '');
