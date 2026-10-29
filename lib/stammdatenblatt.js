const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const COUNTRY_LABELS = {
  DE: 'Deutschland', TR: 'Türkei', GR: 'Griechenland', XK: 'Kosovo', RS: 'Serbien',
  BA: 'Bosnien und Herzegowina', HR: 'Kroatien', ME: 'Montenegro', MK: 'Nordmazedonien',
  AL: 'Albanien', BG: 'Bulgarien', RO: 'Rumänien', HU: 'Ungarn', PL: 'Polen',
  CZ: 'Tschechien', SK: 'Slowakei', SI: 'Slowenien', UA: 'Ukraine', RU: 'Russland', MD: 'Moldau',
};

function esc(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Chrome's --headless print-to-pdf bettet Umlaute/ß teils fehlerhaft ins
// PDF-Font-Subset ein (Zeichen landet korrekt im Text, aber falsches Glyph
// beim Anzeigen/Drucken). Umgehung: alle Nicht-ASCII-Zeichen als numerische
// HTML-Entities schreiben, bevor die Datei an Chrome übergeben wird.
function toHtmlEntities(html) {
  return Array.from(html).map(ch => {
    const code = ch.codePointAt(0);
    return code > 127 ? `&#${code};` : ch;
  }).join('');
}

const LOGO_DATA_URI = (() => {
  const logoPath = path.join(__dirname, '..', 'assets', 'logo_wordmark.png');
  if (!fs.existsSync(logoPath)) return null;
  return `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
})();

// Vorausgefülltes Feld: Wert aus der Registrierung, sonst leere Linie zum Ausfüllen.
function field(value) {
  return value ? `<span class="prefill">${esc(value)}</span>` : '&nbsp;';
}

function buildHtml(stammdaten) {
  const s = stammdaten || {};
  const addressLine1 = [s.street, s.houseNumber].filter(Boolean).join(' ');
  const addressLine2 = [s.postalCode, s.city, COUNTRY_LABELS[s.country] || s.country].filter(Boolean).join(', ');
  const repName = [s.firstName, s.lastName].filter(Boolean).join(' ');

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>Stammdatenblatt – LeadArea Partner</title>
<style>
  @page { margin: 10mm 14mm; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1a1a2e; font-size: 13px; line-height: 1.5; margin: 0; }
  .logo { height: 24px; margin-bottom: 14px; display: block; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; margin-bottom: 22px; }
  h2 { font-size: 14px; border-bottom: 1.5px solid #1a1a2e; padding-bottom: 4px; margin-top: 16px; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 5px 4px; vertical-align: bottom; }
  .label { width: 44%; color: #444; white-space: nowrap; }
  .fill { border-bottom: 1px solid #999; }
  .prefill { font-weight: 600; }
  .hint { color: #888; font-size: 11px; margin-top: -2px; margin-bottom: 18px; }
  .sig-row td { padding-top: 14px; }
  .sig-line { border-top: 1px solid #333; padding-top: 4px; color: #666; font-size: 11px; }
  footer { margin-top: 14px; color: #999; font-size: 10px; }
</style>
</head>
<body>
  ${LOGO_DATA_URI ? `<img class="logo" src="${LOGO_DATA_URI}" alt="LeadArea">` : ''}
  <h1>Stammdatenblatt – LeadArea Partner</h1>
  <p class="sub">Bereits bekannte Angaben sind vorausgefüllt. Bitte restliche Felder ergänzen, unterschreiben und an uns zurücksenden.</p>

  <h2>1. Unternehmensdaten</h2>
  <table>
    <tr><td class="label">Firmenname (ggf. mit Rechtsform)</td><td class="fill">${field(s.company)}</td></tr>
    <tr><td class="label">Anschrift (Straße, Hausnummer)</td><td class="fill">${field(addressLine1)}</td></tr>
    <tr><td class="label">PLZ, Ort, Land</td><td class="fill">${field(addressLine2)}</td></tr>
    <tr><td class="label">Handelsregisternummer (falls vorhanden)</td><td class="fill">&nbsp;</td></tr>
    <tr><td class="label">USt-IdNr. / Steuernummer</td><td class="fill">${field(s.taxNumber)}</td></tr>
  </table>

  <h2>2. Vertretungsberechtigte Person</h2>
  <table>
    <tr><td class="label">Name, Vorname</td><td class="fill">${field(repName)}</td></tr>
    <tr><td class="label">Funktion / Position</td><td class="fill">&nbsp;</td></tr>
    <tr><td class="label">E-Mail</td><td class="fill">${field(s.email)}</td></tr>
    <tr><td class="label">Telefon</td><td class="fill">${field(s.phone)}</td></tr>
  </table>

  <h2>3. Operativer Ansprechpartner (falls abweichend)</h2>
  <table>
    <tr><td class="label">Name, Vorname</td><td class="fill">&nbsp;</td></tr>
    <tr><td class="label">E-Mail</td><td class="fill">&nbsp;</td></tr>
    <tr><td class="label">Telefon</td><td class="fill">&nbsp;</td></tr>
  </table>

  <h2>4. Bankverbindung für Auszahlungen</h2>
  <table>
    <tr><td class="label">Kontoinhaber</td><td class="fill">&nbsp;</td></tr>
    <tr><td class="label">IBAN</td><td class="fill">&nbsp;</td></tr>
    <tr><td class="label">BIC</td><td class="fill">&nbsp;</td></tr>
    <tr><td class="label">Bank, Ort</td><td class="fill">&nbsp;</td></tr>
  </table>

  <h2>5. Bestätigung</h2>
  <p class="hint">Mit meiner Unterschrift bestätige ich die Richtigkeit der obigen Angaben.</p>
  <table>
    <tr class="sig-row">
      <td style="width:50%;"><div class="sig-line">Ort, Datum</div></td>
      <td><div class="sig-line">Unterschrift (ggf. mit Firmenstempel)</div></td>
    </tr>
  </table>

  <footer>LeadArea – eine Marke der SwissLeads AG</footer>
</body>
</html>`;
}

function findChrome() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  return candidates.find(p => fs.existsSync(p));
}

// Erzeugt das vorausgefüllte Stammdatenblatt als PDF-Buffer. Fällt auf die
// statische Vorlage zurück, falls kein Chrome gefunden wird (z.B. auf einem
// Server ohne installierten Browser).
function generatePdfBuffer(stammdaten) {
  const chrome = findChrome();
  const staticFallback = path.join(__dirname, '..', 'assets', 'stammdatenblatt.pdf');
  if (!chrome) {
    return fs.existsSync(staticFallback) ? fs.readFileSync(staticFallback) : null;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stammdatenblatt-'));
  const htmlPath = path.join(tmpDir, 'stammdatenblatt.html');
  const pdfPath = path.join(tmpDir, 'stammdatenblatt.pdf');
  try {
    fs.writeFileSync(htmlPath, toHtmlEntities(buildHtml(stammdaten)), 'utf8');
    execFileSync(chrome, [
      '--headless', '--disable-gpu', '--no-sandbox',
      `--print-to-pdf=${pdfPath}`, '--no-pdf-header-footer',
      `file:///${htmlPath.replace(/\\/g, '/')}`,
    ], { stdio: 'ignore', timeout: 15000 });
    return fs.readFileSync(pdfPath);
  } catch (err) {
    console.error('[Stammdatenblatt] PDF-Generierung fehlgeschlagen, nutze statischen Fallback:', err.message);
    return fs.existsSync(staticFallback) ? fs.readFileSync(staticFallback) : null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

module.exports = { buildHtml, generatePdfBuffer };
