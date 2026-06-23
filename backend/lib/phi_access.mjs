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
//     a row. Failures in the logger never propagate to the client.
//   - Skips non-PHI routes (login, dashboard, settings, etc.).
//
// The DB table is created by db/migrations/011_phi_access_log.sql.

import { logger } from './logger.mjs';
import { registry as metrics } from './metrics.mjs';

/**
 * Mark the current request as a PHI access. Use inside any route that
 * reads or writes patient-identifiable data:
 *
 *   app.get('/api/patients/:id', requireAuth, (req, res, next) => {
 *     markPhiAccess(req, { action: 'read', resource_kind: 'patient', resource_id: req.params.id, patient_id: req.params.id });
 *     next();
 *   });
 *
 * @param {import('express').Request} req
 * @param {{ action: 'read'|'create'|'update'|'delete'|'export', resource_kind: string, resource_id?: string, patient_id: string }} info
 */
export function markPhiAccess(req, info) {
  req._phi = {
    action: info.action,
    resource_kind: info.resource_kind,
    resource_id: info.resource_id || null,
    patient_id: info.patient_id,
    actor_kind: req.session?.patient_id ? 'patient' : 'doctor',
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
  return (req, res, next) => {
    res.on('finish', () => {
      const phi = req._phi;
      if (!phi) return;
      if (res.statusCode >= 500) return; // don't log broken requests
      // Write async; failures must NOT break the request flow.
      const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
      const cols = ['ts', 'actor_kind', 'actor_id', 'clinic_id', 'patient_id', 'action', 'resource_kind', 'resource_id', 'request_id', 'ip'];
      const vals = [ts, phi.actor_kind, phi.actor_id || '', phi.clinic_id || '', phi.patient_id, phi.action, phi.resource_kind, phi.resource_id || '', req.id || '', (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').toString().slice(0, 64)];
      const escaped = vals.map(v => typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v));
      const sql = `INSERT INTO phi_access_log (${cols.join(', ')}) VALUES (${escaped.join(', ')})`;
      Promise.resolve()
        .then(() => pool.query(sql))
        .then(() => { try { metrics.auditWrites.inc({ kind: 'phi_access_log' }); } catch {} })
        .catch((e) => logger.warn('phi_access_log_failed', { err: e?.message?.slice(0, 100), patient_id: phi.patient_id, action: phi.action }));
    });
    next();
  };
}
