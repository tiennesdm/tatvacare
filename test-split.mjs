import { readFileSync } from 'node:fs';
const sql = readFileSync('/Users/shubhammehta/Downloads/tatvacare/db/migrations/001_init.sql', 'utf-8');
const statements = sql.split(/;\s*\n/).map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('--'));
console.log(`Total statements: ${statements.length}`);
statements.forEach((s, i) => {
  const firstLine = s.split('\n')[0];
  console.log(`  [${i+1}] ${firstLine.slice(0, 70)}`);
});
