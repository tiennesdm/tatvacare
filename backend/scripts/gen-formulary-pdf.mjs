// Generate a PDF formulary reference — comprehensive drug monographs
// for offline use / printing. ~110 drugs, ~25-40 pages.
import PDFDocument from 'pdfkit';
import { INDIAN_FORMULARY } from '/Users/shubhammehta/Downloads/tatvacare/backend/lib/formulary.mjs';
import fs from 'fs';

function safe(s) { return s == null || s === 'NULL' ? '' : String(s); }
function isEmpty(s) { return s == null || s === 'NULL' || s === ''; }

function generatePdf() {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40, bufferPages: true,
      info: { Title: 'TatvaCare Indian Primary Care Formulary', Author: 'TatvaCare', Subject: 'Drug monographs for primary care' } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const accent = '#2563eb';
    const muted = '#64748b';
    const pageW = doc.page.width - 80;

    // ===== COVER PAGE =====
    doc.fillColor(accent).fontSize(36).font('Helvetica-Bold').text('TatvaCare', 40, 200);
    doc.fillColor('#0f172a').fontSize(22).font('Helvetica-Bold').text('Indian Primary Care', 40, 250);
    doc.fontSize(22).text('Drug Formulary', 40, 280);
    doc.moveDown(2);
    doc.fontSize(12).font('Helvetica').fillColor(muted)
      .text(`${INDIAN_FORMULARY.length} essential drugs · Class · Indications · Dose · Side effects · Interactions · Schedule`, 40, 340, { width: pageW });
    doc.moveDown(2);
    doc.fontSize(10).text('Sources: CDSCO NLEM 2022 · WHO EML 2023 · Current Indian prescribing patterns', 40, 380, { width: pageW });
    doc.fontSize(8).fillColor('#94a3b8').text('Generated 21 Jun 2026 · For educational and reference use only. Always verify with current guidelines before prescribing.', 40, 400, { width: pageW });

    // Sample of drug categories on cover
    const cats = [...new Set(INDIAN_FORMULARY.map(d => d.class))];
    doc.moveDown(3);
    doc.fillColor(accent).fontSize(11).font('Helvetica-Bold').text('Drug categories covered:', 40);
    doc.fontSize(9).font('Helvetica').fillColor('#0f172a');
    const catText = cats.join(' · ');
    doc.text(catText, 40, doc.y, { width: pageW, lineGap: 2 });

    // ===== TABLE OF CONTENTS =====
    doc.addPage();
    doc.fillColor(accent).fontSize(20).font('Helvetica-Bold').text('Table of Contents', 40);
    doc.moveDown(1);
    const sorted = [...INDIAN_FORMULARY].sort((a, b) => a.name.localeCompare(b.name));
    const colW = (pageW - 20) / 2;
    const t0 = doc.y;
    sorted.forEach((d, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = 40 + col * (colW + 20);
      const y = t0 + row * 14;
      doc.fontSize(9).font('Helvetica').fillColor('#0f172a').text(d.name, x, y, { width: colW, lineBreak: false, continued: false });
      doc.fillColor(muted).text(d.class, x + 140, y, { width: colW - 140, lineBreak: false });
    });

    // ===== MONOGRAPHS =====
    doc.addPage();
    let count = 0;
    for (const d of sorted) {
      // Each drug: 1 page ideally; some may need 2 if lots of content
      // Manual page break before each major heading
      if (count > 0) doc.addPage();
      count++;

      // ===== HEADER =====
      doc.fillColor(accent).fontSize(16).font('Helvetica-Bold').text(d.name, 40, 40);
      doc.fontSize(10).font('Helvetica').fillColor(muted).text(safe(d.brand), 40, 60);
      doc.fontSize(9).font('Helvetica-Oblique').fillColor('#475569').text(safe(d.class), 40, 76);

      // Schedule / Rx / Pregnancy pills
      let pillX = 40;
      const pillY = 92;
      const drawPill = (text, color) => {
        doc.save();
        doc.fillColor(color).fontSize(8).font('Helvetica-Bold')
          .text(text, pillX + 6, pillY + 4, { lineBreak: false });
        doc.restore();
        // estimate width
        const w = doc.widthOfString(text, { font: 'Helvetica-Bold', size: 8 });
        pillX += w + 20;
      };
      // Use stroke boxes
      drawPill('Schedule ' + d.schedule, '#0f172a');
      drawPill(d.rx_required ? 'Rx required' : 'OTC', d.rx_required ? '#dc2626' : '#16a34a');
      const pregColor = d.pregnancy && d.pregnancy.toLowerCase().includes('contraindicated') ? '#dc2626' : '#0f172a';
      drawPill('Pregnancy: ' + (d.pregnancy || 'unknown'), pregColor);

      doc.moveDown(4);
      let y = 110;

      // Indications
      doc.fillColor(muted).fontSize(7).font('Helvetica-Bold').text('INDICATIONS', 40, y);
      y += 12;
      for (const ind of d.indications || []) {
        doc.fillColor('#0f172a').fontSize(9).font('Helvetica-Bold').text(safe(ind.icd10), 40, y);
        doc.fontSize(9).font('Helvetica').fillColor('#0f172a').text('  ' + safe(ind.label), 40 + 50, y);
        y = doc.y + 2;
      }
      y += 4;

      // Adult dose
      doc.fillColor(muted).fontSize(7).font('Helvetica-Bold').text('ADULT DOSE', 40, y);
      y += 12;
      doc.fillColor('#0f172a').fontSize(10).font('Helvetica').text(safe(d.adult_dose), 40, y, { width: pageW });
      y = doc.y + 4;

      // Mechanism
      doc.fillColor(muted).fontSize(7).font('Helvetica-Bold').text('MECHANISM', 40, y);
      y += 12;
      doc.fillColor('#0f172a').fontSize(9).font('Helvetica').text(safe(d.mechanism), 40, y, { width: pageW, lineGap: 1 });
      y = doc.y + 4;

      // Side effects (yellow box)
      doc.fillColor('#fef3c7').rect(40, y, pageW, 14).fill();
      doc.fillColor('#92400e').fontSize(7).font('Helvetica-Bold').text('SIDE EFFECTS', 46, y + 3);
      doc.fillColor('#451a03').fontSize(9).font('Helvetica').text(safe(d.side_effects), 40, y + 14, { width: pageW });
      y = doc.y + 4;

      // Contraindications (red box)
      const ciHeight = Math.max(14, doc.heightOfString(safe(d.ci), { width: pageW, font: 'Helvetica', size: 9 }) + 8);
      doc.fillColor('#fee2e2').rect(40, y, pageW, ciHeight).fill();
      doc.fillColor('#dc2626').fontSize(7).font('Helvetica-Bold').text('CONTRAINDICATIONS', 46, y + 3);
      doc.fillColor('#7f1d1d').fontSize(9).font('Helvetica').text(safe(d.ci), 40, y + 14, { width: pageW });
      y = doc.y + 4;

      // Pregnancy
      doc.fillColor('#dbeafe').rect(40, y, pageW, 14).fill();
      doc.fillColor('#1e40af').fontSize(7).font('Helvetica-Bold').text('PREGNANCY', 46, y + 3);
      doc.fillColor('#1e3a8a').fontSize(9).font('Helvetica').text(safe(d.pregnancy), 40, y + 14, { width: pageW });
      y = doc.y + 4;

      // Interactions
      const intHeight = Math.max(14, doc.heightOfString(safe(d.interactions), { width: pageW, font: 'Helvetica', size: 9 }) + 8);
      doc.fillColor('#f1f5f9').rect(40, y, pageW, intHeight).fill();
      doc.fillColor('#475569').fontSize(7).font('Helvetica-Bold').text('KEY INTERACTIONS', 46, y + 3);
      doc.fillColor('#0f172a').fontSize(9).font('Helvetica').text(safe(d.interactions), 40, y + 14, { width: pageW });
      y = doc.y + 4;

      // Keywords
      if (d.keywords && d.keywords.length > 0) {
        doc.fillColor(muted).fontSize(7).font('Helvetica-Bold').text('ALSO KNOWN AS', 40, y);
        y += 10;
        doc.fillColor('#475569').fontSize(8).font('Helvetica').text(d.keywords.join(' · '), 40, y, { width: pageW });
      }
    }

    doc.end();
  });
}

const pdf = await generatePdf();
fs.writeFileSync('/Users/shubhammehta/Downloads/tatvacare/artifacts/indian-formulary.pdf', pdf);
console.log('PDF generated:', pdf.length, 'bytes');
