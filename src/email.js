class EmailTimeoutError extends Error {
  constructor(ms) {
    super(`Resend did not respond within ${ms} ms`);
    this.name = 'EmailTimeoutError';
    this.code = 'EMAIL_TIMEOUT';
  }
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new EmailTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Returns sendEmail(payload, { idempotencyKey }) -> { id }. Throws on any Resend error or timeout.
function createEmailSender(config, log = console) {
  if (config.dryRun) {
    return async (payload, { idempotencyKey }) => {
      log.log(`[dry-run] Email -> ${payload.to} | ${payload.subject} | key=${idempotencyKey}\n${payload.html}`);
      return { id: `dry-run:${idempotencyKey}` };
    };
  }

  if (!config.resendApiKey) {
    return async () => {
      throw new Error('RESEND_API_KEY is not configured');
    };
  }

  // Required here (after .env is loaded), not at the top: the SDK reads RESEND_BASE_URL once, when the module loads.
  const { Resend } = require('resend');
  const resend = new Resend(config.resendApiKey);

  return async function sendEmail(payload, { idempotencyKey }) {
    // The SDK accepts no AbortSignal, so the timeout is applied around the call. On timeout the email may or may
    // not have been accepted; the caller treats that as "unknown" and does not retry.
    // resend.emails.send() does NOT throw on API errors; it resolves to { data, error }.
    const { data, error } = await withTimeout(
      resend.emails.send(payload, { idempotencyKey }),
      config.resendTimeoutMs,
    );
    if (error || !data?.id) {
      throw new Error(`Resend error: ${error?.name || 'unknown'}: ${error?.message || 'no email id returned'}`);
    }
    return data;
  };
}

module.exports = { createEmailSender, EmailTimeoutError };
