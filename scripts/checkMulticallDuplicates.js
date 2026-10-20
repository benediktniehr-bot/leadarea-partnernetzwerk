// Prueft neu eingelieferte Partner-LeadArea-Leads (lead_pool, Status 'pending',
// noch nicht gegen Multicall geprueft) gegen den GESAMTEN Multicall-Adressbestand
// (tl_dmp_address.phone1_repaired) auf dedi2400 - unabhaengig vom eigenen
// leadwerke-Pool. Treffer werden auf lead_status='duplicate' gesetzt (keine
// Partner-Provision), alle anderen als geprueft markiert. Rein lesender
// SELECT gegen Multicall, kein Schreibzugriff auf dedi2400 - siehe
// [[project-leadarea]] fuer den Hintergrund dieser Logik.
//
// Aufruf: node scripts/checkMulticallDuplicates.js [--dry-run]

const { execSync } = require('child_process');
const { getDb } = require('../database');

const MYSQL_USER = 'multicall';
const MYSQL_PASS = "qq4HHHYAmcWEH8GK";
const MYSQL_DB = 'multicall_db1';

// leadwerke normalizePhone() liefert "+49..." (oder unveraendert, falls schon
// national "0..." eingegeben wurde). Multicall speichert in phone1_repaired
// national mit fuehrender "0" (z.B. "01627988639"). Nur deutsche Nummern
// werden verglichen, da Multicall-Dubletten ohnehin nur DE-Bestand sind.
function toMulticallPhoneFormat(rawPhone) {
  if (!rawPhone) return null;
  const normalized = rawPhone.replace(/[\s\-\/\(\)\.]/g, '').replace(/^00/, '+');
  if (normalized.startsWith('+49')) return '0' + normalized.slice(3);
  if (normalized.startsWith('0')) return normalized;
  return null; // kein erkennbares deutsches Format - nicht prüfbar
}

function queryExistingPhones(phones) {
  if (phones.length === 0) return new Set();
  const inList = phones.map(p => `'${p.replace(/'/g, "''")}'`).join(',');
  const sql = `SELECT DISTINCT phone1_repaired FROM ${MYSQL_DB}.tl_dmp_address WHERE phone1_repaired IN (${inList});`;
  const output = execSync(`ssh dedi2400 "mysql -u ${MYSQL_USER} -p'${MYSQL_PASS}' -N -B"`, { input: sql, encoding: 'utf8' });
  const found = new Set();
  for (const line of output.split('\n')) {
    const p = line.trim();
    if (p) found.add(p);
  }
  return found;
}

function run() {
  const dryRun = process.argv.includes('--dry-run');
  const db = getDb();

  const rows = db.prepare(`
    SELECT id, phone FROM lead_pool
    WHERE lead_status = 'pending' AND multicall_checked_at IS NULL
  `).all();

  if (rows.length === 0) {
    console.log('Keine neuen Leads zu prüfen.');
    return;
  }

  const phoneToLeadIds = {};
  let unmatchable = 0;
  for (const r of rows) {
    const mcPhone = toMulticallPhoneFormat(r.phone);
    if (!mcPhone) { unmatchable++; continue; }
    if (!phoneToLeadIds[mcPhone]) phoneToLeadIds[mcPhone] = [];
    phoneToLeadIds[mcPhone].push(r.id);
  }

  const existingPhones = queryExistingPhones(Object.keys(phoneToLeadIds));

  const markDuplicate = db.prepare(`
    UPDATE lead_pool SET lead_status = 'duplicate', cancel_reason = ?, multicall_checked_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const markChecked = db.prepare(`UPDATE lead_pool SET multicall_checked_at = CURRENT_TIMESTAMP WHERE id = ?`);

  let dupCount = 0, okCount = 0;
  for (const [mcPhone, ids] of Object.entries(phoneToLeadIds)) {
    const isDuplicate = existingPhones.has(mcPhone);
    for (const id of ids) {
      if (dryRun) {
        console.log(`Lead #${id}: ${isDuplicate ? 'DUBLETTE (Multicall-Gesamtbestand)' : 'neu'}`);
      } else if (isDuplicate) {
        markDuplicate.run('Adresse bereits im Multicall-Gesamtbestand vorhanden', id);
      } else {
        markChecked.run(id);
      }
      if (isDuplicate) dupCount++; else okCount++;
    }
  }

  console.log(`Geprüft: ${rows.length} (davon ${unmatchable} ohne prüfbares deutsches Telefonformat, übersprungen).`);
  console.log(`Dubletten gegen Multicall-Gesamtbestand: ${dupCount}. Neu/ok: ${okCount}.${dryRun ? ' (Dry-Run - nichts gespeichert)' : ''}`);
}

run();
