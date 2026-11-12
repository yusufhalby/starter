// Each segment after "@" must be followed by characters, so a sentence-ending "." is not captured.
const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+/i;
const MAX_QUOTED_TEXT = 1000;

function extractEmail(text) {
  const match = String(text || '').match(EMAIL_REGEX);
  return match ? match[0].toLowerCase() : null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(text, max) {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function buildConfirmationEmail({ from, to, name, text }) {
  const quoted = truncate(text, MAX_QUOTED_TEXT);
  return {
    from,
    to,
    subject: 'We received your request',
    html:
      `<p>Dear ${escapeHtml(name)},</p>` +
      `<p>We received your message: "${escapeHtml(quoted)}".</p>` +
      '<p>Our team will contact you within one working day.</p>',
    text: `Dear ${name},\n\nWe received your message: "${quoted}".\n\nOur team will contact you within one working day.`,
  };
}

function createProcessor({ config, store, sendEmail, sendWhatsApp, log = console }) {
  // Pull every text message addressed to our number out of a webhook payload.
  // Meta may batch several entries / changes / messages in one POST.
  function extractMessages(payload) {
    if (payload?.object !== 'whatsapp_business_account') return [];
    const items = [];
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        if (config.phoneNumberId && value.metadata?.phone_number_id !== config.phoneNumberId) {
          log.warn(`[webhook] ignoring change for phone_number_id ${value.metadata?.phone_number_id}`);
          continue;
        }
        // value.statuses (sent/delivered/read receipts) are intentionally ignored.
        for (const message of value.messages || []) {
          if (!message?.id || !message.from) continue;
          if (message.type !== 'text') {
            log.log(`[webhook] ignoring non-text message ${message.id} (type=${message.type})`);
            continue;
          }
          const contact = (value.contacts || []).find((c) => c.wa_id === message.from) || value.contacts?.[0];
          items.push({ message, contact });
        }
      }
    }
    return items;
  }

  async function mark(wamid, status, detail) {
    try {
      await store.mark(wamid, status, detail);
    } catch (err) {
      log.error(`[store] failed to mark ${wamid} as ${status}: ${err.message}`);
    }
  }

  // A failed WhatsApp reply is logged only. It must never cause the email to be sent again.
  async function reply(to, body, wamid) {
    try {
      await sendWhatsApp(to, body);
    } catch (err) {
      log.error(`[whatsapp] reply for ${wamid} failed: ${err.message}`);
    }
  }

  // Must only be called for a message that was successfully claimed in the store.
  async function processMessage({ message, contact }) {
    const wamid = message.id;
    const text = message.text?.body || '';
    const name = contact?.profile?.name || 'Client';
    const email = extractEmail(text);

    if (!email) {
      await mark(wamid, 'no_email');
      await reply(message.from, 'Please send your email address so we can confirm your request.', wamid);
      return;
    }

    let sent;
    try {
      sent = await sendEmail(buildConfirmationEmail({ from: config.resendFrom, to: email, name, text }), {
        idempotencyKey: `wa-confirm/${wamid}`,
      });
    } catch (err) {
      if (err.code === 'EMAIL_TIMEOUT') {
        // Resend may still have accepted it. Don't tell the client it failed (they'd resend, risking a second email).
        log.error(`[email] ${wamid} outcome unknown: ${err.message}`);
        await mark(wamid, 'email_unknown', err.message);
        await reply(message.from, 'Thank you, we received your request. Our team will contact you within one working day.', wamid);
        return;
      }
      log.error(`[email] ${wamid} failed: ${err.message}`);
      await mark(wamid, 'email_failed', err.message);
      await reply(
        message.from,
        `Sorry, we could not send a confirmation email to ${email}. Please check the address and send it again.`,
        wamid,
      );
      return;
    }

    await mark(wamid, 'email_sent', sent.id);
    log.log(`[email] ${wamid} sent (${sent.id})`);
    await reply(message.from, `Thank you. A confirmation email has been sent to ${email}.`, wamid);
  }

  return { extractMessages, processMessage };
}

module.exports = { createProcessor, extractEmail, escapeHtml, buildConfirmationEmail };
