const crypto = require('crypto');

// Meta signs each webhook POST: X-Hub-Signature-256: sha256=<hex HMAC-SHA256 of the raw body, keyed by the app secret>
function sign(appSecret, rawBody) {
  return 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

function isValidSignature(appSecret, rawBody, header) {
  if (typeof header !== 'string' || !Buffer.isBuffer(rawBody)) return false;
  const expected = Buffer.from(sign(appSecret, rawBody));
  const received = Buffer.from(header.trim());
  return expected.length === received.length && crypto.timingSafeEqual(expected, received);
}

module.exports = { sign, isValidSignature };
