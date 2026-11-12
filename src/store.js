// Records which WhatsApp message ids (wamid) have been handled, so a message is processed at most once.
// claim() must be atomic: two concurrent deliveries of the same wamid must not both get `true`.

class MemoryStore {
  constructor() {
    this.items = new Map();
  }
  async init() {}
  async claim(wamid) {
    if (this.items.has(wamid)) return false;
    this.items.set(wamid, { status: 'processing' });
    return true;
  }
  async mark(wamid, status, detail = null) {
    this.items.set(wamid, { status, detail });
  }
  async get(wamid) {
    return this.items.get(wamid) || null;
  }
  async close() {}
}

class PgStore {
  constructor(connectionString) {
    const { Pool } = require('pg');
    this.pool = new Pool({ connectionString, max: 5 });
  }
  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        wamid      TEXT PRIMARY KEY,
        status     TEXT NOT NULL,
        detail     TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`);
  }
  async claim(wamid) {
    const res = await this.pool.query(
      `INSERT INTO processed_messages (wamid, status) VALUES ($1, 'processing')
       ON CONFLICT (wamid) DO NOTHING RETURNING wamid`,
      [wamid],
    );
    return res.rowCount === 1;
  }
  async mark(wamid, status, detail = null) {
    await this.pool.query(
      'UPDATE processed_messages SET status = $2, detail = $3, updated_at = now() WHERE wamid = $1',
      [wamid, status, detail],
    );
  }
  async get(wamid) {
    const res = await this.pool.query('SELECT status, detail FROM processed_messages WHERE wamid = $1', [wamid]);
    return res.rows[0] || null;
  }
  async close() {
    await this.pool.end();
  }
}

function createStore(config, log = console) {
  if (config.databaseUrl) return new PgStore(config.databaseUrl);
  log.warn('[store] DATABASE_URL not set: using in-memory dedupe (lost on restart, local use only).');
  return new MemoryStore();
}

module.exports = { MemoryStore, PgStore, createStore };
