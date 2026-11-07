#!/usr/bin/env node
/* Sets up a staging tracker for testing the bot, and is safe to run again: an Owner, a Member and a
   Guest, three projects (WEB open to the workspace, SEC private, OPS with the Guest on it as "Can
   comment"), and the "Sudo Tracker" bot member (on SEC) with a write key.

     STAGING_URL=https://… STAGING_SETUP_TOKEN=… STAGING_OWNER_EMAIL=… STAGING_OWNER_PASSWORD=… \
       node packages/slack-bot/scripts/seed-staging.js <file for the bot key>

   Meant for a staging deployment with REQUIRE_EMAIL_VERIFICATION=false and no Resend key, so test
   accounts need no mailbox. The bot key is written, owner-only, to the file given (never printed);
   a new key is made each run, so earlier ones are revoked. Refuses to run against production. */
import fs from 'node:fs';

const url = String(process.env.STAGING_URL || '').replace(/\/+$/, '');
const { STAGING_SETUP_TOKEN: setup, STAGING_OWNER_EMAIL: ownerEmail, STAGING_OWNER_PASSWORD: password } = process.env;
const out = process.argv[2];
if (!url || !ownerEmail || !password || !out) {
  console.error(
    'Set STAGING_URL, STAGING_OWNER_EMAIL, STAGING_OWNER_PASSWORD (and STAGING_SETUP_TOKEN for a new deployment), and give a file for the bot key.',
  );
  process.exit(1);
}
if (/production/i.test(url)) {
  console.error(`Refusing to seed ${url}: this script is for staging only.`);
  process.exit(1);
}

/* A browser-like client: keeps cookies and sends the CSRF header. */
function session() {
  const jar = new Map();
  return async function req(method, path, body) {
    const res = await fetch(url + path, {
      method,
      headers: {
        'x-requested-with': 'sudo-sapient',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(jar.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    return { status: res.status, body: data };
  };
}

async function signIn(req, email, name, extra = {}) {
  let r = await req('POST', '/api/auth/login', { email, password });
  if (r.status === 200) return r;
  r = await req('POST', '/api/auth/signup', { name, email, password, ...extra });
  if (r.status !== 201) throw new Error(`Couldn't sign up ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r;
}

const put = (c, v) => ({ c, id: v.id, k: 'put', v });
const project = (id, key, name, extra = {}) => ({
  id,
  key,
  name,
  icon: 'globe',
  color: 'indigo',
  status: 'active',
  team: '',
  lead: null,
  members: [],
  desc: '',
  milestones: [],
  ...extra,
});
const synced = async (req, ops) => {
  const r = await req('POST', '/api/sync', { ops });
  if (r.status !== 200) throw new Error(`sync failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};

const owner = session();
await signIn(owner, ownerEmail, 'Staging Owner', setup ? { setup } : {});
const boot = async () => (await owner('GET', '/api/bootstrap')).body.data;

// People: a Member and a Guest, through the workspace's join link (no email needed).
const domain = ownerEmail.split('@')[1];
const people = [
  { email: `staging-bea@${domain}`, name: 'Bea Member', role: 'Member' },
  { email: `staging-gus@${domain}`, name: 'Gus Guest', role: 'Guest' },
];
let data = await boot();
for (const p of people) {
  if (data.members.some(m => m.email === p.email)) continue;
  const { link } = (await owner('POST', '/api/workspace/invite-link')).body;
  await signIn(session(), p.email, p.name, { join: link.split('#join/')[1] });
}
data = await boot();
const byEmail = e => data.members.find(m => m.email === e);
const gus = byEmail(`staging-gus@${domain}`);
if (gus.role !== 'Guest') await synced(owner, [put('members', { ...gus, role: 'Guest' })]);

// Projects.
const want = [
  project('pweb', 'WEB', 'Website'),
  project('psec', 'SEC', 'Security', { private: true }),
  project('pops', 'OPS', 'Operations', { members: [gus.id], perms: { [gus.id]: 'Can comment' } }),
];
const missing = want.filter(w => !data.projects.some(p => p.key === w.key));
if (missing.length)
  await synced(
    owner,
    missing.map(p => put('projects', p)),
  );

// The bot, on SEC, with a fresh write key.
let bots = (await owner('GET', '/api/bots')).body;
let botMember = bots.find(b => b.name === 'Sudo Tracker');
if (!botMember) {
  const r = await owner('POST', '/api/bots', { name: 'Sudo Tracker', role: 'Member', projects: ['psec'] });
  if (r.status !== 201) throw new Error(`Couldn't create the bot: ${r.status} ${JSON.stringify(r.body)}`);
  botMember = r.body;
}
for (const k of botMember.keys || []) await owner('DELETE', `/api/bots/${botMember.id}/keys/${k.id}`);
const k = await owner('POST', `/api/bots/${botMember.id}/keys`, { name: 'Slack', scope: 'write', expiresInDays: null, password });
if (k.status !== 201) throw new Error(`Couldn't make the bot's key: ${k.status} ${JSON.stringify(k.body)}`);
fs.writeFileSync(out, k.body.token + '\n', { mode: 0o600 });
fs.chmodSync(out, 0o600);

data = await boot();
console.log(
  `Seeded ${url}: ${data.members.map(m => `${m.name} (${m.role})`).join(', ')}; projects ${data.projects.map(p => p.key).join(', ')}. Bot key written to ${out}.`,
);
