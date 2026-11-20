import { DatabaseSync } from 'node:sqlite';

export function openStore(path, initial) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS booking (id INTEGER PRIMARY KEY, version INTEGER NOT NULL, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliveries (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  `);
  db.prepare('INSERT OR IGNORE INTO booking VALUES (1, 0, ?)').run(JSON.stringify(initial));
  const select = db.prepare('SELECT version, state FROM booking WHERE id = 1');
  const update = db.prepare('UPDATE booking SET version = version + 1, state = ? WHERE id = 1 AND version = ?');
  const findDelivery = db.prepare('SELECT nonce FROM deliveries WHERE nonce = ?');
  const addDelivery = db.prepare('INSERT INTO deliveries VALUES (?, ?)');
  const prune = db.prepare('DELETE FROM deliveries WHERE expires < ?');

  function read() {
    const row = select.get();
    return { version: row.version, ...JSON.parse(row.state) };
  }

  function save({ version, ...state }) {
    return update.run(JSON.stringify(state), version).changes === 1;
  }

  function recordDelivery(nonce, expires, now, apply) {
    db.exec('BEGIN IMMEDIATE');
    try {
      prune.run(now);
      const duplicate = Boolean(findDelivery.get(nonce));
      const result = duplicate ? 'duplicate-delivery' : apply();
      if (!duplicate) addDelivery.run(nonce, expires);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return { read, save, hasDelivery: (nonce) => Boolean(findDelivery.get(nonce)), recordDelivery, close: () => db.close() };
}
