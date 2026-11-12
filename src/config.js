const path = require('path');

// Load .env for local runs. Variables already set in the environment (e.g. by Render) are NOT overridden.
// process.loadEnvFile exists only on Node >= 20.12 (and 21.7+); older versions fall back to the dotenv package.
function loadDotEnv(file = path.join(__dirname, '..', '.env')) {
  if (typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return;
  }
  const result = require('dotenv').config({ path: file, override: false });
  if (result.error && result.error.code !== 'ENOENT') throw result.error;
}

const DEFAULT_FROM = 'Top Delmon <onboarding@resend.dev>';

function loadConfig(env = process.env, log = console) {
  const dryRun = env.DRY_RUN === 'true';
  const onRender = Boolean(env.RENDER);
  const has = (k) => typeof env[k] === 'string' && env[k].trim() !== '';

  // Only the two values needed to talk to Meta securely are mandatory. Missing or fake delivery credentials
  // (Resend / WhatsApp) don't stop the service; each send fails and is logged instead.
  const required = ['META_VERIFY_TOKEN', 'META_APP_SECRET'];
  if (onRender && !dryRun) {
    // In production everything must be configured, and dedupe must survive restarts (Postgres).
    required.push('WHATSAPP_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN', 'RESEND_API_KEY', 'RESEND_FROM', 'DATABASE_URL');
  }
  const missing = required.filter((k) => !has(k));
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  if (!dryRun) {
    for (const k of ['WHATSAPP_PHONE_NUMBER_ID', 'META_ACCESS_TOKEN', 'RESEND_API_KEY']) {
      if (!has(k)) log.warn(`[config] ${k} is not set: the related sends will fail and be logged.`);
    }
    if (!has('RESEND_FROM')) {
      log.warn(`[config] RESEND_FROM not set, using ${DEFAULT_FROM} (Resend only delivers this to your own account).`);
    }
  }

  return {
    port: has('PORT') ? Number(env.PORT) : 3000,
    dryRun,
    verifyToken: env.META_VERIFY_TOKEN,
    appSecret: env.META_APP_SECRET,
    accessToken: has('META_ACCESS_TOKEN') ? env.META_ACCESS_TOKEN : null,
    phoneNumberId: has('WHATSAPP_PHONE_NUMBER_ID') ? env.WHATSAPP_PHONE_NUMBER_ID : null,
    graphBaseUrl: (has('GRAPH_BASE_URL') ? env.GRAPH_BASE_URL : 'https://graph.facebook.com').replace(/\/+$/, ''),
    graphApiVersion: has('GRAPH_API_VERSION') ? env.GRAPH_API_VERSION : 'v24.0',
    whatsappTimeoutMs: Number(env.WHATSAPP_TIMEOUT_MS) || 10_000,
    resendApiKey: has('RESEND_API_KEY') ? env.RESEND_API_KEY : null,
    resendFrom: has('RESEND_FROM') ? env.RESEND_FROM : DEFAULT_FROM,
    resendTimeoutMs: Number(env.RESEND_TIMEOUT_MS) || 10_000,
    databaseUrl: has('DATABASE_URL') ? env.DATABASE_URL : null,
  };
}

module.exports = { loadDotEnv, loadConfig };
