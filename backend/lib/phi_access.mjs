// PHI access logger — HIPAA §164.312(b) audit controls.
//
// What this is:
//   Every read or write of a patient resource (chart, vitals, Rx, notes,
//   adherence, telemedicine session, prescription PDF) MUST be logged
//   to a dedicated access trail so an auditor can answer:
//
//     - "Who looked at patient P-123 between 2026-06-01 and 2026-06-15?"
//     - "Did doctor D-9 export any Rx PDF in the last 90 days?"
//     - "Show every write to patient P-456's adherence table."
//
//   The general audit_log table covers mutation events but mixes them
//   with admin actions. phi_access_log is a stricter subset: every row
//   has (actor_*, patient_id, action, resource_kind, resource_id, ts).
//
// Why a separate table:
//   - Compliance officers can GRANT read on phi_access_log to a
//     narrower audience than audit_log (separation of duties).
//   - Retention rules may differ (HIPAA = 6 years minimum for some
//     audit trails; some states want 10 years for clinical access).
//   - Query patterns differ: "all access for patient X" hits this
//     table directly with a single index, no scan through admin events.
//
// What this middleware does:
//   - Marks the route handler as touching PHI (via req.phi = {...}).
//   - On res.on('finish'), if the route is PHI and status < 500, logs
//     a row. Failures in the logger are surfaced via a metric counter
//     (phi_log_failures_total{reason}) so a missing table is observable
//     instead of being silently dropped.
//   - Skips non-PHI routes (login, dashboard, settings, etc.).
//
// The DB table is created by db/migrations/011_phi_access_log.sql.
// A boot-time smoke check (verifyPhiTable) verifies the table exists;
// in production, missing-table causes process.exit(2).

import { logger } from './logger.mjs';
import { registry as metrics } from './metrics.mjs';
import { sqlStr, sqlValue } from './sql.mjs';

// How many consecutive failures before we emit an error log (rate-limit
// the warnings so we don't spam when the DB is down for an hour).
const FAIL_WARN_EVERY = 50;
let _failCount = 0;

export function markPhiAccess(req, info) {
  req._phi = {
    action: info.action,
    resource_kind: info.resource_kind,
    resource_id: info.resource_id || null,
    patient_id: info.patient_id,
    actor_kind: req.session?.patient_id ? 'patient' : (req.session?.doctor_id ? 'doctor' : 'unknown'),
    actor_id: req.session?.doctor_id || req.session?.patient_id || null,
    clinic_id: req.session?.clinic_id || null,
  };
}

/**
 * Express middleware. Logs every marked request after the response is
 * finished. MUST be installed before the routes (so res.on('finish') is
 * set up early) and after requireAuth (so req.session is populated).
 */
export function phiAccessLogger(pool) {
  if (!pool) throw new Error('phiAccessLogger: pool is required');
  // Stash pool reference for the boot-time check below.
  phiAccessLogger._pool = pool;
  return (req, res, next) => {
    res.on('finish', () => {
      const phi = req._phi;
      if (!phi) return;
      if (res.statusCode >= 500) return; // don't log broken requests
      // Write async; failures must NOT break the request flow.
      const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const cols = ['ts', 'actor_kind', 'actor_id', 'clinic_id', 'patient_id', 'action', 'resource_kind', 'resource_id', 'request_id', 'ip'];
      const vals = [
        sqlStr(ts),
        sqlStr(phi.actor_kind),
        sqlStr(phi.actor_id || ''),
        sqlStr(phi.clinic_id || ''),
        sqlStr(phi.patient_id),
        sqlStr(phi.action),
        sqlStr(phi.resource_kind),
        phi.resource_id ? sqlStr(phi.resource_id) : 'NULL',
        sqlStr(req.id || ''),
        sqlStr((req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().slice(0, 64)),
      ];
      const sql = `INSERT INTO phi_access_log (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
      Promise.resolve()
        .then(() => pool.query(sql))
        .then(() => { try { metrics.auditWrites.inc({ kind: 'phi_access_log' }); } catch {} })
        .catch((e) => {
          _failCount++;
          const reason = classifyPhiFailure(e);
          try { metrics.phiLogFailures.inc({ reason }); } catch {}
          // Log every failure to stderr, but also rate-limit the full
          // error message to avoid log flood during a DB outage.
          if (_failCount === 1 || _failCount % FAIL_WARN_EVERY === 0) {
            logger.error('phi_access_log_failed', {
              err: e?.message?.slice(0, 200),
              reason,
              fail_count: _failCount,
              patient_id: phi.patient_id,
              action: phi.action,
              note: _failCount === 1
                ? 'PHI logging is broken. Check phi_access_log table exists and DB is reachable. Compliance gap!'
                : `repeated failures (${_failCount})`,
            });
          }
        });
    });
    next();
  };
}

function classifyPhiFailure(e) {
  const m = String(e?.message || '').toLowerCase();
  if (m.includes('does not exist') || m.includes('not found') || m.includes('unknown table')) return 'table_missing';
  if (m.includes('timeout') || m.includes('timed out')) return 'timeout';
  if (m.includes('refused') || m.includes('econn') || m.includes('unreachable')) return 'db_unreachable';
  if (m.includes('permission') || m.includes('denied')) return 'permission_denied';
  return 'other';
}

/**
 * Boot-time check — verifies the phi_access_log table exists.
 *
 *   - In production, missing-table causes process.exit(2) (compliance
 *     gap; better to refuse to start than to run silently broken).
 *   - In development, logs a warning so local dev still works while
 *     migrations are being written.
 *
 * Call this ONCE from server.mjs after the pool is connected.
 */
export async function verifyPhiTable(pool, { exitOnMissing = false } = {}) {
  if (!pool) return { ok: false, reason: 'no_pool' };
  try {
    const r = await pool.query(`SELECT 1 FROM phi_access_log LIMIT 0`);
    return { ok: true };
  } catch (e) {
    const reason = classifyPhiFailure(e);
    logger.error('phi_table_missing', {
      reason,
      err: e?.message?.slice(0, 200),
      hint: 'Run: node backend/scripts/migrate.mjs',
    });
    if (exitOnMissing) {
      process.stderr.write('[phi] FATAL: phi_access_log table missing — refusing to start (compliance)\n');
      process.exit(2);
    }
    return { ok: false, reason };
  }
}

// Expose for tests / debugging.
export function _getFailureCount() { return _failCount; }
export function _resetFailureCount() { _failCount = 0; }