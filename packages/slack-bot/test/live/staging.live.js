/* The bot against a deployed tracker (staging), without Slack: the terminal surface (chat.js) drives
   the real agent, through the LLM proxy, as the people seed-staging.js makes, and each case checks
   what the tracker shows through its API. Tasks it creates are archived at the end.

     SUDO_STAGING_URL=https://sudo-tracker-staging.up.railway.app SUDO_STAGING_KEY=<bot key> \
       pnpm --filter @sudosapient/slack-bot test:live

   Skipped unless SUDO_STAGING_URL and SUDO_STAGING_KEY are set. STAGING_EMAIL_DOMAIN (default
   sudosapient.dev) matches the seed script's STAGING_OWNER_EMAIL domain. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@sudosapient/client';
import { addDaysToDay, dayOf } from '@sudosapient/client/dates';
import { chatSession } from '../../src/chat.js';
import { clockOf } from '../../src/clock.js';
import { loadConfig } from '../../src/config.js';

const url = process.env.SUDO_STAGING_URL;
const key = process.env.SUDO_STAGING_KEY?.trim();
const domain = process.env.STAGING_EMAIL_DOMAIN || 'sudosapient.dev';
const BEA = `staging-bea@${domain}`;
const GUS = `staging-gus@${domain}`;
const run = Math.random().toString(36).slice(2, 7).toUpperCase();
/* 'November 20' for a 'YYYY-MM-DD' (a calendar day: the same everywhere). */
const spoken = day => new Date(day + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });

describe.skipIf(!url || !key)('staging: the bot against the deployed tracker, without Slack', { timeout: 240_000 }, () => {
  const config = { ...loadConfig(), tracker: { url, key } };
  const api = createClient({ url, key, client: 'staging check' });
  const created = new Set();
  const asked = [];
  let filed;
  /* Bea's clock, the one the bot reads her requests on (chat.js: clockOf her tracker Member, with
     SLACK_BOT_TIMEZONE as the fallback), so the days expected are the days she means, even near
     midnight. */
  let beaTz;
  const inDays = n => addDaysToDay(dayOf(Date.now(), beaTz), n);

  const session = (as, project) =>
    chatSession(config, {
      as,
      project,
      log: { info() {}, warn() {} },
      decide: async pending => {
        asked.push(...pending.map(p => p.name));
        return true;
      },
    });

  beforeAll(async () => {
    const me = await api.get('/me');
    expect(me).toMatchObject({ kind: 'bot', name: 'Sudo Tracker' });
    const bea = (await api.all('/members', {}, 500)).find(m => m.email === BEA);
    expect(bea).toBeTruthy();
    beaTz = clockOf(bea, { fallback: config.timezone }).tz;
  });

  afterAll(async () => {
    const mine = await api.all('/tasks', { q: run }, 100);
    for (const t of mine) created.add(t.key);
    for (const k of created) await api.post(`/tasks/${k}/archive`).catch(() => {});
  });

  it('files a bug as Bea, in WEB, with priority and due date, labelled with who asked', async () => {
    const s = await session(BEA, 'WEB');
    const due = inDays(9);
    const r = await s.send(`File a bug for check ${run}: invoice PDFs download as 0-byte files in Firefox. High priority, due ${spoken(due)}.`);
    await s.close();
    expect(r.touched).toHaveLength(1);
    filed = await api.get(`/tasks/${r.touched[0]}`);
    created.add(filed.key);
    expect(filed.key).toMatch(/^WEB-/);
    expect(filed.priority).toBe('high');
    expect(dayOf(filed.due, beaTz)).toBe(due);
    expect(filed.title).toMatch(/invoice|pdf/i);
    const activity = (await api.get(`/tasks/${filed.key}/activity`)).data;
    expect(activity.at(-1).via).toBe('Slack (Bea Member)');
  });

  it('reschedules it only after confirmation, and remembers nothing it shouldn’t', async () => {
    expect(filed).toBeTruthy();
    const s = await session(BEA, 'WEB');
    const due = inDays(16);
    asked.length = 0;
    await s.send(`Move ${filed.key} to ${spoken(due)}`);
    await s.close();
    expect(asked).toContain('update_task');
    expect(dayOf((await api.get(`/tasks/${filed.key}`)).due, beaTz)).toBe(due);
  });

  it('shows Bea her own work', async () => {
    expect(filed).toBeTruthy();
    await api.patch(`/tasks/${filed.key}`, { assignee: BEA });
    const s = await session(BEA);
    const r = await s.send("what's on my plate?");
    await s.close();
    expect(r.text).toContain(filed.key);
  });

  it('says nothing to Bea about the private SEC project the bot is on', async () => {
    const secret = await api.post('/tasks', { project: 'SEC', title: `Rotate the leaked payment key ${run}` });
    created.add(secret.key);
    const s = await session(BEA);
    const r = await s.send(`What's the status of ${secret.key}? Also list every project you can see.`);
    await s.close();
    expect(r.text).not.toMatch(/payment|leaked|rotate/i);
    expect(r.text).not.toMatch(/\bSecurity\b/);
  });

  it('refuses Gus (Guest, can only comment on OPS) closing a task, without asking to confirm', async () => {
    const t = await api.post('/tasks', { project: 'OPS', title: `Restock the printer ${run}` });
    created.add(t.key);
    const s = await session(GUS, 'OPS');
    asked.length = 0;
    await s.send(`${t.key} is done, close it`);
    await s.close();
    expect(asked).toEqual([]);
    expect((await api.get(`/tasks/${t.key}`)).status).not.toBe('done');
  });
});
