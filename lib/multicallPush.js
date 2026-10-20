const { getDb } = require('../database');

// Schreibt einen QM-freigegebenen Lead mit dem passenden Merkmal nach
// Multicall (tl_dmp_address/tl_dmp_address_attributes), damit die bestehende
// Selektions-/11-Uhr-Auslieferungslogik ihn automatisch mitnimmt.
//
// ACHTUNG: Die eigentliche Schreib-Logik ist bewusst NOCH NICHT implementiert.
// Dafuer braucht es pro Partner/Projekt einen echten Vendor-Eintrag in
// Multicall (siehe [[project_leadarea]] - "wartet auf ersten echten Partner")
// und eine Zuordnung in product_multicall_mapping. Bis dahin markiert diese
// Funktion den Lead nur als QM-freigegeben und meldet klar zurueck, dass der
// Multicall-Teil noch fehlt - KEIN Blindflug/Rateversuch gegen die Produktiv-DB.
function pushLeadToMulticall(poolLeadId) {
  const db = getDb();
  const lead = db.prepare('SELECT * FROM lead_pool WHERE id = ?').get(poolLeadId);
  if (!lead) return { pushed: false, reason: 'Lead nicht gefunden' };

  const mapping = db.prepare('SELECT * FROM product_multicall_mapping WHERE product_id = ?').get(lead.product_id);
  if (!mapping) {
    console.warn(`[Multicall-Push] Kein Mapping fuer product_id=${lead.product_id} (Lead ${poolLeadId}) - noch nicht nach Multicall uebertragen.`);
    return { pushed: false, reason: 'Kein Multicall-Mapping fuer dieses Produkt hinterlegt' };
  }

  // TODO sobald ein echter Partner-Vendor existiert: per SSH/mysql auf
  // dedi2400 einen tl_dmp_address(_attributes)-Datensatz anlegen, analog zum
  // bestehenden Muster bei Xuse/LeadDirect/GAID (manueller Import, kein FTP).
  console.warn(`[Multicall-Push] Mapping gefunden (Merkmal "${mapping.multicall_merkmal}", Vendor "${mapping.multicall_vendor_shortcut}"), aber Schreib-Logik noch nicht implementiert (Lead ${poolLeadId}).`);
  return { pushed: false, reason: 'Multicall-Schreib-Logik noch nicht implementiert' };
}

module.exports = { pushLeadToMulticall };
