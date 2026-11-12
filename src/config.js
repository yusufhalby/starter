const path = require('path');

// Load .env for local runs. Variables already set in the environment (e.g. by Render) are NOT overridden.
function loadDotEnv(file = path.join(__dirname, '..', '.env')) {
  try {
    process.loadEnvFile(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

function loadConfig(env = process.env) {
  const dryRun = env.DRY_RUN === 'true';
  const onRender = Boolean(env.RENDER);

  const required = ['META_VERIFY_TOKEN', 'META_APP_SECRET', 'WHATSAPP_PHONE_NUMBER_ID'];
  if (!dryRun) required.push('META_ACCESS_TOKEN', 'RESEND_API_KEY', 'RESEND_FROM');
  // In-memory dedupe is lost on every deploy/restart, so production must use Postgres.
  if (onRender && !dryRun) required.push('DATABASE_URL');

  const missing = required.filter((k) => !env[k] || !env[k].trim());
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return {
    port: Number(env.PORT) || 3000,
    dryRun,
    verifyToken: env.META_VERIFY_TOKEN,
    appSecret: env.META_APP_SECRET,
    accessToken: env.META_ACCESS_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    graphApiVersion: env.GRAPH_API_VERSION || 'v24.0',
    resendApiKey: env.RESEND_API_KEY,
    resendFrom: env.RESEND_FROM || 'Top Delmon <onboarding@resend.dev>',
    databaseUrl: env.DATABASE_URL || null,
  };
}

module.exports = { loadDotEnv, loadConfig };
