// Audit log helper — every mutation goes through this.
// Records to audit_log table via VBP.

import { randomUUID } from 'node:crypto';

let _enabled = true;
function setEnabled(v) { _enabled = v; }

async function audit(pool, req, opts) {
  if (!_enabled) return;
  const {
    actor_kind = 'doctor',
    actor_id,
    clinic_id,
    action,
    resource_kind,
    resource_id,
    diff_json,
  } = opts;
  const audit_id = 'a-' + Date.now() + '-' + randomUUID().slice(0, 8);
  const ip = req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req?.socket?.remoteAddress || '';
  const user_agent = (req?.headers?.['user-agent'] || '').slice(0, 250);
  const cols = ['audit_id', 'ts', 'actor_kind', 'actor_id', 'clinic_id', 'action', 'resource_kind', 'resource_id', 'ip', 'user_agent', 'diff_json'];
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const fields = {
    audit_id, ts,
    actor_kind, actor_id: actor_id || '', clinic_id: clinic_id || '',
    action, resource_kind: resource_kind || '', resource_id: resource_id || '',
    ip, user_agent,
    diff_json: diff_json ? JSON.stringify(diff_json).slice(0, 4000) : '',
  };
  const q = `INSERT INTO audit_log (${cols.join(', ')}) VALUES (${cols.map(c => {
    const f = fields[c];
    if (typeof f === 'string') return `'${f.replace(/'/g, "''")}'`;
    return String(f);
  }).join(', ')})`;
  try {
    await pool.query(q);
  } catch (e) {
    if (!_logged) {
      console.warn('[audit] failed (will be silenced):', e.message);
      _logged = true;
    }
  }
}

let _logged = false;

export { audit, setEnabled };
