const { Resend } = require('resend');

// Returns sendEmail(payload, { idempotencyKey }) -> { id }. Throws on any Resend error.
function createEmailSender(config, log = console) {
  if (config.dryRun) {
    return async (payload, { idempotencyKey }) => {
      log.log(`[dry-run] Email -> ${payload.to} | ${payload.subject} | key=${idempotencyKey}\n${payload.html}`);
      return { id: `dry-run:${idempotencyKey}` };
    };
  }

  const resend = new Resend(config.resendApiKey);

  return async function sendEmail(payload, { idempotencyKey }) {
    // resend.emails.send() does NOT throw on API errors; it resolves to { data, error }.
    const { data, error } = await resend.emails.send(payload, { idempotencyKey });
    if (error || !data?.id) {
      throw new Error(`Resend error: ${error?.name || 'unknown'}: ${error?.message || 'no email id returned'}`);
    }
    return data;
  };
}

module.exports = { createEmailSender };
