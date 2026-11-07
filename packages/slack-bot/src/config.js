/* Environment → config for Sudo Tracker. Every variable is listed in the README. Secrets (Slack
   tokens, the tracker bot key, the model provider's key) come only from the environment. */
import path from 'node:path';

const bool = (v, d = false) => (v == null || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));
const list = v =>
  String(v || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

/* Which tracker writes wait for a Confirm button. `edits` (default): changes to tasks that already
   exist (status, fields, assignee, completion); creating tasks, commenting and linking a thread run
   straight away. `all`: every write. `none`: nothing waits. */
export const CONFIRM_POLICIES = {
  none: [],
  edits: ['update_task', 'complete_task', 'assign'],
  all: ['create_task', 'update_task', 'complete_task', 'assign', 'comment', 'link_thread'],
};

export function loadConfig(env = process.env) {
  const dataDir = env.SLACK_BOT_DATA_DIR || path.resolve('data');
  const confirm = env.SLACK_BOT_CONFIRM || 'edits';
  if (!CONFIRM_POLICIES[confirm]) throw new Error(`SLACK_BOT_CONFIRM is one of ${Object.keys(CONFIRM_POLICIES).join(', ')}.`);
  let mcpServers = {};
  if (env.SLACK_BOT_MCP_SERVERS) {
    try {
      mcpServers = JSON.parse(env.SLACK_BOT_MCP_SERVERS);
    } catch {
      throw new Error('SLACK_BOT_MCP_SERVERS must be JSON, e.g. {"sudopedia":{"url":"http://100.x.y.z:8765/mcp"}}');
    }
  }
  return {
    name: env.SLACK_BOT_NAME || 'Sudo Tracker',
    slack: {
      botToken: env.SLACK_BOT_TOKEN || '',
      appToken: env.SLACK_APP_TOKEN || '',
      signingSecret: env.SLACK_SIGNING_SECRET || '',
      // Socket Mode needs no public URL (the app dials out to Slack), which suits a tailnet host.
      socketMode: bool(env.SLACK_SOCKET_MODE, true),
      port: Number(env.PORT || 3000),
      host: env.HOST || '127.0.0.1',
      // In Socket Mode, PORT (as a host like Railway sets it) serves only GET /health.
      healthPort: env.PORT ? Number(env.PORT) : null,
      healthHost: env.HOST || '0.0.0.0',
    },
    tracker: {
      url: (env.SUDO_URL || '').replace(/\/+$/, ''),
      key: env.SUDO_API_KEY || '',
    },
    model: {
      // A LangChain "provider:model" string; anything initChatModel understands.
      id: env.SLACK_BOT_MODEL || 'anthropic:claude-opus-5-5',
      effort: env.SLACK_BOT_EFFORT || 'medium',
      maxTokens: Number(env.SLACK_BOT_MAX_TOKENS || 16000),
      // Model calls go through Sudo Sapient's LLM proxy (LLM_PROXY_*), which serves the Anthropic
      // API at its root and the OpenAI one at /v1. SLACK_BOT_LLM_* overrides it; the provider's own
      // variables (ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY) are the last resort.
      baseUrl: (env.SLACK_BOT_LLM_BASE_URL || env.LLM_PROXY_BASE_URL || '').replace(/\/+$/, ''),
      apiKey: env.SLACK_BOT_LLM_API_KEY || env.LLM_PROXY_API_KEY || '',
    },
    // Read-only knowledge sources over MCP (Sudopedia first). Name → { url, headers?, tools? }.
    mcpServers,
    confirm,
    timezone: env.SLACK_BOT_TIMEZONE || 'Asia/Kolkata',
    // Tracker task links (APP_URL/#task/WEB-12) are unfurled only for these hosts; default: SUDO_URL's.
    unfurlHosts: list(env.SLACK_BOT_UNFURL_HOSTS),
    db: path.join(dataDir, 'slack-bot.db'),
    checkpoints: path.join(dataDir, 'slack-bot-checkpoints.db'),
    dataDir,
  };
}

/* What the bot can't run without. `surface`: 'slack' (the default) or 'chat' (the terminal, no Slack). */
export function assertReady(cfg, { surface = 'slack' } = {}) {
  const missing = [];
  if (surface === 'chat') {
    if (!cfg.tracker.url) missing.push('SUDO_URL');
    if (!cfg.tracker.key) missing.push('SUDO_API_KEY');
    if (missing.length) throw new Error(`Set ${missing.join(', ')} (see packages/slack-bot/README.md).`);
    return;
  }
  if (!cfg.slack.botToken) missing.push('SLACK_BOT_TOKEN');
  if (cfg.slack.socketMode && !cfg.slack.appToken) missing.push('SLACK_APP_TOKEN');
  if (!cfg.slack.socketMode && !cfg.slack.signingSecret) missing.push('SLACK_SIGNING_SECRET');
  if (!cfg.tracker.url) missing.push('SUDO_URL');
  if (!cfg.tracker.key) missing.push('SUDO_API_KEY');
  if (missing.length) throw new Error(`Set ${missing.join(', ')} (see packages/slack-bot/README.md).`);
}
