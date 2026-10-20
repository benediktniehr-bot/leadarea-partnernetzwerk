// Zentrale Firmendaten für Rechnungen/E-Mails. Siehe views/impressum.html für die
// vollständige Anbieterkennzeichnung - hier nur der für Rechnungen relevante Auszug.
const SELLER = {
  name: 'SwissLeads AG',
  address: 'Konstanzerstrasse 19, CH-8274 Tägerwilen, Schweiz',
  vatId: 'UID CHE-284.532.284',
};

// Bankverbindung für Vorkasse-Zahlungen per Überweisung (von Jens, 2026-10-13).
// EUR-Konto bei einer Schweizer Bank - Rechnung wird in Euro gestellt, aber
// offiziell aus der Schweiz versendet (SwissLeads AG).
const BANK_DETAILS = {
  kontoinhaber: process.env.BANK_KONTOINHABER || 'SwissLeads AG, Konstanzerstrasse 19, 8274 Tägerwilen',
  iban: process.env.BANK_IBAN || 'CH12 0630 0508 8134 1454 6',
  bic: process.env.BANK_BIC || 'VABECH22XXX',
  bankname: process.env.BANK_NAME || 'Valiant Bank AG, Bern',
};

module.exports = { SELLER, BANK_DETAILS };
