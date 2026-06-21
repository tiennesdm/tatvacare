// Reminders provider — WhatsApp / SMS / Email.
// Real production: integrate Twilio / WhatsApp Business API / Firebase FCM.
// For demo: logs to DB and console. Add a stub provider that records what
// WOULD have been sent so the UX flow is fully testable.

import { randomUUID } from 'node:crypto';

const PROVIDERS = {
  whatsapp: async ({ to, subject, body }) => {
    // Real impl would call WhatsApp Business API here.
    // For demo we return a fake provider_msg_id and log.
    console.log(`[whatsapp] -> ${to}: ${subject || ''} ${body || ''}`);
    return { provider_msg_id: 'wa-' + randomUUID().slice(0, 12), status: 'sent' };
  },
  sms: async ({ to, body }) => {
    console.log(`[sms] -> ${to}: ${body}`);
    return { provider_msg_id: 'sms-' + randomUUID().slice(0, 12), status: 'sent' };
  },
  email: async ({ to, subject, body }) => {
    console.log(`[email] -> ${to}: ${subject}`);
    return { provider_msg_id: 'em-' + randomUUID().slice(0, 12), status: 'sent' };
  },
  push: async ({ to, body }) => {
    console.log(`[push] -> ${to}: ${body}`);
    return { provider_msg_id: 'pu-' + randomUUID().slice(0, 12), status: 'sent' };
  },
};

async function sendReminder(pool, reminder, patient) {
  const channel = reminder.channel || 'whatsapp';
  const provider = PROVIDERS[channel] || PROVIDERS.whatsapp;
  let result = { status: 'failed', error: 'no patient phone' };
  if (patient && patient.phone) {
    try {
      result = await provider({
        to: patient.phone,
        subject: reminder.title,
        body: `${reminder.title}\n${reminder.body || ''}`.trim(),
      });
    } catch (e) {
      result = { status: 'failed', error: e.message };
    }
  }
  // Log delivery
  const delivery_id = 'dl-' + Date.now() + '-' + randomUUID().slice(0, 8);
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  try {
    await pool.query(
      `INSERT INTO reminder_deliveries (delivery_id, reminder_id, patient_id, ts, channel, status, provider_msg_id, error)
       VALUES ('${delivery_id}', '${reminder.reminder_id}', '${reminder.patient_id}', '${ts}', '${channel}', '${result.status}', '${result.provider_msg_id || ''}', '${(result.error || '').replace(/'/g, "''")}')`
    );
  } catch (e) { console.warn('[reminders] log failed:', e.message); }
  return result;
}

// Send any reminders that are due now
async function fireDueReminders(pool) {
  // Get active reminders due now or earlier
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const r = await pool.query(
    `SELECT reminder_id, patient_id, kind, title, body, schedule_type, schedule_at, channel
     FROM reminders
     WHERE status = 'active' AND schedule_at <= '${ts}'`
  );
  const fired = [];
  for (const row of r.rows) {
    const reminder = {
      reminder_id: row[0], patient_id: row[1], kind: row[2], title: row[3],
      body: row[4], schedule_type: row[5], schedule_at: row[6], channel: row[7],
    };
    // load patient
    const pr = await pool.query(
      `SELECT patient_id, full_name, phone FROM patients WHERE patient_id = '${reminder.patient_id.replace(/'/g, "''")}'`
    );
    const patient = pr.rows[0] ? { patient_id: pr.rows[0][0], full_name: pr.rows[0][1], phone: pr.rows[0][2] } : null;
    const result = await sendReminder(pool, reminder, patient);
    fired.push({ ...reminder, ...result });

    // Update schedule_at for next occurrence
    let nextAt = null;
    const nextDate = new Date(reminder.schedule_at);
    if (reminder.schedule_type === 'daily') {
      nextDate.setUTCDate(nextDate.getUTCDate() + 1);
      nextAt = nextDate.toISOString().slice(0, 19).replace('T', ' ');
    } else if (reminder.schedule_type === 'once') {
      // mark completed
      await pool.query(
        `UPDATE reminders SET status = 'completed' WHERE reminder_id = '${reminder.reminder_id}'`
      );
    }
    if (nextAt) {
      await pool.query(
        `UPDATE reminders SET schedule_at = '${nextAt}' WHERE reminder_id = '${reminder.reminder_id}'`
      );
    }
  }
  return fired;
}

export { sendReminder, fireDueReminders, getRemindersForPatient };

// List reminders for a patient (used by patient portal)
async function getRemindersForPatient(pool, patientId) {
  const safe = String(patientId).replace(/'/g, "''");
  const r = await pool.query(
    `SELECT reminder_id, kind, title, body, schedule_type, schedule_at, channel, status FROM reminders WHERE patient_id = '${safe}' ORDER BY schedule_at ASC LIMIT 50`
  );
  return r.rows.map(row => [row[0], row[1], row[2], row[3], row[4], row[5], row[6], row[7]]);
}
