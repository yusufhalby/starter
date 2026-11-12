const { Resend } = require('resend');
const { sendWhatsAppText } = require('./whatsapp');

const resend = new Resend(process.env.RESEND_API_KEY);
const EMAIL_REGEX = /[\w.+-]+@[\w-]+\.[\w.]+/;

async function handleIncomingMessage(message, contact) {
  const text = message.text?.body || '';
  const name = contact?.profile?.name || 'Client';
  const email = (text.match(EMAIL_REGEX) || [])[0];

  if (!email) {
    await sendWhatsAppText(message.from, 'Please send your email address so we can confirm your request.');
    return;
  }

  await resend.emails.send({
    from: 'Top Delmon <onboarding@resend.dev>',
    to: email,
    subject: 'We received your request',
    html: `<p>Dear ${name},</p><p>We received your message: "${text}". Our team will contact you within one working day.</p>`,
  });

  await sendWhatsAppText(message.from, 'Thank you. A confirmation email has been sent.');
}

module.exports = { handleIncomingMessage };
