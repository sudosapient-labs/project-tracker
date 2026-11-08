/* The agent: a LangChain agent (createAgent, a LangGraph graph underneath) with the tracker tools,
   any read-only MCP tools (Sudopedia), and middleware for the per-channel prompt, confirmations,
   retries and a per-run tool budget.

   Conversations are LangGraph threads, one per Slack thread (or per DM per day), checkpointed in
   SQLite, so a follow-up mention in the same thread continues the conversation, and a change
   waiting for Confirm survives a restart: pressing the button resumes the saved graph.

   Confirmations use humanInTheLoopMiddleware in per-call mode. (Batched mode, the default, drops
   the other tool calls of the same model turn when one is rejected, leaving calls with no result;
   per-call resolves each on its own.) */
import { createAgent, dynamicSystemPromptMiddleware, humanInTheLoopMiddleware, initChatModel, modelRetryMiddleware, toolCallLimitMiddleware } from 'langchain';
import { Command } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { ChatAnthropic } from '@langchain/anthropic';
import { CONFIRM_POLICIES } from './config.js';
import { TRACKER_TOOLS, wouldBeAllowed } from './tools.js';
import { basePrompt, loadSkills, systemPrompt } from './prompt.js';

/* The chat model from a "provider:model" id, through the LLM proxy when one is configured.
   Anthropic models get adaptive thinking and an effort level; any other provider LangChain supports
   works through initChatModel (OpenAI-style providers reach the proxy at /v1). */
export async function chatModel({ id, effort, maxTokens, baseUrl, apiKey }) {
  const [provider, ...rest] = id.includes(':') ? id.split(':') : ['anthropic', id];
  const model = rest.join(':');
  if (provider === 'anthropic')
    return new ChatAnthropic({
      model,
      maxTokens,
      thinking: { type: 'adaptive' },
      outputConfig: { effort },
      ...(baseUrl ? { anthropicApiUrl: baseUrl } : {}),
      ...(apiKey ? { apiKey } : {}),
    });
  return initChatModel(model, {
    modelProvider: provider,
    maxTokens,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { configuration: { baseURL: `${baseUrl}/v1` } } : {}),
  });
}

const textOf = m => {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (m.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
};

/* What a run produced: the reply, the writes waiting for Confirm, and the tasks it touched. */
function outcome(result, ctx) {
  const pending = (result.__interrupt__ || [])
    .filter(i => i.value?.type === 'tool_approval')
    .map(i => ({ id: i.id, name: i.value.name, args: i.value.args, toolCallId: i.value.tool_call_id }));
  const last = [...(result.messages || [])].reverse().find(m => m.getType?.() === 'ai');
  return { text: pending.length ? '' : textOf(last).trim(), pending, touched: [...new Set(ctx.touched)] };
}

export async function createSudoAgent({ config, store, model, tools = [], checkpointer }) {
  const base = basePrompt({ name: config.name, skills: loadSkills() });
  const confirm = CONFIRM_POLICIES[config.confirm];
  const agent = createAgent({
    model: model || (await chatModel(config.model)),
    tools: [...TRACKER_TOOLS, ...tools],
    checkpointer: checkpointer || SqliteSaver.fromConnString(config.checkpoints),
    middleware: [
      dynamicSystemPromptMiddleware((_state, runtime) =>
        systemPrompt(base, {
          workspace: store.guidance('workspace'),
          channel: runtime.context?.slack?.channel ? store.guidance(runtime.context.slack.channel) : '',
        }),
      ),
      humanInTheLoopMiddleware({
        interruptMode: 'per_call',
        interruptOn: Object.fromEntries(
          confirm.map(name => [name, { allowedDecisions: ['approve', 'reject'], when: req => wouldBeAllowed(req.runtime.context, name, req.toolCall.args) }]),
        ),
      }),
      toolCallLimitMiddleware({ runLimit: 25 }),
      modelRetryMiddleware({ maxRetries: 2 }),
    ],
  });

  // A run that takes longer than this is cut off; the conversation then starts a fresh round.
  const RUN_TIMEOUT = 180_000;
  const cfg = (threadId, ctx) => ({ configurable: { thread_id: threadId }, context: ctx, recursionLimit: 60, signal: AbortSignal.timeout(RUN_TIMEOUT) });
  const waitingIn = async threadId => {
    const st = await agent.getState({ configurable: { thread_id: threadId } });
    return (st.tasks || []).flatMap(t => t.interrupts || []).filter(i => i.value?.type === 'tool_approval');
  };

  return {
    /* A new request in a conversation. The caller makes sure the conversation can take one (see
       `ready`): nothing waiting for Confirm, and no tool call left without a result. */
    async run({ threadId, message, ctx }) {
      const result = await agent.invoke({ messages: [{ role: 'user', content: message }] }, cfg(threadId, ctx));
      return outcome(result, ctx);
    },
    /* The person pressed Confirm (approve) or Cancel on a card showing the interrupts `ids`. Acts
       only if exactly those are still waiting; otherwise the card is out of date ({ stale: true }). */
    async resume({ threadId, ids, approve, ctx }) {
      const waiting = await waitingIn(threadId);
      const now = new Set(waiting.map(i => i.id));
      if (!ids.length || ids.length !== now.size || !ids.every(id => now.has(id))) return { stale: true };
      const result = await agent.invoke(new Command({ resume: decide(waiting, approve, 'They pressed Cancel.') }), cfg(threadId, ctx));
      return outcome(result, ctx);
    },
    /* Interrupts the saved graph is paused on, if any. */
    waiting: waitingIn,
    /* Whether a new message can go into this conversation: nothing waiting for Confirm, and every
       tool call the model made has its result. (A run cut off mid-step, by a timeout or a restart,
       can leave a call without one, which the model API refuses on every later request.) */
    async ready(threadId) {
      const st = await agent.getState({ configurable: { thread_id: threadId } });
      if ((st.tasks || []).some(t => (t.interrupts || []).length) || (st.next || []).length) return false;
      const messages = st.values?.messages || [];
      const answered = new Set(messages.filter(m => m.getType?.() === 'tool').map(m => m.tool_call_id));
      return messages.every(m => m.getType?.() !== 'ai' || (m.tool_calls || []).every(c => answered.has(c.id)));
    },
    graph: agent,
  };
}

const decide = (interrupts, approve, why) => Object.fromEntries(interrupts.map(i => [i.id, approve ? { type: 'approve' } : { type: 'reject', message: why }]));
