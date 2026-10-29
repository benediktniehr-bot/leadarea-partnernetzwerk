const fs = require('fs');
const { getDb } = require('../database');
const { getBundeslandForPlz } = require('./plzBundesland');
const { saveRecordingLink } = require('./recordings');

// Bekannte Testnamen-Kombinationen (Vorname Nachname, lowercase)
const FAKE_NAME_COMBOS = new Set([
  'donald duck', 'daisy duck', 'mickey mouse', 'bugs bunny',
  'max mustermann', 'erika mustermann', 'max muster', 'anna muster',
  'john doe', 'jane doe', 'john smith', 'jane smith',
  'hans meier', 'hans maier', 'peter müller', 'karl müller', 'franz maier',
  'hans wurst', 'otto normal', 'test test', 'demo demo',
]);

// Einzelne Namen die auf Testdaten hinweisen
const FAKE_SINGLE_NAMES = new Set([
  'test', 'fake', 'demo', 'dummy', 'muster', 'beispiel', 'sample',
  'temp', 'asdf', 'qwert', 'xxxxx', 'aaaaa', 'bbbbb', 'nein', 'keiner', 'anon',
]);

function normalizePhone(raw) {
  if (!raw) return null;
  return raw.replace(/[\s\-\/\(\)\.]/g, '').replace(/^00/, '+');
}

function isValidPhone(phone) {
  if (!phone || !phone.trim()) return false;
  const normalized = normalizePhone(phone);
  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 15) return false;
  if (/^(.)\1+$/.test(digits)) return false; // alle gleichen Ziffern z.B. 0000000
  return true;
}

function isValidEmail(email) {
  if (!email || !email.trim()) return true; // E-Mail ist optional
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

// Voicefile ist Pflicht (Jens, 2026-10-21) - entweder als Datei hochgeladen
// (Live-API, siehe routes/api.js) oder, von Jens bevorzugt, als Link zur
// bereits gehosteten Aufnahme (CSV-Bulk-Weg). Kein Datei-Upload im CSV nötig,
// nur eine erreichbare URL pro Zeile.
function isValidVoiceLink(url) {
  if (!url || !url.trim()) return false;
  return /^https?:\/\/\S+$/i.test(url.trim());
}

function isFakeName(firstname, lastname, companyName) {
  const fn = (firstname || '').toLowerCase().trim();
  const ln = (lastname || '').toLowerCase().trim();
  const cn = (companyName || '').toLowerCase().trim();

  if (fn && ln && FAKE_NAME_COMBOS.has(`${fn} ${ln}`)) return true;
  if (fn && FAKE_SINGLE_NAMES.has(fn)) return true;
  if (ln && FAKE_SINGLE_NAMES.has(ln)) return true;
  if (cn && FAKE_SINGLE_NAMES.has(cn)) return true;
  return false;
}

function getMissingFields(leadType, { companyName, lastname, phone, postalCode }) {
  const missing = [];
  if (leadType === 'b2b') {
    if (!companyName && !lastname) missing.push('Firmenname/Nachname');
    if (!phone) missing.push('Telefon');
    if (!postalCode) missing.push('PLZ');
  } else {
    if (!lastname) missing.push('Nachname');
    if (!phone) missing.push('Telefon');
    if (!postalCode) missing.push('PLZ');
  }
  return missing;
}

function isBlacklisted(db, phone) {
  const normalized = normalizePhone(phone);
  if (!normalized) return false;
  return !!db.prepare('SELECT id FROM phone_blacklist WHERE phone = ?').get(normalized);
}

function isDuplicate(db, productId, phone, leadType, companyName, lastname, firstname, postalCode) {
  const normalizedPhone = normalizePhone(phone);
  if (normalizedPhone) {
    const found = db.prepare(
      "SELECT id FROM lead_pool WHERE product_id = ? AND phone = ? AND lead_status NOT IN ('duplicate','blacklist','invalid')"
    ).get(productId, normalizedPhone);
    if (found) return true;
  }
  if (leadType === 'b2b' && companyName && lastname) {
    const found = db.prepare(
      "SELECT id FROM lead_pool WHERE product_id = ? AND lead_type = 'b2b' AND company_name = ? AND contact_lastname = ? AND lead_status NOT IN ('duplicate','blacklist','invalid')"
    ).get(productId, companyName, lastname);
    if (found) return true;
  }
  if (leadType === 'b2c' && lastname && firstname && postalCode) {
    const found = db.prepare(
      "SELECT id FROM lead_pool WHERE product_id = ? AND lead_type = 'b2c' AND contact_lastname = ? AND contact_firstname = ? AND postal_code = ? AND lead_status NOT IN ('duplicate','blacklist','invalid')"
    ).get(productId, lastname, firstname, postalCode);
    if (found) return true;
  }
  return false;
}

function processImport({ filePath, originalFilename, productId, partnerUserId, supplierName, maxAssignments, consentUrl, consentText }) {
  const db = getDb();
  const product = db.prepare('SELECT * FROM lead_products WHERE id = ?').get(productId);
  if (!product) return null;

  const leadType = product.lead_type || 'b2c';
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/).filter(line => line.trim());

  let dataLines = lines;
  if (lines.length > 0) {
    const firstLine = lines[0].toLowerCase();
    if (firstLine.includes('firma') || firstLine.includes('name') || firstLine.includes('strasse') ||
        firstLine.includes('plz') || firstLine.includes('telefon') || firstLine.includes('vorname')) {
      dataLines = lines.slice(1);
    }
  }

  const insertLead = db.prepare(`
    INSERT INTO lead_pool
      (import_id, product_id, partner_user_id, lead_type,
       company_name, contact_lastname, contact_firstname,
       street, house_number, postal_code, city,
       phone, email, date_of_birth, remarks,
       max_assignments, lead_status, cancel_reason, bundesland)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAttribute = db.prepare(
    'INSERT INTO lead_pool_attributes (pool_lead_id, field_key, field_value) VALUES (?, ?, ?)'
  );
  // Produktspezifische Zusatzfelder (Liefertemplate) - werden als weitere
  // CSV-Spalten NACH den Standardfeldern erwartet, in dieser Reihenfolge.
  const deliveryFields = db.prepare(
    'SELECT field_key FROM product_delivery_fields WHERE product_id = ? ORDER BY sort_order'
  ).all(productId).map(r => r.field_key);
  // +1 ggü. frueher: neue Pflichtspalte Voicefile-Link ganz am Ende der
  // Standardfelder, vor eventuellen Liefertemplate-Zusatzspalten.
  const baseColumnCount = (leadType === 'b2b' ? 9 : 10) + 1;

  const result = db.transaction(() => {
    let imported = 0, duplicates = 0, blacklisted = 0, invalid = 0;

    const importId = db.prepare(`
      INSERT INTO lead_imports
        (product_id, partner_user_id, supplier_name, filename,
         lead_count, duplicates_skipped, blacklist_skipped, invalid_skipped,
         consent_url, consent_text)
      VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
    `).run(productId, partnerUserId, supplierName, originalFilename, consentUrl || null, consentText || null).lastInsertRowid;

    for (const line of dataLines) {
      const parts = line.split(';').map(s => s.trim());
      let companyName, lastname, firstname, street, houseNumber, postalCode, city, phone, email, dob, remarks, voicefileLink;

      if (leadType === 'b2b') {
        [companyName, lastname, street, houseNumber, postalCode, city, phone, email, remarks, voicefileLink] = parts;
        firstname = null; dob = null;
        companyName = companyName || null;
        lastname = lastname || '';
      } else {
        [lastname, firstname, street, houseNumber, postalCode, city, phone, email, dob, remarks, voicefileLink] = parts;
        companyName = null;
        lastname = lastname || '';
        firstname = firstname || null;
      }

      // Komplett leere Zeile überspringen
      if (!lastname && !companyName && !phone) continue;

      // Erfolgsfall landet jetzt in 'in_pruefung' statt direkt 'pending' -
      // dieselbe QM-Pruefung wie bei der Live-API, siehe Status 6 unten.
      let status = 'in_pruefung';
      let reason = null;

      // 1. Pflichtfelder
      const missing = getMissingFields(leadType, { companyName, lastname, phone, postalCode });
      if (missing.length > 0) {
        status = 'invalid';
        reason = `Pflichtfeld fehlt: ${missing.join(', ')}`;
      }

      // 2. PLZ-Format (nur DE, 5-stellig)
      if (status === 'in_pruefung' && postalCode && !/^\d{5}$/.test(postalCode)) {
        status = 'invalid';
        reason = 'Ungültige PLZ (5-stellig erforderlich)';
      }

      // 3. Telefon-Format
      if (status === 'in_pruefung' && !isValidPhone(phone)) {
        status = 'invalid';
        reason = 'Ungültige Telefonnummer';
      }

      // 4. E-Mail-Format
      if (status === 'in_pruefung' && !isValidEmail(email)) {
        status = 'invalid';
        reason = 'Ungültiges E-Mail-Format';
      }

      // 5. Fake-Namen
      if (status === 'in_pruefung' && isFakeName(firstname, lastname, companyName)) {
        status = 'invalid';
        reason = 'Verdächtiger Name (Testdaten)';
      }

      // 6. Voicefile-Link (Pflicht, siehe isValidVoiceLink)
      if (status === 'in_pruefung' && !isValidVoiceLink(voicefileLink)) {
        status = 'invalid';
        reason = 'Voicefile-Link fehlt oder ungültig';
      }

      // 7. Blacklist
      if (status === 'in_pruefung' && isBlacklisted(db, phone)) {
        status = 'blacklist';
        reason = 'Telefonnummer auf Blacklist';
      }

      // 8. Dubletten (nur bei validen Leads prüfen)
      if (status === 'in_pruefung' && isDuplicate(db, productId, phone, leadType, companyName, lastname, firstname, postalCode)) {
        status = 'duplicate';
        reason = 'Bereits im Pool vorhanden';
      }

      const normalizedPhone = normalizePhone(phone);
      const poolLeadId = insertLead.run(
        importId, productId, partnerUserId, leadType,
        companyName || null, lastname || '', firstname || null,
        street || null, houseNumber || null, postalCode || null, city || null,
        normalizedPhone, email || null, dob || null, remarks || null,
        maxAssignments, status, reason, getBundeslandForPlz(postalCode)
      ).lastInsertRowid;

      if (status === 'in_pruefung') {
        saveRecordingLink({ poolLeadId, url: voicefileLink.trim(), callDate: new Date().toISOString(), source: 'partner_csv_link' });
      }

      // Produktspezifische Zusatzfelder (Liefertemplate): Spalten nach den
      // Standardfeldern, in der Reihenfolge von product_delivery_fields.
      if (deliveryFields.length > 0) {
        const extraValues = parts.slice(baseColumnCount);
        deliveryFields.forEach((fieldKey, idx) => {
          const value = (extraValues[idx] || '').trim();
          if (value) insertAttribute.run(poolLeadId, fieldKey, value);
        });
      }

      if (status === 'in_pruefung') imported++;
      else if (status === 'duplicate') duplicates++;
      else if (status === 'blacklist') blacklisted++;
      else invalid++;
    }

    db.prepare(`
      UPDATE lead_imports SET lead_count = ?, duplicates_skipped = ?, blacklist_skipped = ?, invalid_skipped = ? WHERE id = ?
    `).run(imported, duplicates, blacklisted, invalid, importId);

    return { importId, imported, duplicates, blacklisted, invalid };
  })();

  fs.unlinkSync(filePath);

  // Offene Bestellungen aus der Warteschlange auffüllen
  try {
    const { fillDeliveryQueue } = require('./deliverLeads');
    fillDeliveryQueue();
  } catch (_) {}

  // Frank + Jens benachrichtigen
  try {
    const { sendImportNotification } = require('./mailer');
    const productInfo = db.prepare(`
      SELECT lp.name as product_name, lc.name as category_name
      FROM lead_products lp JOIN lead_categories lc ON lp.category_id = lc.id
      WHERE lp.id = ?
    `).get(productId);
    sendImportNotification({
      supplierName: supplierName || 'Unbekannt',
      productName: productInfo?.product_name || '-',
      categoryName: productInfo?.category_name || '-',
      imported: result.imported,
      duplicates: result.duplicates,
      blacklisted: result.blacklisted,
      invalid: result.invalid,
    }).catch(err => console.error('[Mailer] Import-Notify Fehler:', err.message));
  } catch (_) {}

  return result;
}

module.exports = {
  processImport, normalizePhone, isDuplicate,
  isValidPhone, isValidEmail, isFakeName, isBlacklisted, getMissingFields, isValidVoiceLink,
};
