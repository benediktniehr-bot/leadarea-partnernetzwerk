// LeadArea hat Firmensitz Schweiz. Nach dem Empfängerortsprinzip wird Schweizer
// MWST nur für Kunden/Partner mit Sitz in der Schweiz ausgewiesen. Rechnungen/
// Gutschriften an Empfänger im Ausland (EU + sonstige Länder) werden ohne MwSt.
// ausgestellt (steuerbefreite Auslandsleistung / Steuerschuldnerschaft beim
// Empfänger). Exakte Formulierung des Auslands-Hinweises auf der Rechnung ist
// mit Anwalt/DSB abzustimmen (siehe Rechtstexte-Notiz zu Umsatzsteuer CH→DE B2B).
const COUNTRY_VAT = {
  CH: { rate: 0.081, applies: true },

  // EU-Staaten + UK/Norwegen/Island/Liechtenstein (Käufer-Länderliste)
  DE: { rate: 0, applies: false },
  AT: { rate: 0, applies: false },
  BE: { rate: 0, applies: false },
  BG: { rate: 0, applies: false },
  DK: { rate: 0, applies: false },
  EE: { rate: 0, applies: false },
  FI: { rate: 0, applies: false },
  FR: { rate: 0, applies: false },
  GR: { rate: 0, applies: false },
  IE: { rate: 0, applies: false },
  IS: { rate: 0, applies: false },
  IT: { rate: 0, applies: false },
  HR: { rate: 0, applies: false },
  LV: { rate: 0, applies: false },
  LI: { rate: 0, applies: false },
  LT: { rate: 0, applies: false },
  LU: { rate: 0, applies: false },
  MT: { rate: 0, applies: false },
  NL: { rate: 0, applies: false },
  NO: { rate: 0, applies: false },
  PL: { rate: 0, applies: false },
  PT: { rate: 0, applies: false },
  RO: { rate: 0, applies: false },
  SE: { rate: 0, applies: false },
  SK: { rate: 0, applies: false },
  SI: { rate: 0, applies: false },
  ES: { rate: 0, applies: false },
  CZ: { rate: 0, applies: false },
  HU: { rate: 0, applies: false },
  GB: { rate: 0, applies: false },
  CY: { rate: 0, applies: false },

  // Weitere Länder aus der Partner-Länderliste (Lieferanten)
  TR: { rate: 0, applies: false },
  XK: { rate: 0, applies: false },
  RS: { rate: 0, applies: false },
  BA: { rate: 0, applies: false },
  ME: { rate: 0, applies: false },
  MK: { rate: 0, applies: false },
  AL: { rate: 0, applies: false },
  UA: { rate: 0, applies: false },
};

const DEFAULT_VAT = { rate: 0, applies: false };

function getVatForCountry(countryCode) {
  return COUNTRY_VAT[countryCode] || DEFAULT_VAT;
}

// z.B. 0.081 -> "8,1", 0.19 -> "19" (deutsches Format, keine überflüssige Nachkommastelle)
function formatVatRate(rate) {
  return (rate * 100).toFixed(1).replace('.0', '').replace('.', ',');
}

module.exports = { getVatForCountry, COUNTRY_VAT, formatVatRate };
