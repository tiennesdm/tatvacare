import PDFDocument from 'pdfkit';
import fs from 'fs';
const doc = new PDFDocument({ size: 'A4', margin: 40 });
const out = fs.createWriteStream('/tmp/test-layout.pdf');
doc.pipe(out);

// content fills page 1
for (let i = 0; i < 30; i++) doc.text(`Line ${i+1}`);

console.log('doc.y after loop:', doc.y, 'page height:', doc.page.height);

const footY = doc.page.height - 30;
console.log('footY:', footY);
doc.text('FOOTER TEXT HERE', 40, footY, { lineBreak: false });

doc.end();
await new Promise(r => out.on('finish', r));
