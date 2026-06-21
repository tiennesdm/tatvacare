// Smoke test for the VBP wrapper
import { VBP } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';

const log = (...a) => console.log('[vbp-test]', ...a);

async function main() {
  const db = new VBP('127.0.0.1', 6381);
  await db.connect();
  log('connected, ping =', (await db.ping()).toString(16));

  log('CREATE TABLE');
  let r = await db.query(`CREATE TABLE IF NOT EXISTS doctors_smoke (
    id INT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE
  )`);
  log('  tag:', r.commandTag);

  log('INSERT');
  r = await db.query(`INSERT INTO doctors_smoke (id, name, email) VALUES (1, 'Dr. Mehta', 'm@x.com')`);
  log('  tag:', r.commandTag, 'rowsAffected:', r.rowsAffected);

  log('SELECT');
  r = await db.query(`SELECT id, name, email FROM doctors_smoke ORDER BY id`);
  log('  rows:', r.rows);
  log('  types:', r.columnTypes);
  log('  tag:', r.commandTag);

  log('CLEANUP');
  await db.query(`DROP TABLE doctors_smoke`);

  await db.close();
  log('done');
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
