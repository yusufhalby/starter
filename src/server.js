const crypto = require('crypto');
const express = require('express');
const { loadDotEnv, loadConfig } = require('./config');
const { isValidSignature } = require('./signature');
const { createStore } = require('./store');
const { createProcessor } = require('./handler');
const { createEmailSender } = require('./email');
const { createWhatsAppSender } = require('./whatsapp');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createApp({ config, store, processor, log = console }) {
  const app = express();
  app.disable('x-powered-by');

  // Background work started after Meta has been answered; awaited on shutdown and in tests.
  const inflight = new Set();
  const track = (promise) => {
    const p = promise.catch((err) => log.error('[webhook] processing error:', err));
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  };
  app.locals.drain = () => Promise.allSettled([...inflight]);

  // Meta webhook verification: echo hub.challenge when the verify token matches.
  app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (
      mode === 'subscribe' &&
      typeof token === 'string' &&
      typeof challenge === 'string' &&
      safeEqual(token, config.verifyToken)
    ) {
      return res.status(200).set('X-Content-Type-Options', 'nosniff').type('text/plain').send(challenge);
    }
    return res.sendStatus(403);
  });

  // Incoming WhatsApp events. Keep the raw bytes: the signature is computed over them.
  app.post('/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    if (!isValidSignature(config.appSecret, req.body, req.get('x-hub-signature-256'))) {
      return res.sendStatus(401);
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.sendStatus(400);
    }

    // Claim each message id atomically BEFORE answering Meta. A claimed id is never processed again,
    // so Meta retries can't produce a second email.
    let claimError = null;
    for (const item of processor.extractMessages(payload)) {
      let claimed;
      try {
        claimed = await store.claim(item.message.id);
      } catch (err) {
        claimError = err;
        break;
      }
      if (claimed) track(processor.processMessage(item));
      else log.log(`[webhook] duplicate delivery of ${item.message.id} ignored`);
    }

    if (claimError) {
      // Dedupe store unavailable: ask Meta to retry later. Already-claimed messages are skipped on retry.
      log.error('[store] claim failed:', claimError.message);
      return res.sendStatus(500);
    }
    // Answer quickly. Email and WhatsApp work continues in the background.
    return res.sendStatus(200);
  });

  app.get('/health', (req, res) => res.json({ ok: true }));

  return app;
}

async function main() {
  loadDotEnv();
  const env = { ...process.env };
  if (process.argv.includes('--dry-run')) env.DRY_RUN = 'true';
  const config = loadConfig(env);

  const store = createStore(config);
  await store.init();
  const processor = createProcessor({
    config,
    store,
    sendEmail: createEmailSender(config),
    sendWhatsApp: createWhatsAppSender(config),
  });
  const app = createApp({ config, store, processor });

  const server = app.listen(config.port, () => {
    console.log(`Listening on ${config.port}${config.dryRun ? ' (DRY RUN: no emails or WhatsApp messages are sent)' : ''}`);
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal} received, finishing in-flight work...`);
    server.close();
    await app.locals.drain();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Startup failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { createApp };
