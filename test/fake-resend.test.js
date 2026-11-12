// End-to-end: runs the real server (src/server.js, as `npm start` does) in a child process, with Resend pointed at a
// small fake HTTP server via RESEND_BASE_URL, and sends the signed sample as Meta would.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { sign } = require('../src/signature');

const ROOT = path.join(__dirname, '..');
const SAMPLE = fs.readFileSync(path.join(ROOT, 'samples', 'incoming-message.json'));
const SECRET = 'fake-resend-test-secret';
const WAMID = JSON.parse(SAMPLE).entry[0].changes[0].value.messages[0].id;

const cleanups = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake Resend (POST /emails) + fake Graph API (POST .../messages, rejects the token like real Meta would with a fake one).
async function startFakeApis({ resend = 'ok' } = {}) {
  const emailRequests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/emails') {
        emailRequests.push({ headers: req.headers, body: JSON.parse(body) });
        if (resend === 'hang') return; // never answers
        if (resend === 'unauthorized') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ statusCode: 401, name: 'validation_error', message: 'API key is invalid' }));
        }
        // Small delay so concurrent deliveries really overlap with an in-flight send.
        return setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: `fake-email-${emailRequests.length}` }));
        }, 150);
      }
      if (req.method === 'POST' && req.url.endsWith('/messages')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid OAuth access token.', code: 190 } }));
      }
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, emailRequests };
}

async function startService(fakeUrl, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0',
      META_APP_SECRET: SECRET,
      META_VERIFY_TOKEN: 'verify',
      META_ACCESS_TOKEN: 'EAAG-fake',
      WHATSAPP_PHONE_NUMBER_ID: '100000000000001',
      RESEND_API_KEY: 're_fake',
      RESEND_FROM: 'Top Delmon <test@example.com>',
      RESEND_BASE_URL: fakeUrl,
      GRAPH_BASE_URL: fakeUrl,
      DATABASE_URL: '',
      DRY_RUN: 'false',
      RENDER: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (output += d));
  cleanups.push(() => {
    if (child.exitCode === null) child.kill();
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`service did not start:\n${output}`)), 10_000);
    const check = () => {
      const m = output.match(/Listening on (\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    };
    child.stdout.on('data', check);
    child.on('exit', (code) => reject(new Error(`service exited (${code}):\n${output}`)));
  });

  return {
    child,
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    deliver: () =>
      fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(SECRET, SAMPLE) },
        body: SAMPLE,
      }).then((r) => r.status),
  };
}

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(25);
  }
  throw new Error('timed out waiting for condition');
}

test('signed sample delivered several times, including concurrently, makes exactly one Resend request', async () => {
  const fake = await startFakeApis();
  const svc = await startService(fake.url);

  // 5 simultaneous deliveries of the same message...
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => svc.deliver()));
  assert.deepEqual(concurrent, [200, 200, 200, 200, 200]);
  // ...more while the email request may still be in flight...
  assert.equal(await svc.deliver(), 200);
  await waitFor(() => /\[email\] .* sent/.test(svc.output()));
  // ...and Meta-style retries after it completed.
  assert.equal(await svc.deliver(), 200);
  assert.equal(await svc.deliver(), 200);
  await delay(500);

  assert.equal(fake.emailRequests.length, 1, svc.output());
  const [req] = fake.emailRequests;
  assert.equal(req.body.to, 'fatima@example.com');
  assert.equal(req.headers['idempotency-key'], `wa-confirm/${WAMID}`);
  assert.equal(req.headers.authorization, 'Bearer re_fake');

  // The fake Meta token was rejected: logged, not fatal.
  assert.match(svc.output(), /WhatsApp send failed \(401\)/);
  assert.equal(svc.child.exitCode, null, 'service must still be running');
  assert.equal((await fetch(`${svc.base}/health`)).status, 200);
});

test('rejected Resend credentials are logged, not fatal, and not retried', async () => {
  const fake = await startFakeApis({ resend: 'unauthorized' });
  const svc = await startService(fake.url);

  await Promise.all([svc.deliver(), svc.deliver(), svc.deliver()]);
  await waitFor(() => /\[email\] .* failed: Resend error: validation_error/.test(svc.output()));
  assert.equal(await svc.deliver(), 200);
  await delay(300);

  assert.equal(fake.emailRequests.length, 1);
  assert.equal(svc.child.exitCode, null, 'service must still be running');
  assert.equal((await fetch(`${svc.base}/health`)).status, 200);
});

test('a Resend call that never answers times out and is logged', async () => {
  const fake = await startFakeApis({ resend: 'hang' });
  const svc = await startService(fake.url, { RESEND_TIMEOUT_MS: '300' });

  assert.equal(await svc.deliver(), 200);
  await waitFor(() => /outcome unknown: Resend did not respond within 300 ms/.test(svc.output()));
  assert.equal(await svc.deliver(), 200);
  await delay(300);

  assert.equal(fake.emailRequests.length, 1);
  assert.equal(svc.child.exitCode, null, 'service must still be running');
});
