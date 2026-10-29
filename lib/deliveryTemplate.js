const { getDb } = require('../database');

// Generiert die CSV-Kopfzeile + Feldbeschreibung fuer das Liefertemplate
// eines Produkts - direkt aus den bestehenden Standardfeldern +
// product_delivery_fields, damit es nie von der tatsaechlichen
// Validierung in lib/importLeads.js abweichen kann.
function getDeliveryTemplate(productId) {
  const db = getDb();
  const product = db.prepare('SELECT * FROM lead_products WHERE id = ?').get(productId);
  if (!product) return null;

  const baseFields = product.lead_type === 'b2b'
    ? [
        { label: 'Firmenname', note: 'Pflicht, falls kein Nachname angegeben' },
        { label: 'Nachname', note: 'Pflicht, falls kein Firmenname angegeben' },
        { label: 'Strasse', note: '' },
        { label: 'Hausnummer', note: '' },
        { label: 'PLZ', note: 'Pflicht, 5-stellig' },
        { label: 'Ort', note: '' },
        { label: 'Telefon', note: 'Pflicht' },
        { label: 'Email', note: 'optional' },
        { label: 'Bemerkungen', note: 'optional' },
      ]
    : [
        { label: 'Nachname', note: 'Pflicht' },
        { label: 'Vorname', note: 'optional' },
        { label: 'Strasse', note: '' },
        { label: 'Hausnummer', note: '' },
        { label: 'PLZ', note: 'Pflicht, 5-stellig' },
        { label: 'Ort', note: '' },
        { label: 'Telefon', note: 'Pflicht' },
        { label: 'Email', note: 'optional' },
        { label: 'Geburtsdatum', note: 'optional' },
        { label: 'Bemerkungen', note: 'optional' },
      ];

  const voicefileField = { label: 'Voicefile-Link', note: 'Pflicht - direkter Link zur gehosteten Audiodatei (http/https), kein Datei-Upload' };

  const extraFields = db.prepare(
    'SELECT field_label FROM product_delivery_fields WHERE product_id = ? ORDER BY sort_order'
  ).all(productId).map(r => ({ label: r.field_label, note: 'projektspezifisches Zusatzfeld' }));

  const fields = [...baseFields, voicefileField, ...extraFields];
  const header = fields.map(f => f.label).join(';');

  return { product, leadType: product.lead_type, fields, header };
}

module.exports = { getDeliveryTemplate };
