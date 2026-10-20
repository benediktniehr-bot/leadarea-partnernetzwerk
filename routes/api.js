const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { getDb } = require('../database');
const { processImport, normalizePhone, getMissingFields, isValidPhone, isValidEmail, isFakeName, isBlacklisted } = require('../lib/importLeads');
const { getBundeslandForPlz } = require('../lib/plzBundesland');
const { saveRecording } = require('../lib/recordings');

const apiUpload = multer({ dest: path.join(__dirname, '..', 'public', 'uploads', 'csv') });
const liveLeadUpload = multer({ dest: path.join(__dirname, '..', 'public', 'uploads', 'tmp-voicefiles'), limits: { fileSize: 25 * 1024 * 1024 } });

function requireApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) return res.status(401).json({ error: 'API-Key fehlt' });

  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE api_key = ? AND role = 'partner'").get(apiKey);
  if (!user) return res.status(403).json({ error: 'Ungültiger API-Key' });

  req.apiUser = user;
  next();
}

// Live-Einlieferung EINES einzelnen Leads direkt nach dem Abschluss eines
// Sales, inkl. Pflicht-Voicefile. Landet NICHT direkt im normalen Pool-Status
// 'pending', sondern in 'in_pruefung' (QM-Warteschlange, siehe /admin/qm) -
// der Multicall-Dublettencheck laeuft bewusst erst NACH der QM-Freigabe
// (siehe [[project_leadarea]], Stand 2026-10-20).
router.post('/lead', requireApiKey, liveLeadUpload.single('voicefile'), (req, res) => {
  const cleanupTmpFile = () => { if (req.file) { try { require('fs').unlinkSync(req.file.path); } catch (_) {} } };

  const productId = parseInt(req.body.product_id);
  if (!productId) { cleanupTmpFile(); return res.status(400).json({ error: 'product_id fehlt' }); }

  const db = getDb();
  const product = db.prepare('SELECT * FROM lead_products WHERE id = ? AND active = 1').get(productId);
  if (!product) { cleanupTmpFile(); return res.status(400).json({ error: 'Ungültige product_id' }); }

  if (!req.file) {
    return res.status(400).json({ error: 'Voicefile fehlt - bitte Feld "voicefile" als Datei mitschicken' });
  }

  const leadType = product.lead_type || 'b2c';
  const companyName = req.body.firma || req.body.company_name || null;
  const lastname = req.body.nachname || req.body.lastname || '';
  const firstname = req.body.vorname || req.body.firstname || null;
  const street = req.body.strasse || req.body.street || null;
  const houseNumber = req.body.hausnummer || req.body.house_number || null;
  const postalCode = req.body.plz || req.body.postal_code || null;
  const city = req.body.ort || req.body.city || null;
  const phone = req.body.telefon || req.body.phone || null;
  const email = req.body.email || null;
  const dob = req.body.geburtsdatum || req.body.date_of_birth || null;
  const remarks = req.body.bemerkungen || req.body.remarks || null;

  let status = 'in_pruefung';
  let reason = null;

  const missing = getMissingFields(leadType, { companyName, lastname, phone, postalCode });
  if (missing.length > 0) { status = 'invalid'; reason = `Pflichtfeld fehlt: ${missing.join(', ')}`; }
  if (status !== 'invalid' && postalCode && !/^\d{5}$/.test(postalCode)) { status = 'invalid'; reason = 'Ungültige PLZ (5-stellig erforderlich)'; }
  if (status !== 'invalid' && !isValidPhone(phone)) { status = 'invalid'; reason = 'Ungültige Telefonnummer'; }
  if (status !== 'invalid' && !isValidEmail(email)) { status = 'invalid'; reason = 'Ungültiges E-Mail-Format'; }
  if (status !== 'invalid' && isFakeName(firstname, lastname, companyName)) { status = 'invalid'; reason = 'Verdächtiger Name (Testdaten)'; }
  if (status !== 'invalid' && isBlacklisted(db, phone)) { status = 'blacklist'; reason = 'Telefonnummer auf Blacklist'; }

  const importId = db.prepare(`
    INSERT INTO lead_imports (product_id, partner_user_id, supplier_name, filename, lead_count, duplicates_skipped, blacklist_skipped, invalid_skipped)
    VALUES (?, ?, ?, 'Live-API', 0, 0, 0, 0)
  `).run(productId, req.apiUser.id, `${req.apiUser.first_name} ${req.apiUser.last_name}`).lastInsertRowid;

  const poolLeadId = db.prepare(`
    INSERT INTO lead_pool
      (import_id, product_id, partner_user_id, lead_type, company_name, contact_lastname, contact_firstname,
       street, house_number, postal_code, city, phone, email, date_of_birth, remarks,
       max_assignments, lead_status, cancel_reason, bundesland)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    importId, productId, req.apiUser.id, leadType,
    companyName, lastname, firstname, street, houseNumber, postalCode, city,
    normalizePhone(phone), email, dob, remarks,
    parseInt(req.body.max_assignments) || 3, status, reason, getBundeslandForPlz(postalCode)
  ).lastInsertRowid;

  saveRecording({
    poolLeadId,
    sourceFilePath: req.file.path,
    originalFilename: req.file.originalname,
    callDate: new Date().toISOString(),
    source: 'partner_live_api',
  });
  cleanupTmpFile();

  res.json({ success: true, lead_id: poolLeadId, status });
});

router.post('/leads', requireApiKey, apiUpload.single('csvfile'), (req, res) => {
  const productId = parseInt(req.body.product_id);
  if (!productId) return res.status(400).json({ error: 'product_id fehlt' });

  const db = getDb();
  const product = db.prepare('SELECT * FROM lead_products WHERE id = ? AND active = 1').get(productId);
  if (!product) return res.status(400).json({ error: 'Ungültige product_id' });

  if (req.file) {
    const result = processImport({
      filePath: req.file.path,
      originalFilename: req.file.originalname,
      productId,
      partnerUserId: req.apiUser.id,
      supplierName: `${req.apiUser.first_name} ${req.apiUser.last_name}`,
      maxAssignments: parseInt(req.body.max_assignments) || 3,
    });

    if (!result) return res.status(500).json({ error: 'Import fehlgeschlagen' });
    return res.json({
      success: true,
      import_id: result.importId,
      importiert: result.imported,
      dubletten: result.skipped,
      ungueltige_plz: result.invalidPlz,
    });
  }

  if (req.body.leads && Array.isArray(req.body.leads)) {
    const leadType = product.lead_type || 'b2c';
    const { normalizePhone, isDuplicate } = require('../lib/importLeads');
    const maxAssignments = parseInt(req.body.max_assignments) || 3;

    const { getBundeslandForPlz } = require('../lib/plzBundesland');

    const insertLead = db.prepare(`
      INSERT INTO lead_pool (import_id, product_id, partner_user_id, lead_type, company_name, contact_lastname, contact_firstname, street, house_number, postal_code, city, phone, email, date_of_birth, remarks, max_assignments, bundesland)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = db.transaction(() => {
      let imported = 0, skipped = 0, invalidPlz = 0;
      const importId = db.prepare('INSERT INTO lead_imports (product_id, partner_user_id, supplier_name, filename, lead_count, duplicates_skipped, invalid_plz_skipped) VALUES (?, ?, ?, ?, 0, 0, 0)')
        .run(productId, req.apiUser.id, `${req.apiUser.first_name} ${req.apiUser.last_name}`, 'API').lastInsertRowid;

      for (const lead of req.body.leads) {
        const lastname = lead.nachname || lead.lastname || '';
        if (!lastname) continue;

        const postalCode = lead.plz || lead.postal_code || null;
        if (postalCode && !/^\d{5}$/.test(postalCode)) { invalidPlz++; continue; }

        const companyName = lead.firma || lead.company_name || null;
        const firstname = lead.vorname || lead.firstname || null;
        const phone = lead.telefon || lead.phone || null;

        if (isDuplicate(db, productId, phone, leadType, companyName, lastname, firstname, postalCode)) { skipped++; continue; }

        const normalizedPhone = normalizePhone(phone);
        insertLead.run(importId, productId, req.apiUser.id, leadType,
          companyName, lastname, firstname,
          lead.strasse || lead.street || null,
          lead.hausnummer || lead.house_number || null,
          postalCode,
          lead.ort || lead.city || null,
          normalizedPhone,
          lead.email || null,
          lead.geburtsdatum || lead.date_of_birth || null,
          lead.bemerkungen || lead.remarks || null,
          maxAssignments,
          getBundeslandForPlz(postalCode)
        );
        imported++;
      }

      db.prepare('UPDATE lead_imports SET lead_count = ?, duplicates_skipped = ?, invalid_plz_skipped = ? WHERE id = ?').run(imported, skipped, invalidPlz, importId);
      return { importId, imported, skipped, invalidPlz };
    })();

    return res.json({
      success: true,
      import_id: result.importId,
      importiert: result.imported,
      dubletten: result.skipped,
      ungueltige_plz: result.invalidPlz,
    });
  }

  return res.status(400).json({ error: 'Entweder CSV-Datei oder JSON-Array "leads" senden' });
});

router.get('/products', requireApiKey, (req, res) => {
  const db = getDb();
  const products = db.prepare(`
    SELECT lp.id, lp.name, lp.lead_type, lc.name as category
    FROM lead_products lp
    JOIN lead_categories lc ON lp.category_id = lc.id
    WHERE lp.active = 1
    ORDER BY lc.sort_order, lp.name
  `).all();
  res.json({ products });
});

router.get('/stats', requireApiKey, (req, res) => {
  const db = getDb();
  const userId = req.apiUser.id;
  const total = db.prepare('SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ?').get(userId).c;
  const compensated = db.prepare("SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ? AND lead_status = 'compensated'").get(userId).c;
  const duplicates = db.prepare("SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ? AND lead_status = 'duplicate'").get(userId).c;
  const cancelled = db.prepare("SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ? AND lead_status = 'cancelled'").get(userId).c;
  const pending = db.prepare("SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ? AND lead_status = 'pending'").get(userId).c;

  res.json({ gesamt: total, verguetet: compensated, dubletten: duplicates, storniert: cancelled, in_pruefung: pending });
});

module.exports = router;
