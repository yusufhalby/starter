const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../src/server');
const { createProcessor, extractEmail } = require('../src/handler');
const { MemoryStore } = require('../src/store');
const { sign } = require('../src/signature');
const { loadConfig } = require('../src/config');

const SAMPLE = fs.readFileSync(path.join(__dirname, '..', 'samples', 'incoming-message.json'));
const silentLog = { log() {}, warn() {}, error() {} };

const config = loadConfig({
  META_VERIFY_TOKEN: 'verify-me',
  META_APP_SECRET: 'test-secret',
  WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
  DRY_RUN: 'true',
});

let ctx;

async function setup({ emailFails = false, whatsappFails = false } = {}) {
  const emails = [];
  const replies = [];
  const store = new MemoryStore();
  const processor = createProcessor({
    config,
    store,
    log: silentLog,
    sendEmail: async (payload, opts) => {
      emails.push({ payload, opts });
      if (emailFails) throw new Error('Resend error: validation_error: domain not verified');
      return { id: `email-${emails.length}` };
    },
    sendWhatsApp: async (to, body) => {
      replies.push({ to, body });
      if (whatsappFails) throw new Error('WhatsApp send failed (401)');
    },
  });
  const app = createApp({ config, store, processor, log: silentLog });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  ctx = { app, server, store, emails, replies, base };
  return ctx;
}

function post(body, signature = sign('test-secret', body)) {
  const headers = { 'Content-Type': 'application/json' };
  if (signature) headers['X-Hub-Signature-256'] = signature;
  return fetch(`${ctx.base}/webhook`, { method: 'POST', headers, body });
}

beforeEach(() => setup());
afterEach(() => new Promise((r) => ctx.server.close(r)));

test('GET /webhook echoes hub.challenge for the right token', async () => {
  const ok = await fetch(`${ctx.base}/webhook?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');

  const bad = await fetch(`${ctx.base}/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`);
  assert.equal(bad.status, 403);
  const missing = await fetch(`${ctx.base}/webhook?hub.mode=subscribe&hub.challenge=1`);
  assert.equal(missing.status, 403);
});

test('rejects unsigned, wrongly signed and tampered requests', async () => {
  assert.equal((await post(SAMPLE, null)).status, 401);
  assert.equal((await post(SAMPLE, sign('other-secret', SAMPLE))).status, 401);
  assert.equal((await post(Buffer.concat([SAMPLE, Buffer.from(' ')]), sign('test-secret', SAMPLE))).status, 401);
  await ctx.app.locals.drain();
  assert.equal(ctx.emails.length, 0);
});

test('signed sample sends exactly one confirmation email', async () => {
  const res = await post(SAMPLE);
  assert.equal(res.status, 200);
  await ctx.app.locals.drain();

  assert.equal(ctx.emails.length, 1);
  const { payload, opts } = ctx.emails[0];
  assert.equal(payload.to, 'fatima@example.com');
  assert.match(payload.html, /Dear Fatima Ali/);
  assert.equal(opts.idempotencyKey, 'wa-confirm/wamid.HBgLOTczMzYwMDAwMDAVAgARGBI0QTdGRjU2QzNEOEU5QjFBNjAA');
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0].body, /confirmation email has been sent/);
  assert.equal((await ctx.store.get(JSON.parse(SAMPLE).entry[0].changes[0].value.messages[0].id)).status, 'email_sent');
});

test('the same message delivered repeatedly (sequential and concurrent) is emailed once', async () => {
  await Promise.all([post(SAMPLE), post(SAMPLE), post(SAMPLE)]);
  await post(SAMPLE);
  await ctx.app.locals.drain();
  assert.equal(ctx.emails.length, 1);
});

test('WhatsApp reply failure does not cause a second email on retry', async () => {
  await new Promise((r) => ctx.server.close(r));
  await setup({ whatsappFails: true });
  assert.equal((await post(SAMPLE)).status, 200);
  await ctx.app.locals.drain();
  assert.equal((await post(SAMPLE)).status, 200);
  await ctx.app.locals.drain();
  assert.equal(ctx.emails.length, 1);
});

test('Resend error is not reported to the client as success', async () => {
  await new Promise((r) => ctx.server.close(r));
  await setup({ emailFails: true });
  await post(SAMPLE);
  await ctx.app.locals.drain();
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0].body, /could not send/);
  const id = JSON.parse(SAMPLE).entry[0].changes[0].value.messages[0].id;
  assert.equal((await ctx.store.get(id)).status, 'email_failed');
});

test('user-controlled name and text are HTML-escaped', async () => {
  const payload = JSON.parse(SAMPLE);
  const value = payload.entry[0].changes[0].value;
  value.contacts[0].profile.name = '<img src=x onerror=alert(1)>';
  value.messages[0].text.body = 'mail me at a@b.com <a href="http://evil">click</a>';
  const body = Buffer.from(JSON.stringify(payload));
  await post(body);
  await ctx.app.locals.drain();
  const { html } = ctx.emails[0].payload;
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<a href'));
  assert.match(html, /&lt;img src=x/);
});

test('every message in a batched payload is processed; foreign phone ids and statuses ignored', async () => {
  const payload = JSON.parse(SAMPLE);
  const change = payload.entry[0].changes[0];
  const second = { ...change.value.messages[0], id: 'wamid.second', text: { body: 'x@y.org' } };
  change.value.messages.push(second);
  payload.entry.push({
    id: '2',
    changes: [{ field: 'messages', value: { ...change.value, metadata: { phone_number_id: 'someone-else' } } }],
  });
  payload.entry.push({
    id: '3',
    changes: [{ field: 'messages', value: { metadata: change.value.metadata, statuses: [{ id: 'wamid.s', status: 'read' }] } }],
  });
  await post(Buffer.from(JSON.stringify(payload)));
  await ctx.app.locals.drain();
  assert.deepEqual(ctx.emails.map((e) => e.payload.to).sort(), ['fatima@example.com', 'x@y.org']);
});

test('extractEmail drops sentence punctuation and lowercases', () => {
  assert.equal(extractEmail('My email is Fatima@Example.com.'), 'fatima@example.com');
  assert.equal(extractEmail('a.b+c@mail.co.uk, thanks'), 'a.b+c@mail.co.uk');
  assert.equal(extractEmail('no email here'), null);
});

test('config fails fast on missing secrets and requires DATABASE_URL on Render', () => {
  assert.throws(() => loadConfig({}), /META_VERIFY_TOKEN/);
  const base = {
    META_VERIFY_TOKEN: 'a', META_APP_SECRET: 'b', WHATSAPP_PHONE_NUMBER_ID: 'c',
    META_ACCESS_TOKEN: 'd', RESEND_API_KEY: 'e', RESEND_FROM: 'f',
  };
  assert.doesNotThrow(() => loadConfig(base));
  assert.throws(() => loadConfig({ ...base, RENDER: 'true' }), /DATABASE_URL/);
  assert.equal(loadConfig({ ...base, PORT: '10000' }).port, 10000);
});
