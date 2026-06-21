// Migration runner — applies SQL files via VBP wire
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { VBP } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/vbp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIG_DIR = join(__dirname, '..', '..', 'db', 'migrations');

function sha256(s) { return createHash('sha256').update(s).digest('hex'); }

function splitStatements(sql) {
  // Strip full-line comments first, then split on ';' followed by newline
  const stripped = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  return stripped.split(/;\s*\n/).map(s => s.trim()).filter(s => s.length > 0);
}

async function main() {
  const db = new VBP('127.0.0.1', 6381);
  await db.connect();
  console.log('[migrate] connected to VBP 127.0.0.1:6381');

  const files = readdirSync(MIG_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIG_DIR, f), 'utf-8');
    const statements = splitStatements(sql);
    console.log(`[migrate] ${f} → ${statements.length} statements`);
    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i];
      try {
        const r = await db.query(stmt);
        console.log(`  [${i + 1}/${statements.length}] OK: ${r.commandTag.slice(0, 60)}`);
      } catch (e) {
        console.error(`  [${i + 1}/${statements.length}] FAIL: ${e.message}`);
        throw e;
      }
    }
  }

  // Patch seed file's password hash placeholder with real sha256 of 'tatva123'
  const realHash = sha256('tatva123');
  console.log(`[migrate] patching seed passwords → sha256("tatva123") = ${realHash}`);
  // Inline the hash in the SQL (VBP param binding is not yet wired)
  const r = await db.query(`UPDATE doctors SET password_hash = '${realHash}' WHERE password_hash = 'PLACEHOLDER_HASH'`);
  console.log(`  ${r.commandTag}`);

  // Verify
  const verify = await db.query(`SELECT count(*) FROM doctors`);
  console.log(`[migrate] verify: ${verify.rows[0]?.[0]} doctors`);

  await db.close();
  console.log('[migrate] done');
  process.exit(0);
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
