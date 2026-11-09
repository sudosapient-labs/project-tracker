/* Every tracker client the bot makes: the bot's key, a label for Activity ("via Slack (Ada)"), and
   the time zone of the person it's for (clock.js; config.timezone, the fallback, when none is
   given), which the tools, including the MCP ones, read dates and times on. One client per request,
   so two people's requests running at once never share a clock. Dates follow
   @sudosapient/client/dates. */
import { createClient } from '@sudosapient/client';
import { useTimeZone } from '@sudosapient/mcp/tools';

export const trackerClient = (config, { client = 'Slack', fetch, tz } = {}) =>
  useTimeZone(createClient({ url: config.tracker.url, key: config.tracker.key, client, ...(fetch ? { fetch } : {}) }), tz || config.timezone);
