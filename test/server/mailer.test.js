import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../server/config.js';
import { openDb } from '../../server/db.js';
import { createMailer } from '../../server/lib/mailer.js';

const quiet = { info() {}, error() {} };
const msg = { to: 'ada@example.com', subject: 'Verify your email', intro: 'Hi Ada', action: 'Verify email', link: 'https://app.test/#verify/abc' };

/* A Resend stand-in that records requests and answers with the given statuses in turn. */
function fakeResend(...statuses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const status = statuses.shift() ?? 200;
    return new Response(JSON.stringify(status === 200 ? { id: 'email_1' } : { message: `failed ${status}` }), { status });
  };
  return { calls, fetchImpl };
}
function setup(env, fetchImpl) {
  const db = openDb(':memory:');
  const config = loadConfig({ NODE_ENV: 'test', MAIL_FROM: 'Sudo Sapient <no-reply@sudosapient.test>', ...env });
  return { db, config, mailer: createMailer(db, config, quiet, fetchImpl) };
}
const row = db => db.get('SELECT sent_at, attempts, error FROM outbox');

describe('email through Resend', () => {
  it('sends queued mail to the Resend API with the key, sender and an idempotency key', async () => {
    const r = fakeResend(200);
    const { db, mailer, config } = setup({ RESEND_API_KEY: 're_test_123' }, r.fetchImpl);
    expect(mailer.configured).toBe(true);
    expect(config.exposeEmailLinks).toBe(false);
    mailer.queue(msg);
    await mailer.drain();
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0].url).toBe('https://api.resend.com/emails');
    expect(r.calls[0].headers.authorization).toBe('Bearer re_test_123');
    expect(r.calls[0].headers['idempotency-key']).toMatch(/^outbox-1-\d+$/);
    expect(r.calls[0].body).toMatchObject({ from: 'Sudo Sapient <no-reply@sudosapient.test>', to: ['ada@example.com'], subject: 'Verify your email' });
    expect(r.calls[0].body.text).toContain('https://app.test/#verify/abc');
    expect(r.calls[0].body.html).toContain('href="https://app.test/#verify/abc"');
    expect(row(db)).toMatchObject({ attempts: 1, error: null });
    expect(row(db).sent_at).toBeGreaterThan(0);
    await mailer.drain();
    expect(r.calls).toHaveLength(1);
  });

  it('retries rate limits and server errors with the same idempotency key', async () => {
    const r = fakeResend(429, 500, 200);
    const { db, mailer } = setup({ RESEND_API_KEY: 're_test_123' }, r.fetchImpl);
    mailer.queue(msg);
    await mailer.drain();
    expect(row(db)).toMatchObject({ sent_at: null, attempts: 1, error: 'Resend 429: failed 429' });
    await mailer.drain();
    await mailer.drain();
    expect(row(db).sent_at).toBeGreaterThan(0);
    expect(new Set(r.calls.map(c => c.headers['idempotency-key'])).size).toBe(1);
  });

  it('gives up straight away on errors a retry cannot fix, like an unverified sender domain', async () => {
    const r = fakeResend(403);
    const { db, mailer } = setup({ RESEND_API_KEY: 're_test_123' }, r.fetchImpl);
    mailer.queue(msg);
    await mailer.drain();
    await mailer.drain();
    expect(r.calls).toHaveLength(1);
    expect(row(db)).toMatchObject({ sent_at: null, attempts: 5, error: 'Resend 403: failed 403' });
  });

  it('without a key, nothing is sent and local flows get the link instead', async () => {
    const r = fakeResend();
    const { mailer, config } = setup({}, r.fetchImpl);
    expect(mailer.configured).toBe(false);
    expect(config.exposeEmailLinks).toBe(true);
    mailer.queue(msg);
    await mailer.drain();
    expect(r.calls).toHaveLength(0);
  });
});
