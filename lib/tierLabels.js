// Kennzeichnung der Nutzungsstufe eines Leads (frisch / 2./3. Nutzung / exklusiv) -
// zentral definiert, damit Warenkorb, Bestellbestätigung und Rechnung (E-Mail-Anhang,
// Download, Dashboard-Ansicht) immer denselben Zusatz zum Produktnamen anzeigen.
const TIER_LABELS = { 1: '', 2: ' (2. Nutzung)', 3: ' (3. Nutzung)', 4: ' (Exklusiv)' };

function withTierLabel(productName, tier) {
  return productName + (TIER_LABELS[tier] || '');
}

module.exports = { TIER_LABELS, withTierLabel };
