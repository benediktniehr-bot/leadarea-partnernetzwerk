const nodemailer = require('nodemailer');
const { formatVatRate } = require('./vat');
const { generatePdfBuffer } = require('./stammdatenblatt');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.example.com',
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
  },
});

const FROM = process.env.SMTP_FROM || '"LeadArea" <noreply@leadarea.ch>';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Interne Empfänger (Frank + Jens), überschreibbar per Env-Variable
const ADMIN_EMAILS = (
  process.env.ADMIN_NOTIFY_EMAILS || 'jens.kudoke@dmp-consult.de,frank.timmann@dmp-group.de'
).split(',').map(e => e.trim());

async function sendLeadsReadyMail({ toEmail, firstName, productName, count }) {
  const subject = `${count} neue Lead${count !== 1 ? 's' : ''} verfügbar – ${productName}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Neue Leads bereit zum Download</h2>
      <p>Hallo ${firstName},</p>
      <p>
        für Ihre Bestellung <strong>${productName}</strong> stehen jetzt
        <strong>${count} neue Lead${count !== 1 ? 's' : ''}</strong> zum Download bereit.
      </p>
      <p style="margin:28px 0;">
        <a href="${BASE_URL}/dashboard/leads"
           style="background:#4361ee;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;">
          Jetzt herunterladen
        </a>
      </p>
      <p style="color:#666;font-size:0.85rem;">
        Sie erhalten diese E-Mail, weil Sie Leads bei LeadArea bestellt haben.<br>
        Bei Fragen antworten Sie einfach auf diese Mail.
      </p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] SMTP nicht konfiguriert – Mail würde gehen an: ${toEmail} | Betreff: ${subject}`);
    return;
  }

  await transporter.sendMail({ from: FROM, to: toEmail, subject, html });
}

async function sendImportNotification({ supplierName, productName, categoryName, imported, duplicates, blacklisted, invalid }) {
  const total = imported + duplicates + blacklisted + invalid;
  const subject = `Neue Einlieferung: ${supplierName} – ${imported} Leads (${productName})`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Neue Lead-Einlieferung</h2>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px 0;color:#666;width:160px;">Lieferant</td><td><strong>${supplierName}</strong></td></tr>
        <tr><td style="padding:8px 0;color:#666;">Branche</td><td>${categoryName} → ${productName}</td></tr>
        <tr style="background:#f0fdf4;"><td style="padding:8px 4px;color:#666;">Importiert</td><td><strong style="color:#16a34a;">${imported}</strong> von ${total} Datensätzen</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Dubletten</td><td style="color:${duplicates > 0 ? '#d97706' : '#999'};">${duplicates}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Blacklist</td><td style="color:${blacklisted > 0 ? '#dc2626' : '#999'};">${blacklisted}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Ungültig</td><td style="color:${invalid > 0 ? '#dc2626' : '#999'};">${invalid}</td></tr>
      </table>
      <p style="margin:20px 0;">
        <a href="${BASE_URL}/admin/pool/import" style="background:#4361ee;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Im Admin ansehen</a>
      </p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Import-Benachrichtigung (kein SMTP): ${supplierName} | ${imported} Leads | ${productName}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to: ADMIN_EMAILS, subject, html });
}

async function sendOrderNotification({ buyerName, buyerEmail, orderId, items, total }) {
  const subject = `Neuer Kauf: ${buyerName} – ${total.toFixed(2).replace('.', ',')} €`;
  const rows = items.map(i =>
    `<tr><td style="padding:6px 4px;">${i.product_name}</td><td style="padding:6px 4px;text-align:center;">${i.quantity}</td><td style="padding:6px 4px;text-align:right;">${(i.unit_price * i.quantity).toFixed(2).replace('.', ',')} €</td></tr>`
  ).join('');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Neuer Kauf eingegangen</h2>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px 0;color:#666;width:160px;">Käufer</td><td><strong>${buyerName}</strong></td></tr>
        <tr><td style="padding:8px 0;color:#666;">E-Mail</td><td>${buyerEmail}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Bestellung</td><td>#${orderId}</td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden;">
        <thead><tr style="background:#e5e7eb;">
          <th style="padding:8px 4px;text-align:left;">Produkt</th>
          <th style="padding:8px 4px;text-align:center;">Anzahl</th>
          <th style="padding:8px 4px;text-align:right;">Betrag</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="border-top:2px solid #d1d5db;">
          <td colspan="2" style="padding:8px 4px;font-weight:700;">Gesamt</td>
          <td style="padding:8px 4px;text-align:right;font-weight:700;">${total.toFixed(2).replace('.', ',')} €</td>
        </tr></tfoot>
      </table>
      <p style="margin:20px 0;">
        <a href="${BASE_URL}/admin/orders" style="background:#4361ee;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Bestellungen verwalten</a>
      </p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Kauf-Benachrichtigung (kein SMTP): ${buyerName} | ${total.toFixed(2)} € | Bestellung #${orderId}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to: ADMIN_EMAILS, subject, html });
}

async function sendInvoiceEmail({ buyerName, buyerEmail, invoiceNumber, invoiceDate, orderId, items, netTotal, vatTotal, grossTotal, vatRate = 0.19, vatApplies = true }) {
  const subject = `Ihre Rechnung ${invoiceNumber} – LeadArea`;
  const rows = items.map(i =>
    `<tr><td style="padding:6px 4px;">${i.product_name}</td><td style="padding:6px 4px;text-align:center;">${i.quantity}</td><td style="padding:6px 4px;text-align:right;">${(i.unit_price * i.quantity).toFixed(2).replace('.', ',')} €</td></tr>`
  ).join('');
  const vatLabel = vatApplies
    ? `zzgl. ${formatVatRate(vatRate)}% MwSt.`
    : 'MwSt. (steuerfreie Auslandsleistung)';
  const reverseChargeNote = vatApplies ? '' :
    '<p style="color:#666;font-size:0.8rem;">Steuerfreie Auslandsleistung – Steuerschuldnerschaft ggf. beim Leistungsempfänger.</p>';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Vielen Dank für Ihren Einkauf!</h2>
      <p>Hallo ${buyerName},</p>
      <p>anbei Ihre Rechnung <strong>${invoiceNumber}</strong> vom ${invoiceDate} zu Bestellung #${orderId}.</p>
      <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden;margin:16px 0;">
        <thead><tr style="background:#e5e7eb;">
          <th style="padding:8px 4px;text-align:left;">Produkt</th>
          <th style="padding:8px 4px;text-align:center;">Anzahl</th>
          <th style="padding:8px 4px;text-align:right;">Betrag</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#666;">Zwischensumme (netto)</td><td style="text-align:right;">${netTotal.toFixed(2).replace('.', ',')} €</td></tr>
        <tr><td style="padding:4px 0;color:#666;">${vatLabel}</td><td style="text-align:right;">${vatTotal.toFixed(2).replace('.', ',')} €</td></tr>
        <tr style="border-top:2px solid #d1d5db;"><td style="padding:8px 0;font-weight:700;">Gesamt</td><td style="text-align:right;font-weight:700;">${grossTotal.toFixed(2).replace('.', ',')} €</td></tr>
      </table>
      ${reverseChargeNote}
      <p style="margin:20px 0;">
        <a href="${BASE_URL}/dashboard/invoices" style="background:#4361ee;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Rechnung online ansehen</a>
      </p>
      <p style="color:#666;font-size:0.85rem;">Der Betrag wurde bereits über die Bestellung beglichen.</p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Rechnungsmail (kein SMTP): an ${buyerEmail} | ${invoiceNumber} | ${grossTotal.toFixed(2)} €`);
    return;
  }
  await transporter.sendMail({ from: FROM, to: buyerEmail, subject, html });
}

async function sendPaymentRequestEmail({ buyerName, buyerEmail, invoiceNumber, invoiceDate, orderId, items, netTotal, vatTotal, grossTotal, vatRate = 0, vatApplies = true, bank, pdfBuffer }) {
  const subject = `Deine Bestellung #${orderId} – Rechnung ${invoiceNumber} (Zahlung per Überweisung)`;
  const rows = items.map(i =>
    `<tr><td style="padding:6px 4px;">${i.product_name}</td><td style="padding:6px 4px;text-align:center;">${i.quantity}</td><td style="padding:6px 4px;text-align:right;">${(i.unit_price * i.quantity).toFixed(2).replace('.', ',')} €</td></tr>`
  ).join('');
  const vatLabel = vatApplies
    ? `zzgl. ${formatVatRate(vatRate)}% MwSt.`
    : 'MwSt. (steuerfreie Auslandsleistung)';
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Herzlich willkommen bei LeadArea!</h2>
      <p>Hallo ${buyerName},</p>
      <p>schön, dass du dich für LeadArea entschieden hast – vielen Dank für deine Bestellung!</p>
      <p>Anbei deine Rechnung <strong>${invoiceNumber}</strong> vom ${invoiceDate} zu Bestellung #${orderId}.
      Bitte überweise den Gesamtbetrag auf das untenstehende Konto – sobald die Zahlung bei uns eingegangen ist,
      wird deine Bestellung produziert und die Leads werden dir zugewiesen.</p>
      <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;overflow:hidden;margin:16px 0;">
        <thead><tr style="background:#e5e7eb;">
          <th style="padding:8px 4px;text-align:left;">Produkt</th>
          <th style="padding:8px 4px;text-align:center;">Anzahl</th>
          <th style="padding:8px 4px;text-align:right;">Betrag</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <table style="width:100%;border-collapse:collapse;">
        <tr><td style="padding:4px 0;color:#666;">Zwischensumme (netto)</td><td style="text-align:right;">${netTotal.toFixed(2).replace('.', ',')} €</td></tr>
        <tr><td style="padding:4px 0;color:#666;">${vatLabel}</td><td style="text-align:right;">${vatTotal.toFixed(2).replace('.', ',')} €</td></tr>
        <tr style="border-top:2px solid #d1d5db;"><td style="padding:8px 0;font-weight:700;">Gesamt</td><td style="text-align:right;font-weight:700;">${grossTotal.toFixed(2).replace('.', ',')} €</td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;background:#eff6ff;border-radius:8px;margin:20px 0;padding:4px;">
        <tr><td colspan="2" style="padding:10px 12px 2px;font-weight:700;color:#1a1a2e;">Bankverbindung für deine Überweisung</td></tr>
        <tr><td style="padding:2px 12px;color:#666;width:140px;">Kontoinhaber</td><td style="padding:2px 12px;">${bank.kontoinhaber}</td></tr>
        <tr><td style="padding:2px 12px;color:#666;">IBAN</td><td style="padding:2px 12px;">${bank.iban}</td></tr>
        <tr><td style="padding:2px 12px;color:#666;">BIC</td><td style="padding:2px 12px;">${bank.bic}</td></tr>
        <tr><td style="padding:2px 12px;color:#666;">Bank</td><td style="padding:2px 12px;">${bank.bankname}</td></tr>
        <tr><td style="padding:2px 12px 10px;color:#666;">Verwendungszweck</td><td style="padding:2px 12px 10px;"><strong>Bestellung #${orderId}</strong></td></tr>
      </table>
      <p style="margin:20px 0;">
        <a href="${BASE_URL}/dashboard/invoices" style="background:#4361ee;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Rechnung online ansehen</a>
      </p>
      <p style="color:#666;font-size:0.85rem;">Bei Fragen antworte einfach auf diese Mail.</p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Zahlungsaufforderung (kein SMTP): an ${buyerEmail} | ${invoiceNumber} | ${grossTotal.toFixed(2)} € | Bestellung #${orderId}${pdfBuffer ? ' | PDF-Anhang: ' + pdfBuffer.length + ' Bytes' : ' | KEIN PDF-Anhang'}`);
    return;
  }
  const attachments = pdfBuffer
    ? [{ filename: `${invoiceNumber}.pdf`, content: pdfBuffer, contentType: 'application/pdf' }]
    : [];
  await transporter.sendMail({ from: FROM, to: buyerEmail, subject, html, attachments });
}

async function sendPaymentReceivedEmail({ buyerName, buyerEmail, orderId }) {
  const subject = `Zahlung eingegangen – Bestellung #${orderId} wird jetzt bearbeitet`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Zahlung eingegangen</h2>
      <p>Hallo ${buyerName},</p>
      <p>wir haben deine Zahlung zu Bestellung <strong>#${orderId}</strong> erhalten. Deine Leads werden jetzt
      produziert und dir zugewiesen – du bekommst eine separate Benachrichtigung, sobald sie zum Download bereitstehen.</p>
      <p style="margin:20px 0;">
        <a href="${BASE_URL}/dashboard/leads" style="background:#4361ee;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Zum Dashboard</a>
      </p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Zahlungseingang-Bestätigung (kein SMTP): an ${buyerEmail} | Bestellung #${orderId}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to: buyerEmail, subject, html });
}

async function sendPasswordResetMail({ toEmail, firstName, resetToken }) {
  const subject = 'Dein neues Passwort für LeadArea';
  const resetUrl = `${BASE_URL}/reset-password/${resetToken}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Passwort zurücksetzen</h2>
      <p>Hallo ${firstName},</p>
      <p>du hast angefragt, dein Passwort bei LeadArea zurückzusetzen. Klicke auf den Button, um ein neues Passwort zu vergeben. Der Link ist 1 Stunde gültig.</p>
      <p style="margin:20px 0;">
        <a href="${resetUrl}" style="background:#4361ee;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Neues Passwort vergeben</a>
      </p>
      <p style="color:#666;font-size:0.9rem;">Wenn du das nicht warst, kannst du diese Mail einfach ignorieren – es ändert sich nichts an deinem Konto.</p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Passwort-Reset-Mail (kein SMTP): an ${toEmail} | Link: ${resetUrl}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to: toEmail, subject, html });
}

async function sendReaccessRequest({ buyerName, buyerEmail, leadDisplay, phone, productName, assignmentId }) {
  const subject = `Erneuter Download angefragt: ${buyerName} – ${productName}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Anfrage: Erneuter Lead-Download</h2>
      <p>Ein Käufer möchte einen bereits heruntergeladenen Lead erneut herunterladen.</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px 0;color:#666;width:160px;">Käufer</td><td><strong>${buyerName}</strong></td></tr>
        <tr><td style="padding:8px 0;color:#666;">E-Mail</td><td>${buyerEmail}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Branche</td><td>${productName}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Datensatz</td><td>${leadDisplay}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Telefon</td><td>${phone}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Zuweisungs-ID</td><td>#${assignmentId}</td></tr>
      </table>
      <p style="margin:20px 0;">
        <a href="${BASE_URL}/admin/pool/search" style="background:#4361ee;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Im Admin freigeben</a>
      </p>
      <p style="color:#666;font-size:0.85rem;">Freigabe erfolgt manuell nach Prüfung durch das Team.</p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Re-Access-Anfrage (kein SMTP): ${buyerName} (${buyerEmail}) moechte Zuweisung #${assignmentId} (${leadDisplay}) erneut herunterladen`);
    return;
  }
  await transporter.sendMail({ from: FROM, to: ADMIN_EMAILS, subject, html });
}

async function sendOptOutNotification({ buyerName, buyerEmail, leadDisplay, phone, productName }) {
  const subject = `Widerruf der Einwilligung – Bitte Kontaktaufnahme einstellen`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#dc2626;">Widerruf der Einwilligung</h2>
      <p>Hallo ${buyerName},</p>
      <p>
        folgender Datensatz aus Ihrer Bestellung <strong>${productName}</strong> hat seine
        Einwilligung zur Kontaktaufnahme <strong>widerrufen</strong>:
      </p>
      <table style="width:100%;border-collapse:collapse;background:#fef2f2;border-radius:8px;padding:16px;margin:16px 0;">
        <tr><td style="padding:6px 0;color:#666;width:120px;">Datensatz</td><td><strong>${leadDisplay}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#666;">Telefon</td><td><strong>${phone}</strong></td></tr>
      </table>
      <p style="background:#fef2f2;border-left:4px solid #dc2626;padding:12px 16px;border-radius:4px;">
        <strong>Bitte stellen Sie jede weitere Kontaktaufnahme mit dieser Person sofort ein.</strong><br>
        Gemäß §7 UWG und DSGVO Art. 21 ist eine weitere Kontaktaufnahme unzulässig.
      </p>
      <p style="color:#666;font-size:0.85rem;margin-top:24px;">
        Diese Nachricht wurde automatisch durch LeadArea generiert. Bei Fragen antworten Sie auf diese E-Mail.
      </p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Opt-out-Notify (kein SMTP): an ${buyerEmail} | ${leadDisplay} | ${phone}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to: buyerEmail, subject, html });
}

async function sendPartnerApplicationNotification({ company, firstName, lastName, phone, email, country, projectNames, appointmentRequest, message }) {
  const subject = `Neue Partner-Bewerbung: ${company}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Neue Partner-Bewerbung (Partner-LeadArea)</h2>
      <table style="width:100%;border-collapse:collapse;margin:16px 0;">
        <tr><td style="padding:8px 0;color:#666;width:160px;">Firma</td><td><strong>${company}</strong></td></tr>
        <tr><td style="padding:8px 0;color:#666;">Ansprechpartner</td><td>${firstName} ${lastName}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Land</td><td>${country}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Telefon</td><td>${phone}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">E-Mail</td><td>${email}</td></tr>
        <tr><td style="padding:8px 0;color:#666;">Interessiert an</td><td>${projectNames.length ? projectNames.join(', ') : '-'}</td></tr>
        <tr style="background:#f0fdf4;"><td style="padding:8px 4px;color:#666;">Terminwunsch</td><td><strong>${appointmentRequest || '-'}</strong></td></tr>
      </table>
      ${message ? `<p style="color:#666;"><strong>Nachricht:</strong> ${message}</p>` : ''}
      <p style="margin:20px 0;">
        <a href="${BASE_URL}/admin/partners" style="background:#4361ee;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Im Admin ansehen</a>
      </p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Partner-Bewerbung (kein SMTP): ${company} | Termin: ${appointmentRequest || '-'} | Projekte: ${projectNames.join(', ')}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to: ADMIN_EMAILS, subject, html });
}

async function sendPartnerWelcomeMail({ toEmail, firstName, company, stammdaten }) {
  const subject = `Willkommen bei LeadArea, ${firstName}!`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Willkommen bei LeadArea, ${firstName}!</h2>
      <p>Hallo ${firstName},</p>
      <p>schön, dass ${company} Teil unseres Partner-Netzwerks werden möchte. Bevor es losgeht, brauchen wir noch zwei Dinge von euch:</p>
      <p><strong>1. Stammdatenblatt</strong><br>
      Im Anhang findet ihr unser Stammdatenblatt. Bitte vollständig ausfüllen, unterschreiben und per Antwort auf diese E-Mail an uns zurücksenden.</p>
      <p><strong>2. 3 Voicefiles</strong><br>
      Damit wir uns ein Bild von eurem Team machen können (Gesprächsqualität, Deutschkenntnisse der Agenten), schickt uns bitte zusätzlich 3 Beispiel-Voicefiles mit.</p>
      <p>Sobald uns beides vorliegt, melden wir uns zeitnah bei euch.</p>
      <p style="margin-top:28px;">Beste Grüße<br>Dein Team von LeadArea</p>
      <p style="color:#666;font-size:0.9rem;margin-top:12px;">Bei Fragen antworte einfach auf diese Mail.</p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Partner-Welcome-Mail (kein SMTP): an ${toEmail} | ${company}`);
    return;
  }
  const pdfBuffer = generatePdfBuffer(stammdaten);
  const attachments = pdfBuffer
    ? [{ filename: 'LeadArea_Stammdatenblatt.pdf', content: pdfBuffer }]
    : [];
  await transporter.sendMail({ from: FROM, to: toEmail, subject, html, attachments });
}

// Wird erst verschickt, wenn Jens/Frank den Partner im Admin auf "Angenommen"
// setzt (Vertrag liegt vor) - nicht schon bei der Bewerbung, siehe
// routes/partner.js/routes/admin.js (Feedback Benni, 2026-10-29: Passwort-
// Abfrage direkt bei Erstkontakt schreckt Interessenten ab).
async function sendPartnerAccountActivationMail({ toEmail, firstName, resetToken }) {
  const subject = 'Dein Zugang bei LeadArea ist freigeschaltet';
  const activationUrl = `${BASE_URL}/reset-password/${resetToken}`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;">
      <h2 style="color:#1a1a2e;">Willkommen im Partner-Dashboard</h2>
      <p>Hallo ${firstName},</p>
      <p>dein Partner-Zugang bei LeadArea ist jetzt freigeschaltet. Klicke auf den Button, um dir ein eigenes Passwort zu vergeben und dich danach einzuloggen. Der Link ist 7 Tage gültig.</p>
      <p style="margin:20px 0;">
        <a href="${activationUrl}" style="background:#4361ee;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Passwort festlegen</a>
      </p>
      <p style="margin-top:28px;">Beste Grüße<br>Dein Team von LeadArea</p>
    </div>`;

  if (!process.env.SMTP_HOST) {
    console.log(`[Mailer] Partner-Freigabe-Mail (kein SMTP): an ${toEmail} | Link: ${activationUrl}`);
    return;
  }
  await transporter.sendMail({ from: FROM, to: toEmail, subject, html });
}

module.exports = { sendLeadsReadyMail, sendImportNotification, sendOrderNotification, sendInvoiceEmail, sendPaymentRequestEmail, sendPaymentReceivedEmail, sendReaccessRequest, sendOptOutNotification, sendPartnerApplicationNotification, sendPartnerWelcomeMail, sendPasswordResetMail, sendPartnerAccountActivationMail };
