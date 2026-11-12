// Sends a sample webhook to the local server, signed with META_APP_SECRET from .env, exactly as Meta would.
//
//   node scripts/send-sample.js                         # sends samples/incoming-message.json once
//   node scripts/send-sample.js --times=3               # same message 3 times concurrently (dedupe test)
//   node scripts/send-sample.js --tamper                # body changed after signing -> expect 401
//   node scripts/send-sample.js path/to/payload.json
//
// Target: WEBHOOK_URL, or http://localhost:$PORT/webhook (PORT defaults to 3000).
const fs = require('fs');
const path = require('path');
const { loadDotEnv } = require('../src/config');
const { sign } = require('../src/signature');

loadDotEnv();

const args = process.argv.slice(2);
const tamper = args.includes('--tamper');
const times = Number((args.find((a) => a.startsWith('--times=')) || '').split('=')[1]) || 1;
const file = args.find((a) => !a.startsWith('--')) || path.join(__dirname, '..', 'samples', 'incoming-message.json');
const url = process.env.WEBHOOK_URL || `http://localhost:${process.env.PORT || 3000}/webhook`;

const secret = process.env.META_APP_SECRET;
if (!secret) {
  console.error('META_APP_SECRET is not set (.env missing?)');
  process.exit(1);
}

// Sign the exact bytes that are sent. Re-serialising the JSON would change them and break the signature.
const raw = fs.readFileSync(file);
const signature = sign(secret, raw);
const body = tamper ? Buffer.concat([raw, Buffer.from(' ')]) : raw;

(async () => {
  console.log(`POST ${url}  x${times}${tamper ? '  (tampered body)' : ''}\nX-Hub-Signature-256: ${signature}`);
  const results = await Promise.all(
    Array.from({ length: times }, () =>
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
        body,
      }).then((r) => r.status),
    ),
  );
  console.log('Response status(es):', results.join(', '));
})().catch((err) => {
  console.error(`Request failed: ${err.message} (is the server running?)`);
  process.exit(1);
});
