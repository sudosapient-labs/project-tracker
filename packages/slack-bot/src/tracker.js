/* Every tracker client the bot makes: the bot's key, a label for Activity ("via Slack (Ada)"), and
   the team's time zone (SLACK_BOT_TIMEZONE), which the tools, including the MCP ones, read dates
   and times on. Dates follow @sudosapient/client/dates. */
import { createClient } from '@sudosapient/client';
import { useTimeZone } from '@sudosapient/mcp/tools';

export const trackerClient = (config, { client = 'Slack', fetch } = {}) =>
  useTimeZone(createClient({ url: config.tracker.url, key: config.tracker.key, client, ...(fetch ? { fetch } : {}) }), config.timezone);
