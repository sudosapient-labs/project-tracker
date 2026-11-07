/* What the agent reads from Slack: the thread (or DM) so far as a plain transcript with people's
   names, the channel, and a permalink to cite in tasks. Lookups of names and channels are cached
   for the life of the process. */

const MAX_MESSAGES = 60;
const MAX_CHARS = 2000;

export function slackContext(slack, { botUserId, botName }) {
  const names = new Map();
  const channels = new Map();

  async function nameOf(user) {
    if (!user) return 'someone';
    if (user === botUserId) return botName;
    if (!names.has(user))
      names.set(
        user,
        slack.users
          .info({ user })
          .then(r => r.user?.real_name || r.user?.profile?.display_name || r.user?.name || user)
          .catch(() => user),
      );
    return names.get(user);
  }

  /* <@U123> → @Ada, <https://x|text> → text (https://x), and the bot's own mention dropped. */
  async function plain(text) {
    let out = String(text || '');
    const ids = [...new Set([...out.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)].map(m => m[1]))];
    for (const id of ids) out = out.replaceAll(new RegExp(`<@${id}(?:\\|[^>]*)?>`, 'g'), id === botUserId ? '' : `@${await nameOf(id)}`);
    return out
      .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
      .replace(/<(https?:\/\/[^>]+)>/g, '$1')
      .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
  }

  return {
    nameOf,
    plain,

    async channel(id) {
      if (!channels.has(id))
        channels.set(
          id,
          slack.conversations
            .info({ channel: id })
            .then(r => ({ id, name: r.channel?.name || '', private: !!r.channel?.is_private, dm: !!r.channel?.is_im }))
            .catch(() => ({ id, name: '', private: true, dm: id.startsWith('D') })),
        );
      return channels.get(id);
    },

    async permalink(channel, ts) {
      try {
        return (await slack.chat.getPermalink({ channel, message_ts: ts })).permalink || '';
      } catch {
        return '';
      }
    },

    /* The thread's messages after `since` (all when null), oldest first, except the messages in
       `except` (the request itself, which the agent gets separately, and the bot's placeholder).
       Returns { transcript }. */
    async thread(channel, threadTs, { since = null, except = [] } = {}) {
      let messages = [];
      try {
        const r = await slack.conversations.replies({ channel, ts: threadTs, limit: 200 });
        messages = r.messages || [];
      } catch {
        return { transcript: '' };
      }
      const fresh = messages.filter(
        m =>
          (!since || Number(m.ts) > Number(since)) && !except.includes(m.ts) && !(m.subtype && m.subtype !== 'bot_message' && m.subtype !== 'thread_broadcast'),
      );
      const lines = [];
      for (const m of fresh.slice(-MAX_MESSAGES)) {
        const who = m.bot_id && m.user !== botUserId ? m.username || m.bot_profile?.name || 'a bot' : await nameOf(m.user);
        let text = await plain(m.text);
        if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS) + '…';
        const files = (m.files || []).map(f => `[file: ${f.name || f.title || 'attachment'}]`).join(' ');
        lines.push(`${who}: ${[text, files].filter(Boolean).join(' ')}`);
      }
      if (fresh.length > MAX_MESSAGES) lines.unshift(`(${fresh.length - MAX_MESSAGES} earlier messages not shown)`);
      return { transcript: lines.join('\n') };
    },
  };
}
