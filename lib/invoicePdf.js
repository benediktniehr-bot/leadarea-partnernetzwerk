const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SELLER, BANK_DETAILS } = require('./companyInfo');
const { formatVatRate } = require('./vat');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const LOGO_SVG = `<svg width="34" height="34" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect width="64" height="64" rx="14" fill="#059669"/>
  <text x="32" y="45" font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="800" fill="#ffffff" text-anchor="middle">L</text>
</svg>`;

function money(n) {
  return n.toFixed(2).replace('.', ',') + ' €';
}

// Baut die eigenständige HTML-Seite für eine Rechnung als klassischer
// Geschäftsbrief nach DIN 5008 (Briefkopf, Rücksendeangabe + Anschriftenfeld,
// Datum/Bezug rechts, Betreff, Anrede, Brieftext, dann Rechnungsinhalt,
// Grußformel, Fußzeile) - genutzt sowohl für den PDF-Export (Mail-Anhang,
// Download) als auch für die Druckansicht.
function renderInvoiceHtml({ invoiceNumber, invoiceDate, orderId, orderStatus, buyer, items, netTotal, vatTotal, grossTotal, vatRate, vatApplies }) {
  const rows = items.map(i => `
    <tr>
      <td>${i.product_name}</td>
      <td style="text-align:center;">${i.quantity}</td>
      <td style="text-align:right;">${money(i.unit_price)}</td>
      <td style="text-align:right;">${money(i.unit_price * i.quantity)}</td>
    </tr>`).join('');

  const vatLabel = vatApplies ? `zzgl. ${formatVatRate(vatRate)}% MwSt.` : 'MwSt. (steuerfreie Auslandsleistung)';
  const reverseChargeNote = vatApplies ? '' :
    '<p class="small muted">Steuerfreie Auslandsleistung – Steuerschuldnerschaft ggf. beim Leistungsempfänger.</p>';

  const paymentBlock = orderStatus === 'pending' ? `
    <div class="bank-box">
      <div class="bank-title">Bitte überweisen Sie den Betrag auf folgendes Konto</div>
      <table class="bank-table">
        <tr><td>Kontoinhaber</td><td>${BANK_DETAILS.kontoinhaber}</td></tr>
        <tr><td>IBAN</td><td>${BANK_DETAILS.iban}</td></tr>
        <tr><td>BIC</td><td>${BANK_DETAILS.bic}</td></tr>
        <tr><td>Bank</td><td>${BANK_DETAILS.bankname}</td></tr>
        <tr><td>Verwendungszweck</td><td><strong>Bestellung #${orderId}</strong></td></tr>
      </table>
    </div>` : `
    <p class="small muted" style="margin-top:18px;">Der Betrag wurde bereits über die Bestellung beglichen.</p>`;

  const returnAddressLine = `${SELLER.name} &middot; ${SELLER.address}`;

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Rechnung ${invoiceNumber}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body {
    font-family: Arial, Helvetica, sans-serif; color: #1f2421; font-size: 12.5px;
    margin: 0; width: 210mm; min-height: 297mm;
    padding: 20mm 20mm 18mm 25mm;
  }

  /* Briefkopf */
  .letterhead { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-bottom: 8mm; }
  .letterhead .word { font-size: 1.3rem; font-weight: 800; letter-spacing: -0.02em; }
  .letterhead .word .area { color: #059669; }

  /* Anschriftenfeld (DIN 5008) links, Datum/Bezug rechts auf gleicher Höhe */
  .address-zone { display: flex; justify-content: space-between; align-items: flex-start; height: 40mm; margin-bottom: 6mm; }
  .address-field { width: 85mm; }
  .return-line { font-size: 7.5px; color: #8b9089; border-bottom: 1px solid #c9cdc7; padding-bottom: 3mm; margin-bottom: 4mm; }
  .recipient .name { font-weight: 700; }
  .recipient div { line-height: 1.5; }
  .meta-box { width: 60mm; font-size: 0.85rem; text-align: left; margin-top: 2mm; }
  .meta-box .row { display: flex; justify-content: space-between; padding: 2px 0; color: #595f5a; }
  .meta-box .row strong { color: #1f2421; }

  .subject { font-weight: 700; font-size: 1.02rem; margin: 2mm 0 5mm; }
  .salutation { margin: 0 0 3mm; }
  .intro { margin: 0 0 6mm; }

  table.items { width: 100%; border-collapse: collapse; margin-bottom: 4px; }
  table.items thead tr { background: #f1f4f2; }
  table.items th, table.items td { padding: 8px 10px; text-align: left; }
  table.items th { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: #595f5a; font-weight: 700; }
  table.items tbody tr { border-bottom: 1px solid #e7e9e7; }
  .totals { width: 280px; margin-left: auto; margin-top: 10px; }
  .totals .row { display: flex; justify-content: space-between; padding: 3px 0; color: #595f5a; }
  .totals .row.grand { border-top: 2px solid #1f2421; margin-top: 6px; padding-top: 8px; font-weight: 800; font-size: 1.05rem; color: #1f2421; }
  .bank-box { background: #eff6f1; border-radius: 8px; padding: 14px 18px; margin-top: 22px; }
  .bank-title { font-weight: 700; margin-bottom: 6px; }
  .bank-table td { padding: 1px 10px 1px 0; vertical-align: top; }
  .bank-table td:first-child { color: #595f5a; width: 130px; }
  .usage-note { margin-top: 20px; background: #f7f7f5; border-radius: 6px; padding: 12px 16px; font-size: 0.82rem; color: #4b5048; }
  .closing { margin-top: 10mm; }
  .closing .company { margin-top: 1mm; font-weight: 700; }
  .small { font-size: 0.8rem; }
  .muted { color: #595f5a; }

  .footer {
    position: fixed; left: 25mm; right: 20mm; bottom: 10mm;
    padding-top: 3mm; border-top: 1px solid #e7e9e7;
    font-size: 7.5px; color: #8b9089;
    display: flex; justify-content: space-between; gap: 16px;
  }
  .footer .col { flex: 1; }
  .footer .col b { color: #595f5a; display: block; margin-bottom: 1mm; }
</style></head>
<body>
  <div class="letterhead">${LOGO_SVG}<span class="word">Lead<span class="area">Area</span></span></div>

  <div class="address-zone">
    <div class="address-field">
      <div class="return-line">${returnAddressLine}</div>
      <div class="recipient">
        <div class="name">${buyer.company || ''}</div>
        <div>${buyer.first_name} ${buyer.last_name}</div>
        <div>${buyer.street || ''} ${buyer.house_number || ''}</div>
        <div>${buyer.postal_code || ''} ${buyer.city || ''}</div>
      </div>
    </div>
    <div class="meta-box">
      <div class="row"><span>Rechnungs-Nr.</span><strong>${invoiceNumber}</strong></div>
      <div class="row"><span>Datum</span><strong>${invoiceDate}</strong></div>
      <div class="row"><span>Bestellung</span><strong>#${orderId}</strong></div>
      <div class="row" style="margin-top:4mm;"><span>${SELLER.vatId}</span></div>
    </div>
  </div>

  <p class="subject">Rechnung ${invoiceNumber}</p>
  <p class="salutation">Sehr geehrte Damen und Herren,</p>
  <p class="intro">vielen Dank für Ihre Bestellung bei LeadArea. Nachfolgend erhalten Sie die Rechnung zu Ihrer Bestellung #${orderId}:</p>

  <table class="items">
    <thead><tr><th>Produkt</th><th style="text-align:center;">Anzahl</th><th style="text-align:right;">Einzelpreis</th><th style="text-align:right;">Gesamt</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="totals">
    <div class="row"><span>Zwischensumme (netto)</span><span>${money(netTotal)}</span></div>
    <div class="row"><span>${vatLabel}</span><span>${money(vatTotal)}</span></div>
    <div class="row grand"><span>Gesamt</span><span>${money(grossTotal)}</span></div>
  </div>
  ${reverseChargeNote}

  <p class="usage-note">Die mit dieser Bestellung erworbenen Kontaktdaten dürfen ausschließlich zur Kontaktaufnahme bezüglich des jeweils bestellten Produkts/der jeweils bestellten Branche verwendet werden.</p>

  ${paymentBlock}

  <div class="closing">
    <p>Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.</p>
    <p>Mit freundlichen Grüßen</p>
    <p class="company">${SELLER.name}</p>
  </div>

  <div class="footer">
    <div class="col"><b>${SELLER.name}</b>${SELLER.address}<br>${SELLER.vatId}</div>
    <div class="col"><b>Bankverbindung</b>${BANK_DETAILS.bankname}<br>IBAN ${BANK_DETAILS.iban}<br>BIC ${BANK_DETAILS.bic}</div>
    <div class="col"><b>Kontakt</b>info@leadarea.ch<br>www.leadarea.ch</div>
  </div>
</body></html>`;
}

// Rendert die Rechnung zu einem PDF-Buffer via headless Chrome (gleiche
// Technik wie beim AGB-/Impressum-Export). Wirft, wenn Chrome nicht
// gefunden wird - Aufrufer sollte das abfangen und notfalls ohne Anhang senden.
function generateInvoicePdfBuffer(invoiceData) {
  const chrome = findChrome();
  if (!chrome) throw new Error('Chrome nicht gefunden - PDF-Generierung nicht möglich');

  const html = renderInvoiceHtml(invoiceData);
  const tmpDir = os.tmpdir();
  const stamp = Date.now() + '-' + Math.round(Math.random() * 1e6);
  const htmlPath = path.join(tmpDir, `invoice-${stamp}.html`);
  const pdfPath = path.join(tmpDir, `invoice-${stamp}.pdf`);

  fs.writeFileSync(htmlPath, html, 'utf8');
  try {
    execFileSync(chrome, [
      '--headless',
      '--disable-gpu',
      '--no-pdf-header-footer',
      `--print-to-pdf=${pdfPath}`,
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ], { stdio: 'ignore', timeout: 20000 });
    return fs.readFileSync(pdfPath);
  } finally {
    try { fs.unlinkSync(htmlPath); } catch (_) {}
    try { fs.unlinkSync(pdfPath); } catch (_) {}
  }
}

module.exports = { renderInvoiceHtml, generateInvoicePdfBuffer };
