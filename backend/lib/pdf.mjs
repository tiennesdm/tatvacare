// PDF prescription generator using PDFKit
// Pure server-side, no external services. Generates a print-ready
// Indian-style prescription PDF with clinic header, patient info,
// vitals, diagnosis, drugs, advice, follow-up, and doctor signature.
import PDFDocument from 'pdfkit';
import crypto from 'crypto';

function fmtDate(d) {
  if (!d || d === 'NULL') return '—';
  try { return new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return String(d); }
}

function safe(s) { return s == null || s === 'NULL' ? '' : String(s); }
function isEmpty(s) { return s == null || s === 'NULL' || s === '' || s === 'undefined'; }

// Generate a stable short hash for a digital-signature-like footer line
function rxHash(rx) {
  const h = crypto.createHash('sha256');
  h.update(JSON.stringify({ n: rx.rx_number, p: rx.patient_id, d: rx.diagnosis_code, t: rx.created_at }));
  return h.digest('hex').slice(0, 16).toUpperCase();
}

// Convert NULL-strings/null/0 to a safe string for display
function v(s) { return isEmpty(s) ? null : String(s); }

export async function generateRxPdf(pool, rx, doctor, patient) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 40, info: {
        Title: `Prescription ${rx.rx_number}`,
        Author: safe(doctor.full_name),
        Subject: 'Medical Prescription',
        Keywords: 'prescription, EMR, TatvaCare',
      }});
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageW = doc.page.width - 80; // 40 margin each side
      const accent = '#2563eb';
      const muted = '#64748b';

      // ===== HEADER (compact, single row) =====
      doc.fillColor(accent).fontSize(22).font('Helvetica-Bold').text('TatvaCare', 40, 40);
      doc.fontSize(7).font('Helvetica').fillColor(muted)
        .text('Digital prescription · VedaDB VBP wire protocol', 40, 65);
      // Right side: rx number + date
      doc.fontSize(7).font('Helvetica-Bold').fillColor(muted).text('Rx #', 420, 42);
      doc.fillColor(accent).fontSize(10).font('Courier-Bold').text(safe(rx.rx_number), 420, 52);
      doc.fillColor(muted).fontSize(7).font('Helvetica').text('Date', 420, 70);
      doc.fillColor('#0f172a').fontSize(9).font('Helvetica').text(fmtDate(rx.created_at), 420, 80);

      // Divider
      doc.strokeColor(accent).lineWidth(2).moveTo(40, 95).lineTo(555, 95).stroke();

      // Doctor + clinic row (single line each)
      let y = 105;
      // Doctor (left col, 240 wide)
      doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text(safe(doctor.full_name), 40, y, { width: 250 });
      y = doc.y;
      // Build qualAndSpec but dedupe (some doctors have qual == spec)
      const qualAndSpec = [];
      if (!isEmpty(doctor.qualifications)) qualAndSpec.push(doctor.qualifications);
      if (doctor.specialties) {
        const specs = Array.isArray(doctor.specialties) ? doctor.specialties.join(', ') : String(doctor.specialties);
        if (specs && !qualAndSpec.includes(specs)) qualAndSpec.push(specs);
      }
      if (qualAndSpec.length > 0) {
        doc.fontSize(8).font('Helvetica').fillColor(muted).text(qualAndSpec.join('  ·  '), 40, y, { width: 250 });
        y = doc.y;
      }
      if (!isEmpty(doctor.mci_reg_no)) {
        doc.fontSize(8).font('Helvetica').fillColor(muted).text(`MCI Reg: ${doctor.mci_reg_no}`, 40, y, { width: 250 });
        y = doc.y;
      }
      const docEndY = y;

      // Clinic (right col, 250 wide)
      let cy = 105;
      if (!isEmpty(doctor.clinic_name)) {
        doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold').text(safe(doctor.clinic_name), 320, cy, { width: 235 });
        cy = doc.y;
      }
      doc.fontSize(8).font('Helvetica').fillColor(muted);
      if (!isEmpty(doctor.clinic_address)) { doc.text(safe(doctor.clinic_address), 320, cy, { width: 235 }); cy = doc.y; }
      const locParts = [v(doctor.city), v(doctor.state)].filter(Boolean).join(', ');
      const locLine = [locParts, v(doctor.pincode) ? '- ' + doctor.pincode : ''].filter(Boolean).join(' ');
      if (locLine) { doc.text(locLine, 320, cy, { width: 235 }); cy = doc.y; }
      if (!isEmpty(doctor.phone)) { doc.text(`Ph: ${doctor.phone}`, 320, cy, { width: 235 }); cy = doc.y; }
      if (!isEmpty(doctor.email)) { doc.text(doctor.email, 320, cy, { width: 235 }); cy = doc.y; }

      doc.y = Math.max(docEndY, cy) + 12;

      // ===== PATIENT BLOCK =====
      doc.fillColor(muted).fontSize(7).font('Helvetica-Bold').text('PATIENT', 40, doc.y);
      doc.fillColor('#0f172a').fontSize(13).font('Helvetica-Bold').text(safe(patient.full_name), 40, doc.y + 10, { width: 380 });
      const patientMeta = [];
      if (patient.age != null && patient.age !== 'NULL') patientMeta.push(`${patient.age} ${patient.gender || ''}`.trim());
      if (!isEmpty(patient.phone)) patientMeta.push(`Ph: ${patient.phone}`);
      if (!isEmpty(patient.abha_number)) patientMeta.push(`ABHA: ${patient.abha_number}`);
      if (!isEmpty(patient.blood_group)) patientMeta.push(`Blood: ${patient.blood_group}`);
      doc.fontSize(8).font('Helvetica').fillColor(muted).text(patientMeta.join('   ·   '), 40, doc.y + 2, { width: 510 });

      doc.moveDown(1.4);
      doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.6);

      // ===== DIAGNOSIS + VITALS =====
      if (!isEmpty(rx.diagnosis_code) || !isEmpty(rx.diagnosis_label)) {
        doc.fillColor(muted).fontSize(7).font('Helvetica-Bold').text('DIAGNOSIS', 40, doc.y);
        doc.moveDown(0.2);
        doc.fillColor('#0f172a').fontSize(10).font('Helvetica-Bold');
        const dx = `${rx.diagnosis_code || ''}${rx.diagnosis_label ? '  —  ' + rx.diagnosis_label : ''}`;
        doc.text(dx, 40, doc.y);
        if (!isEmpty(rx.chief_complaint)) {
          doc.fontSize(8).font('Helvetica-Oblique').fillColor(muted).text(`Chief complaint: ${rx.chief_complaint}`, 40, doc.y);
        }
        doc.moveDown(0.4);
      }

      const vitals = rx.vitals || {};
      const vparts = [];
      if (!isEmpty(vitals.bp)) vparts.push(`BP: ${vitals.bp} mmHg`);
      if (!isEmpty(vitals.pulse)) vparts.push(`Pulse: ${vitals.pulse} bpm`);
      if (!isEmpty(vitals.spo2)) vparts.push(`SpO₂: ${vitals.spo2}%`);
      if (!isEmpty(vitals.temp_c)) vparts.push(`Temp: ${vitals.temp_c}°C`);
      if (!isEmpty(vitals.weight_kg)) vparts.push(`Weight: ${vitals.weight_kg} kg`);
      if (vparts.length > 0) {
        doc.fillColor(muted).fontSize(7).font('Helvetica-Bold').text('VITALS AT THIS VISIT', 40, doc.y);
        doc.moveDown(0.15);
        doc.fillColor('#0f172a').fontSize(9).font('Helvetica').text(vparts.join('   ·   '), 40, doc.y);
        doc.moveDown(0.4);
      }

      // ===== MEDICATIONS =====
      doc.fillColor(accent).fontSize(8).font('Helvetica-Bold').text('MEDICATIONS', 40, doc.y);
      doc.moveDown(0.3);
      const items = Array.isArray(rx.rx_items) ? rx.rx_items : [];
      if (items.length === 0) {
        doc.fillColor(muted).fontSize(9).font('Helvetica-Oblique').text('(no medications in this prescription)', 40, doc.y);
        doc.moveDown(0.4);
      } else {
        items.forEach((item, i) => {
          const y0 = doc.y;
          // Big Rx number on left
          doc.fillColor(accent).fontSize(13).font('Helvetica-Bold').text(`${i + 1}.`, 40, y0, { width: 22 });
          // Drug name
          doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(safe(item.drug || item.name), 65, y0, { width: pageW - 30 });
          // Dose, freq, duration on one line
          const detail = [
            item.dose && `${item.dose}`,
            item.frequency && `${item.frequency}`,
            item.duration && `× ${item.duration} days`,
          ].filter(Boolean).join('   ·   ');
          if (detail) {
            doc.fontSize(9).font('Helvetica').fillColor(muted).text(detail, 65, doc.y, { width: pageW - 30 });
          }
          if (item.instruction && !isEmpty(item.instruction)) {
            doc.fontSize(8).font('Helvetica-Oblique').fillColor('#475569').text(`Note: ${item.instruction}`, 65, doc.y, { width: pageW - 30 });
          }
          doc.moveDown(0.4);
        });
      }

      doc.moveDown(0.2);
      doc.strokeColor('#e2e8f0').lineWidth(0.5).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.5);

      // ===== ADVICE + FOLLOW-UP =====
      if (!isEmpty(rx.advice)) {
        doc.fillColor(muted).fontSize(7).font('Helvetica-Bold').text('ADVICE', 40, doc.y);
        doc.moveDown(0.15);
        doc.fillColor('#0f172a').fontSize(10).font('Helvetica').text(safe(rx.advice), 40, doc.y, { width: pageW });
        doc.moveDown(0.4);
      }
      if (rx.followup_in_days) {
        doc.fillColor(muted).fontSize(7).font('Helvetica-Bold').text('FOLLOW-UP', 40, doc.y);
        doc.moveDown(0.15);
        doc.fillColor('#0f172a').fontSize(10).font('Helvetica').text(
          `Re-consult in ${rx.followup_in_days} days${rx.delivery_method ? `   ·   Delivered via ${rx.delivery_method}` : ''}`,
          40, doc.y
        );
        doc.moveDown(0.4);
      }

      // ===== SIGNATURE (anchored to bottom) =====
      const sigY = doc.page.height - 120;
      if (doc.y < sigY) doc.y = sigY;
      doc.fontSize(7).font('Helvetica-Bold').fillColor(muted).text("Doctor's signature & seal", 40, doc.y);
      doc.moveDown(0.6);
      // Signature line
      doc.strokeColor('#0f172a').lineWidth(0.7).moveTo(40, doc.y).lineTo(220, doc.y).stroke();
      doc.moveDown(0.3);
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#0f172a').text(safe(doctor.full_name), 40, doc.y);
      doc.moveDown(1.0);

      // ===== FOOTER =====
      doc.strokeColor('#cbd5e1').lineWidth(0.3).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
      doc.moveDown(0.2);
      doc.fontSize(6).font('Helvetica').fillColor(muted)
        .text(`Digitally signed · Rx-ID ${rxHash(rx)} · ${safe(rx.delivery_method || 'app')} delivery · Generated by TatvaCare on VedaDB`, 40, doc.y);
      doc.moveDown(0.2);
      doc.fontSize(5.5).fillColor('#94a3b8')
        .text('This is a computer-generated prescription. Verify with the issuing doctor before dispensing.', 40, doc.y);

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
