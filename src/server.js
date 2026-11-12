const express = require('express');
const { handleIncomingMessage } = require('./handler');

const app = express();
app.use(express.json());

// Meta webhook verification
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN) {
    return res.status(200).send('OK');
  }
  return res.sendStatus(403);
});

// Incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0]?.changes?.[0]?.value;
    const message = entry?.messages?.[0];
    if (message) {
      await handleIncomingMessage(message, entry.contacts?.[0]);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(3000, () => console.log('Listening on 3000'));
