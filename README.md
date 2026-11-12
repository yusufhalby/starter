# td-whatsapp-intake

Receives client WhatsApp messages through the Meta Cloud API webhook and sends the client a confirmation
email through Resend.

## How it behaves

- `GET /webhook` performs Meta's verification handshake (echoes `hub.challenge` when `hub.verify_token` matches).
- `POST /webhook` rejects any request whose `X-Hub-Signature-256` is not a valid HMAC of the raw body with
  `META_APP_SECRET` (401). Valid requests are answered with 200 immediately and processed in the background.
- Every text message id (`wamid`) is **claimed atomically** in Postgres before Meta gets its 200. A claimed
  message is never processed again, so Meta's retries and duplicate deliveries can't send a second email. The
  wamid is also sent to Resend as the `Idempotency-Key`. If the database is unreachable the endpoint returns
  500 so Meta retries later.
- A failed WhatsApp reply is logged and never triggers a resend of the email. A Resend error is never reported to
  the client as success.

## Run locally

    npm install
    cp .env.example .env      # fill in values
    npm run dev               # DRY RUN: logs emails / WhatsApp replies instead of sending them
    npm run send-sample       # in a second terminal: POSTs samples/incoming-message.json signed with META_APP_SECRET

Useful variations:

    node scripts/send-sample.js --times=3    # same message 3x concurrently -> exactly one email
    node scripts/send-sample.js --tamper     # body altered after signing -> 401
    npm test                                 # automated tests (no network, no database)

Without `DATABASE_URL` the service uses an in-memory dedupe store, which is fine locally but is lost on restart.

## Deploy on Render

1. Create a Postgres database and a Web Service (or use `render.yaml`).
2. Build command `npm ci`, start command `npm start`, health check path `/health`.
3. Set the environment variables from `.env.example` in the dashboard. `DATABASE_URL` = the database's
   *Internal* URL. The service refuses to start on Render without it.
4. `RESEND_FROM` must use a domain verified in Resend (`onboarding@resend.dev` only delivers to your own account).
5. Use an instance type that doesn't spin down. Free-tier cold starts exceed Meta's webhook timeout.
6. In the Meta app dashboard set the callback URL to `https://<service>.onrender.com/webhook` with the same verify
   token, and subscribe to the `messages` field.

Never commit `.env`. If real secrets were ever committed or shared, rotate them.
