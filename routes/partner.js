const express = require('express');
const router = express.Router();
const path = require('path');
const multer = require('multer');
const { getDb } = require('../database');
const { requirePartner } = require('../middleware/auth');
const { getVatForCountry, formatVatRate } = require('../lib/vat');
const { sendPartnerApplicationNotification, sendPartnerWelcomeMail } = require('../lib/mailer');
const { getDeliveryTemplate } = require('../lib/deliveryTemplate');

const UPLOADS_BASE = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');
const partnerUpload = multer({ dest: path.join(UPLOADS_BASE, 'csv') });

// Projekt-Kacheln auf der Partner-LeadArea-Bewerbungsseite: gleiche Kategorien/
// Produkte wie der Marktplatz, aber ohne Preis und als Checkbox-Mehrfachauswahl
// statt Kauf-Button (CC wählt, mit welchen Projekten es zusammenarbeiten möchte).
function buildProjectTilesHtml(products) {
  const db = getDb();
  const categories = db.prepare('SELECT * FROM lead_categories ORDER BY sort_order').all();

  let html = '';
  for (const cat of categories) {
    const catProducts = products.filter(p => p.category_id === cat.id);
    if (catProducts.length === 0) continue;

    const themeClass = cat.name === 'Automaten' ? ' theme-amber'
      : cat.name === 'Senioren-Produkte' ? ' theme-coral' : '';
    html += `<div class="category-group${themeClass}"><h3>${cat.icon} ${cat.name}</h3><div class="leads-grid">`;
    for (const p of catProducts) {
      const paused = !!p.production_paused;
      html += `
        <label class="lead-card project-tile"${paused ? ' style="opacity:0.55;cursor:not-allowed;"' : ''}>
          <input type="checkbox" name="project_ids" value="${p.id}"${paused ? ' disabled' : ''}>
          ${p.image_url ? `<div class="lead-card-image"><img src="${p.image_url}" alt="${p.name}" loading="lazy"></div>` : ''}
          <h4>${p.name}</h4>
          ${paused ? '<p class="lead-desc" style="color:var(--warning);font-weight:600;">Aktuell pausiert - keine Produktion möglich</p>' : `<p class="lead-desc">${p.partner_description || p.description || ''}</p>`}
        </label>`;
    }
    html += '</div></div>';
  }
  return html;
}

// Lead-Status für die Partneransicht: Status-Set von Partner-LeadArea
// (siehe LEAD_STATUS_LABELS in routes/admin.js - dort wird der Status von
// Jens/Frank anhand der Abnehmer-Rückmeldung manuell gesetzt).
const PARTNER_LEAD_STATUS = {
  in_pruefung: { statusLabel: 'In Prüfung', statusClass: 'badge-pending' },
  pending: { statusLabel: 'In Bearbeitung', statusClass: 'badge-pending' },
  approved: { statusLabel: 'Genehmigt', statusClass: 'badge-active' },
  billed: { statusLabel: 'Abgerechnet', statusClass: 'badge-active' },
  paid: { statusLabel: 'Ausgezahlt', statusClass: 'badge-active' },
  cancelled: { statusLabel: 'Storno', statusClass: 'badge-cancelled' },
  spam: { statusLabel: 'Spam', statusClass: 'badge-cancelled' },
  duplicate: { statusLabel: 'Dublette', statusClass: 'badge-cancelled' },
  invalid: { statusLabel: 'Ungültig', statusClass: 'badge-cancelled' },
  blacklist: { statusLabel: 'Blacklist', statusClass: 'badge-cancelled' },
  compensated: { statusLabel: 'Vergütet', statusClass: 'badge-active' }, // Altdaten früherer Marktplatz-Flow
};
function leadStatusBadge(l) {
  return PARTNER_LEAD_STATUS[l.lead_status] || { statusLabel: l.lead_status, statusClass: 'badge-paid' };
}

// Freigabe-Status: Vertrag muss unterschrieben sein (contract_signed_at,
// von Admin manuell nach Vertragsrücklauf gesetzt), BEVOR ein Partner
// Liefertemplates sehen oder Daten hochladen kann - unabhängig vom
// can_upload-Flag unten. Siehe [[project-leadarea]], Entscheidung 2026-10-21.
function getContractStatus(userId) {
  const db = getDb();
  const user = db.prepare('SELECT contract_signed_at FROM users WHERE id = ?').get(userId);
  return !!(user && user.contract_signed_at);
}

// Welche Projekte dieser Partner tatsächlich produzieren darf (Admin pflegt
// das erst nach Vertragsunterschrift, siehe partner_approved_products) -
// NICHT identisch mit den bei der Bewerbung gewünschten Projekten.
function getApprovedProducts(userId) {
  const db = getDb();
  return db.prepare(`
    SELECT lp.*, lc.name as category_name FROM partner_approved_products pap
    JOIN lead_products lp ON lp.id = pap.product_id
    JOIN lead_categories lc ON lp.category_id = lc.id
    WHERE pap.user_id = ? AND lp.active = 1
    ORDER BY lc.sort_order, lp.name
  `).all(userId);
}

function canUpload(req) {
  const db = getDb();
  const user = db.prepare('SELECT can_upload FROM users WHERE id = ?').get(req.session.userId);
  return !!(user && user.can_upload);
}

function renderPartnerDashboard(req, res, content, activeTab) {
  const uploadNavItem = canUpload(req)
    ? `<li><a href="/partner/dashboard/upload" class="${activeTab === 'upload' ? 'active' : ''}">Leads einliefern</a></li>`
    : '';
  req.app.locals.renderPage(res, 'partner-dashboard.html', {
    pageTitle: 'Partner-Dashboard',
    partnerContent: content,
    activeOverview: activeTab === 'overview' ? 'active' : '',
    activeLeads: activeTab === 'leads' ? 'active' : '',
    activeImports: activeTab === 'imports' ? 'active' : '',
    uploadNavItem,
    activeGutschriften: activeTab === 'gutschriften' ? 'active' : '',
  });
}

router.get('/partner', (req, res) => {
  const db = getDb();
  const products = db.prepare('SELECT * FROM lead_products WHERE active = 1').all();
  req.app.locals.renderPage(res, 'partner.html', {
    pageTitle: 'Partner-LeadArea – Werde Teil unseres Netzwerks',
    metaDescription: 'Seit über 12 Jahren am Markt: Werde Partner von Partner-LeadArea und profitiere von langjährigen Kooperationen, einem großen Netzwerk und unserem Know-how.',
    alertHtml: '',
    projectTilesHtml: buildProjectTilesHtml(products),
  });
});

router.post('/partner', async (req, res) => {
  const { company, first_name, last_name, street, house_number, postal_code, city, country, phone, email, tax_number, message, appointment_date, appointment_time, agb, newsletter } = req.body;
  const db = getDb();
  const products = db.prepare('SELECT * FROM lead_products WHERE active = 1').all();
  const projectTilesHtml = buildProjectTilesHtml(products);

  if (!company || !first_name || !last_name || !street || !house_number || !postal_code || !city || !country || !phone || !email) {
    const alertHtml = '<div class="alert alert-error">Bitte fülle alle Pflichtfelder aus.</div>';
    return req.app.locals.renderPage(res, 'partner.html', { pageTitle: 'Partner-LeadArea – Werde Teil unseres Netzwerks', alertHtml, projectTilesHtml });
  }

  if (!appointment_date || !appointment_time) {
    const alertHtml = '<div class="alert alert-error">Bitte gib einen Terminwunsch (Datum + Uhrzeit) an.</div>';
    return req.app.locals.renderPage(res, 'partner.html', { pageTitle: 'Partner-LeadArea – Werde Teil unseres Netzwerks', alertHtml, projectTilesHtml });
  }

  if (!agb) {
    const alertHtml = '<div class="alert alert-error">Bitte akzeptiere die AGB.</div>';
    return req.app.locals.renderPage(res, 'partner.html', { pageTitle: 'Partner-LeadArea – Werde Teil unseres Netzwerks', alertHtml, projectTilesHtml });
  }

  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existingUser) {
    const alertHtml = '<div class="alert alert-error">Diese E-Mail-Adresse ist bereits als Partner registriert. Bitte logge dich ein oder nutze eine andere E-Mail-Adresse.</div>';
    return req.app.locals.renderPage(res, 'partner.html', { pageTitle: 'Partner-LeadArea – Werde Teil unseres Netzwerks', alertHtml, projectTilesHtml });
  }

  const appointmentDateObj = new Date(`${appointment_date}T${appointment_time}`);
  const appointment_request = appointmentDateObj.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }) + ', ' + appointment_time + ' Uhr';

  const projectIds = (Array.isArray(req.body.project_ids) ? req.body.project_ids : (req.body.project_ids ? [req.body.project_ids] : []))
    .map(id => parseInt(id)).filter(Boolean);

  const insertApplication = db.prepare(`
    INSERT INTO partner_applications (company, first_name, last_name, street, house_number, postal_code, city, country, phone, email, tax_number, message, appointment_request, agb_accepted_at, newsletter)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
  `);
  const { lastInsertRowid: applicationId } = insertApplication.run(company, first_name, last_name, street, house_number, postal_code, city, country, phone, email, tax_number || null, message || null, appointment_request || null, newsletter ? 1 : 0);

  const insertProject = db.prepare('INSERT INTO partner_application_projects (application_id, product_id) VALUES (?, ?)');
  for (const productId of projectIds) insertProject.run(applicationId, productId);

  // Bei der Erstkontakt/Bewerbung wird bewusst KEIN Account/Passwort
  // abgefragt (Feedback Benni, 2026-10-29: schreckt Interessenten ab) - nur
  // Stammdaten erfassen. Account + Passwort-Vergabe passiert erst, wenn der
  // Vertrag vorliegt und Jens/Frank den Partner im Admin auf "Angenommen"
  // setzen (siehe routes/admin.js, sendPartnerAccountActivationMail).
  const projectNames = projectIds.map(id => (products.find(p => p.id === id) || {}).name).filter(Boolean);
  sendPartnerApplicationNotification({
    company, firstName: first_name, lastName: last_name, phone, email, country, projectNames,
    appointmentRequest: appointment_request, message,
  }).catch(err => console.error('[Partner-Bewerbung] Mail-Versand fehlgeschlagen:', err));

  sendPartnerWelcomeMail({
    toEmail: email, firstName: first_name, company,
    stammdaten: { company, firstName: first_name, lastName: last_name, street, houseNumber: house_number, postalCode: postal_code, city, country, phone, email, taxNumber: tax_number },
  }).catch(err => console.error('[Partner-Welcome-Mail] Mail-Versand fehlgeschlagen:', err));

  const alertHtml = '<div class="alert alert-success">Danke für deine Bewerbung! Wir haben dir eine E-Mail mit den nächsten Schritten geschickt und melden uns zeitnah bei dir für ein persönliches Gespräch.</div>';
  req.app.locals.renderPage(res, 'partner.html', { pageTitle: 'Partner-LeadArea – Werde Teil unseres Netzwerks', alertHtml, projectTilesHtml });
});

// PARTNER DASHBOARD
router.get('/partner/dashboard', requirePartner, (req, res) => {
  const db = getDb();
  const userId = req.session.userId;

  const totalLeads = db.prepare('SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ?').get(userId).c;
  const compensated = db.prepare("SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ? AND lead_status = 'compensated'").get(userId).c;
  const duplicates = db.prepare("SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ? AND lead_status = 'duplicate'").get(userId).c;
  const cancelled = db.prepare("SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ? AND lead_status = 'cancelled'").get(userId).c;
  const pending = db.prepare("SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ? AND lead_status = 'pending'").get(userId).c;
  const blacklisted = db.prepare("SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ? AND lead_status = 'blacklist'").get(userId).c;
  const invalidCount = db.prepare("SELECT COUNT(*) as c FROM lead_pool WHERE partner_user_id = ? AND lead_status = 'invalid'").get(userId).c;

  const content = `
    <h2 style="font-size:1.5rem;margin-bottom:24px;">Willkommen, ${req.session.firstName}!</h2>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-number">${totalLeads}</div><div class="stat-label">Leads gesamt</div></div>
      <div class="stat-card" style="border-left-color:var(--success);"><div class="stat-number">${compensated}</div><div class="stat-label">Vergütet</div></div>
      <div class="stat-card" style="border-left-color:var(--warning);"><div class="stat-number">${duplicates}</div><div class="stat-label">Dubletten</div></div>
      <div class="stat-card" style="border-left-color:var(--error);"><div class="stat-number">${cancelled}</div><div class="stat-label">Storniert</div></div>
    </div>
    <div class="stats-grid" style="margin-top:0;">
      <div class="stat-card" style="border-left-color:var(--accent);"><div class="stat-number">${pending}</div><div class="stat-label">Positiv</div></div>
      <div class="stat-card" style="border-left-color:var(--error);"><div class="stat-number">${blacklisted}</div><div class="stat-label">Blacklist</div></div>
      <div class="stat-card" style="border-left-color:var(--warning);"><div class="stat-number">${invalidCount}</div><div class="stat-label">Ungültig</div></div>
    </div>`;

  renderPartnerDashboard(req, res, content, 'overview');
});

// PARTNER - Meine Leads
router.get('/partner/dashboard/leads', requirePartner, (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const productFilter = parseInt(req.query.product_id) || null;

  const projectOptions = db.prepare(`
    SELECT DISTINCT pr.id, pr.name
    FROM lead_pool lp
    JOIN lead_products pr ON lp.product_id = pr.id
    WHERE lp.partner_user_id = ?
    ORDER BY pr.name
  `).all(userId);

  const leads = db.prepare(`
    SELECT lp.*, pr.name as product_name, lc.name as category_name
    FROM lead_pool lp
    JOIN lead_products pr ON lp.product_id = pr.id
    JOIN lead_categories lc ON pr.category_id = lc.id
    WHERE lp.partner_user_id = ? AND (? IS NULL OR lp.product_id = ?)
    ORDER BY lp.created_at DESC
  `).all(userId, productFilter, productFilter);

  let content = '<h2 style="font-size:1.5rem;margin-bottom:16px;">Meine Leads</h2>';
  content += `
    <form method="GET" action="/partner/dashboard/leads" style="margin-bottom:20px;">
      <select name="product_id" onchange="this.form.submit()" style="padding:8px;border-radius:6px;border:1px solid var(--gray-300);">
        <option value="">Alle Projekte</option>
        ${projectOptions.map(p => `<option value="${p.id}" ${productFilter === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
      </select>
    </form>`;

  if (leads.length === 0) {
    content += `
      <div class="empty-state">
        <div class="empty-icon">📋</div>
        <h3>Noch keine Leads eingeliefert</h3>
      </div>`;
  } else {
    content += `
      <table class="data-table">
        <thead><tr><th>#</th><th>Branche</th><th>Typ</th><th>${leads[0].lead_type === 'b2b' ? 'Firma' : 'Name'}</th><th>PLZ/Ort</th><th>Telefon</th><th>Status</th><th>Grund</th></tr></thead>
        <tbody>`;
    for (const l of leads) {
      const { statusLabel, statusClass } = leadStatusBadge(l);
      const nameCol = l.lead_type === 'b2b'
        ? (l.company_name || '-')
        : `${l.contact_lastname || ''}${l.contact_firstname ? ', ' + l.contact_firstname : ''}`;
      const plzOrt = [l.postal_code, l.city].filter(Boolean).join(' ') || '-';

      content += `
        <tr style="cursor:pointer;" onclick="window.location='/partner/dashboard/leads/${l.id}'">
          <td>${l.id}</td>
          <td>${l.product_name}</td>
          <td><span class="badge ${l.lead_type === 'b2b' ? 'badge-paid' : 'badge-delivered'}">${l.lead_type === 'b2b' ? 'B2B' : 'B2C'}</span></td>
          <td>${nameCol}</td>
          <td>${plzOrt}</td>
          <td>${l.phone || '-'}</td>
          <td><span class="badge ${statusClass}">${statusLabel}</span></td>
          <td>${l.cancel_reason || '-'}</td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  renderPartnerDashboard(req, res, content, 'leads');
});

// PARTNER - Lead-Detailansicht (nur eigene Leads, nur Kontaktdaten - keine Käufer-/Zuweisungsinfos)
router.get('/partner/dashboard/leads/:id', requirePartner, (req, res) => {
  const db = getDb();
  const lead = db.prepare(`
    SELECT lp.*, pr.name as product_name, lc.name as category_name
    FROM lead_pool lp
    JOIN lead_products pr ON lp.product_id = pr.id
    JOIN lead_categories lc ON pr.category_id = lc.id
    WHERE lp.id = ? AND lp.partner_user_id = ?
  `).get(req.params.id, req.session.userId);

  if (!lead) return res.redirect('/partner/dashboard/leads');

  const { statusLabel, statusClass } = leadStatusBadge(lead);

  const dataRows = lead.lead_type === 'b2b' ? `
      <tr><td style="color:var(--gray-500);width:180px;">Firmenname</td><td><strong>${lead.company_name || '-'}</strong></td></tr>
      <tr><td style="color:var(--gray-500);">Nachname (AP)</td><td><strong>${lead.contact_lastname || '-'}</strong></td></tr>
      <tr><td style="color:var(--gray-500);">Straße / Nr.</td><td>${[lead.street, lead.house_number].filter(Boolean).join(' ') || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">PLZ / Ort</td><td>${[lead.postal_code, lead.city].filter(Boolean).join(' ') || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">Telefon</td><td>${lead.phone || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">E-Mail</td><td>${lead.email || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">Bemerkungen</td><td>${lead.remarks || '-'}</td></tr>` : `
      <tr><td style="color:var(--gray-500);width:180px;">Nachname</td><td><strong>${lead.contact_lastname || '-'}</strong></td></tr>
      <tr><td style="color:var(--gray-500);">Vorname</td><td><strong>${lead.contact_firstname || '-'}</strong></td></tr>
      <tr><td style="color:var(--gray-500);">Straße / Nr.</td><td>${[lead.street, lead.house_number].filter(Boolean).join(' ') || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">PLZ / Ort</td><td>${[lead.postal_code, lead.city].filter(Boolean).join(' ') || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">Telefon</td><td>${lead.phone || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">E-Mail</td><td>${lead.email || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">Geburtsdatum</td><td>${lead.date_of_birth || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">Bemerkungen</td><td>${lead.remarks || '-'}</td></tr>`;

  const content = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
      <h2 style="font-size:1.5rem;">Lead #${lead.id}</h2>
      <a href="/partner/dashboard/leads" class="btn btn-secondary btn-sm">&larr; Zurück</a>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
      <div style="background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:var(--radius);padding:24px;">
        <h3 style="margin-bottom:16px;color:var(--primary);">Kontaktdaten</h3>
        <table class="lead-detail-table" style="width:100%;border-collapse:collapse;">
          <tbody>${dataRows}</tbody>
        </table>
      </div>
      <div style="background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:var(--radius);padding:24px;">
        <h3 style="margin-bottom:16px;color:var(--primary);">Lead-Info</h3>
        <table class="lead-detail-table" style="width:100%;border-collapse:collapse;">
          <tbody>
            <tr><td style="color:var(--gray-500);width:160px;">Branche</td><td><strong>${lead.product_name}</strong></td></tr>
            <tr><td style="color:var(--gray-500);">Kategorie</td><td>${lead.category_name}</td></tr>
            <tr><td style="color:var(--gray-500);">Status</td><td><span class="badge ${statusClass}">${statusLabel}</span></td></tr>
            ${lead.cancel_reason ? `<tr><td style="color:var(--gray-500);">Grund</td><td style="color:var(--error);">${lead.cancel_reason}</td></tr>` : ''}
          </tbody>
        </table>
      </div>
    </div>`;

  renderPartnerDashboard(req, res, content, 'leads');
});

// PARTNER - Meine Gutschriften (Verdienst nach Status: Genehmigt/Abgerechnet
// zählt als "offene Provision" - verdient, aber noch nicht ausgezahlt;
// Ausgezahlt ist bereits beglichen. Vergütungssätze (lead_products.partner_payout)
// sind je Projekt noch nicht überall final - solange dort NULL steht, wird
// "steht noch aus" statt eines Betrags angezeigt.
router.get('/partner/dashboard/gutschriften', requirePartner, (req, res) => {
  const db = getDb();
  const userId = req.session.userId;

  const partnerUser = db.prepare('SELECT country FROM users WHERE id = ?').get(userId);
  const vat = getVatForCountry(partnerUser && partnerUser.country);

  const rows = db.prepare(`
    SELECT
      pr.id as product_id, pr.name as product_name, lc.name as category_name, pr.partner_payout,
      COUNT(*) as delivered,
      SUM(CASE WHEN lp.lead_status IN ('duplicate','blacklist','invalid','spam') THEN 1 ELSE 0 END) as rejected,
      SUM(CASE WHEN lp.lead_status = 'cancelled' THEN 1 ELSE 0 END) as cancelled,
      SUM(CASE WHEN lp.lead_status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN lp.lead_status IN ('approved','billed') THEN 1 ELSE 0 END) as open_count,
      SUM(CASE WHEN lp.lead_status = 'paid' THEN 1 ELSE 0 END) as paid_count
    FROM lead_pool lp
    JOIN lead_products pr ON lp.product_id = pr.id
    JOIN lead_categories lc ON pr.category_id = lc.id
    WHERE lp.partner_user_id = ?
    GROUP BY pr.id
    ORDER BY lc.sort_order, pr.name
  `).all(userId);

  let content = '<h2 style="font-size:1.5rem;margin-bottom:8px;">Meine Gutschriften</h2>';
  content += '<p style="color:var(--gray-500);margin-bottom:24px;font-size:0.9rem;">"Offene Provision" ist bereits verdient (genehmigt bzw. abgerechnet), aber noch nicht ausgezahlt - das bekommst du mit der nächsten Gutschrift. Leads "In Bearbeitung" warten noch auf Rückmeldung unseres Auftraggebers und zählen hier noch nicht mit.</p>';

  if (rows.length === 0) {
    content += `
      <div class="empty-state">
        <div class="empty-icon">💳</div>
        <h3>Noch keine Leads eingeliefert</h3>
      </div>`;
  } else {
    let openTotal = 0, paidTotal = 0;
    let allRatesSet = true;
    let tableRows = '';
    for (const r of rows) {
      let rateCell, openCell, paidCell;
      if (r.partner_payout === null) {
        rateCell = '<span style="color:var(--gray-500);">steht noch aus</span>';
        openCell = paidCell = '<span style="color:var(--gray-500);">steht noch aus</span>';
        allRatesSet = false;
      } else {
        const openSum = r.open_count * r.partner_payout;
        const paidSum = r.paid_count * r.partner_payout;
        openTotal += openSum;
        paidTotal += paidSum;
        rateCell = `${r.partner_payout.toFixed(2).replace('.', ',')} €`;
        openCell = `<strong>${openSum.toFixed(2).replace('.', ',')} €</strong>`;
        paidCell = `${paidSum.toFixed(2).replace('.', ',')} €`;
      }
      tableRows += `
        <tr>
          <td>${r.product_name} <small style="color:var(--gray-500);">(${r.category_name})</small></td>
          <td>${r.delivered}</td>
          <td>${r.rejected}</td>
          <td>${r.cancelled}</td>
          <td>${r.pending}</td>
          <td>${r.open_count}</td>
          <td>${r.paid_count}</td>
          <td>${rateCell}</td>
          <td>${openCell}</td>
          <td>${paidCell}</td>
        </tr>`;
    }

    content += `
      <div class="stats-grid" style="margin-bottom:24px;">
        <div class="stat-card" style="border-left-color:var(--primary);"><div class="stat-number">${openTotal.toFixed(2).replace('.', ',')} €</div><div class="stat-label">Aktueller Verdienst (offen)${allRatesSet ? '' : ' *'}</div></div>
        <div class="stat-card" style="border-left-color:var(--success);"><div class="stat-number">${paidTotal.toFixed(2).replace('.', ',')} €</div><div class="stat-label">Bereits ausgezahlt</div></div>
      </div>
      ${allRatesSet ? '' : '<p style="color:var(--warning);font-size:0.85rem;margin-top:-16px;margin-bottom:20px;">* Für mindestens ein Projekt ist der Vergütungssatz noch nicht festgelegt - fehlt daher in der Summe.</p>'}
      <table class="data-table">
        <thead><tr><th>Branche</th><th>Eingeliefert</th><th>Abgelehnt</th><th>Storniert</th><th>In Bearbeitung</th><th>Genehmigt/Abgerechnet</th><th>Ausgezahlt</th><th>Satz / Lead</th><th>Offene Provision</th><th>Ausgezahlt (€)</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>`;

    if (!partnerUser || !partnerUser.country) {
      content += `
        <div style="text-align:right;margin-top:16px;">
          <div style="font-size:1.2rem;font-weight:800;">Nächste Auszahlung (netto)${allRatesSet ? '' : ' (nur Projekte mit festgelegtem Satz)'}: ${openTotal.toFixed(2).replace('.', ',')} €</div>
          <p style="font-size:0.8rem;color:var(--gray-500);margin-top:4px;">Land des Partners ist nicht hinterlegt – MwSt.-Ausweis auf der Gutschrift kann noch nicht bestimmt werden.</p>
        </div>`;
    } else if (vat.applies) {
      const vatAmount = Math.round(openTotal * vat.rate * 100) / 100;
      const gross = Math.round((openTotal + vatAmount) * 100) / 100;
      content += `
        <div style="text-align:right;margin-top:16px;">
          <div style="color:var(--gray-500);">Zwischensumme (netto)${allRatesSet ? '' : ' (nur Projekte mit festgelegtem Satz)'}: ${openTotal.toFixed(2).replace('.', ',')} €</div>
          <div style="color:var(--gray-500);">zzgl. ${formatVatRate(vat.rate)}% MwSt.: ${vatAmount.toFixed(2).replace('.', ',')} €</div>
          <div style="font-size:1.2rem;font-weight:800;margin-top:4px;">Nächste Auszahlung: ${gross.toFixed(2).replace('.', ',')} €</div>
        </div>`;
    } else {
      content += `
        <div style="text-align:right;margin-top:16px;">
          <div style="font-size:1.2rem;font-weight:800;">Nächste Auszahlung${allRatesSet ? '' : ' (nur Projekte mit festgelegtem Satz)'}: ${openTotal.toFixed(2).replace('.', ',')} €</div>
          <p style="font-size:0.8rem;color:var(--gray-500);margin-top:4px;">Steuerfreie Auslandsleistung – ohne MwSt., LeadArea GmbH hat Sitz in der Schweiz.</p>
        </div>`;
    }
  }

  renderPartnerDashboard(req, res, content, 'gutschriften');
});

// PARTNER - Meine Imports
router.get('/partner/dashboard/imports', requirePartner, (req, res) => {
  const db = getDb();
  const userId = req.session.userId;

  const imports = db.prepare(`
    SELECT li.*, lp.name as product_name, lp.lead_type, lc.name as category_name
    FROM lead_imports li
    JOIN lead_products lp ON li.product_id = lp.id
    JOIN lead_categories lc ON lp.category_id = lc.id
    WHERE li.partner_user_id = ?
    ORDER BY li.imported_at DESC
  `).all(userId);

  let content = '<h2 style="font-size:1.5rem;margin-bottom:24px;">Meine Imports</h2>';

  if (imports.length === 0) {
    content += '<p style="color:var(--gray-500);">Noch keine Imports.</p>';
  } else {
    content += `
      <table class="data-table">
        <thead><tr><th>Datum</th><th>Branche</th><th>Typ</th><th>Datei</th><th>Importiert</th><th>Dubletten</th><th>Blacklist</th><th>Ungültig</th></tr></thead>
        <tbody>`;
    for (const i of imports) {
      content += `
        <tr>
          <td>${new Date(i.imported_at).toLocaleString('de-DE')}</td>
          <td>${i.product_name}</td>
          <td><span class="badge ${i.lead_type === 'b2b' ? 'badge-paid' : 'badge-delivered'}">${i.lead_type === 'b2b' ? 'B2B' : 'B2C'}</span></td>
          <td style="font-size:0.8rem;">${i.filename || '-'}</td>
          <td><strong>${i.lead_count}</strong></td>
          <td style="color:${i.duplicates_skipped > 0 ? 'var(--warning)' : 'var(--gray-500)'};">${i.duplicates_skipped}</td>
          <td style="color:${(i.blacklist_skipped || 0) > 0 ? 'var(--error)' : 'var(--gray-500)'};">${i.blacklist_skipped || 0}</td>
          <td style="color:${(i.invalid_skipped || 0) > 0 ? 'var(--warning)' : 'var(--gray-500)'};">${i.invalid_skipped || 0}</td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  renderPartnerDashboard(req, res, content, 'imports');
});

// PARTNER - Leads einliefern (Upload-Seite)
router.get('/partner/dashboard/upload', requirePartner, (req, res) => {
  if (!canUpload(req)) return res.redirect('/partner/dashboard');

  if (!getContractStatus(req.session.userId)) {
    const content = `
      <h2 style="font-size:1.5rem;margin-bottom:24px;">Leads einliefern</h2>
      <div class="alert alert-warning">
        Dein Vertrag wurde noch nicht als unterschrieben hinterlegt. Liefertemplates
        und der Upload-Bereich werden freigeschaltet, sobald das erledigt ist - bitte
        wende dich an deinen Ansprechpartner bei uns, falls du denkst, das sollte
        schon der Fall sein.
      </div>`;
    return renderPartnerDashboard(req, res, content, 'upload');
  }

  const products = getApprovedProducts(req.session.userId);

  if (products.length === 0) {
    const content = `
      <h2 style="font-size:1.5rem;margin-bottom:24px;">Leads einliefern</h2>
      <div class="alert alert-warning">
        Für dich sind aktuell noch keine Projekte freigegeben. Sobald das passiert
        ist, erscheinen hier die passenden Liefertemplates.
      </div>`;
    return renderPartnerDashboard(req, res, content, 'upload');
  }

  const deliveryFieldsByProduct = {};
  for (const row of getDb().prepare('SELECT product_id, field_label FROM product_delivery_fields ORDER BY product_id, sort_order').all()) {
    if (!deliveryFieldsByProduct[row.product_id]) deliveryFieldsByProduct[row.product_id] = [];
    deliveryFieldsByProduct[row.product_id].push(row.field_label);
  }
  let productOptions = products.map(p => `<option value="${p.id}" data-leadtype="${p.lead_type}" data-extrafields="${(deliveryFieldsByProduct[p.id] || []).join(';')}">${p.category_name} &rarr; ${p.name} (${p.lead_type === 'b2b' ? 'B2B' : 'B2C'})</option>`).join('');

  const templateLinksHtml = products.map(p =>
    `<a href="/partner/dashboard/template/${p.id}" class="btn btn-outline btn-sm" style="margin:4px 4px 4px 0;">Vorlage: ${p.name} herunterladen</a>`
  ).join('');

  const alertHtml = req.query.success ? `<div class="alert alert-success">
    Import abgeschlossen: <strong>${req.query.imported || 0}</strong> Leads in QM-Prüfung &nbsp;|&nbsp;
    <strong>${req.query.duplicates || 0}</strong> Dubletten &nbsp;|&nbsp;
    <strong>${req.query.blacklist || 0}</strong> Blacklist &nbsp;|&nbsp;
    <strong>${req.query.invalid || 0}</strong> ungültig
  </div>` : '';

  const content = `
    <h2 style="font-size:1.5rem;margin-bottom:24px;">Leads einliefern</h2>
    ${alertHtml}
    <div style="background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:var(--radius);padding:24px;margin-bottom:24px;">
      <h3 style="margin-bottom:16px;color:var(--white);">Liefertemplates deiner freigegebenen Projekte</h3>
      ${templateLinksHtml}
    </div>
    <div style="background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:var(--radius);padding:24px;">
      <h3 style="margin-bottom:16px;color:var(--white);">CSV-Upload</h3>
      <div class="alert alert-warning" style="margin-bottom:16px;">
        <strong>Wichtig:</strong> Daten müssen bis spätestens <strong>20:00 Uhr am Produktionstag</strong> hochgeladen werden, damit sie am Folgetag um 11 Uhr mit ausgeliefert werden können. Später eingelieferte Daten rutschen in den übernächsten Tag.
      </div>
      <p style="color:var(--gray-300);margin-bottom:16px;font-size:0.9rem;">
        CSV-Format (Semikolon-getrennt, mit oder ohne Kopfzeile):<br>
        <code id="formatInfo">${products[0].lead_type === 'b2b' ? 'Firmenname;Nachname;Strasse;Hausnummer;PLZ;Ort;Telefon;Email;Bemerkungen;Voicefile-Link' : 'Nachname;Vorname;Strasse;Hausnummer;PLZ;Ort;Telefon;Email;Geburtsdatum;Bemerkungen;Voicefile-Link'}</code><br>
        <small>Nur deutsche Leads (PLZ 5-stellig). Dubletten werden automatisch erkannt. <strong>Voicefile-Link ist Pflicht:</strong> direkter Link zur bereits gehosteten Audiodatei (kein Datei-Upload nötig) - Zeilen ohne gültigen Link (http/https) werden als ungültig abgelehnt. Nutze am besten die Vorlage oben statt die Spalten selbst nachzubauen.</small>
      </p>
      <form method="POST" action="/partner/dashboard/upload" enctype="multipart/form-data">
        <div class="form-row">
          <div class="form-group">
            <label>Produkt / Branche *</label>
            <select name="product_id" required onchange="var o=this.options[this.selectedIndex]; var t=o.getAttribute('data-leadtype'); var base = t==='b2b' ? 'Firmenname;Nachname;Strasse;Hausnummer;PLZ;Ort;Telefon;Email;Bemerkungen;Voicefile-Link' : 'Nachname;Vorname;Strasse;Hausnummer;PLZ;Ort;Telefon;Email;Geburtsdatum;Bemerkungen;Voicefile-Link'; var extra = o.getAttribute('data-extrafields'); document.getElementById('formatInfo').textContent = extra ? base + ';' + extra : base;">
              ${productOptions}
            </select>
          </div>
          <div class="form-group">
            <label>CSV-Datei *</label>
            <input type="file" name="csvfile" accept=".csv,.txt" required>
          </div>
        </div>
        <button type="submit" class="btn btn-primary">Einliefern</button>
      </form>
    </div>`;

  renderPartnerDashboard(req, res, content, 'upload');
});

// PARTNER - Liefertemplate herunterladen (nur fuer freigegebene Projekte,
// nur nach Vertragsunterschrift - siehe getContractStatus/getApprovedProducts).
router.get('/partner/dashboard/template/:productId', requirePartner, (req, res) => {
  if (!getContractStatus(req.session.userId)) return res.redirect('/partner/dashboard/upload');

  const approved = getApprovedProducts(req.session.userId);
  const productId = parseInt(req.params.productId);
  const product = approved.find(p => p.id === productId);
  if (!product) return res.redirect('/partner/dashboard/upload');

  const template = getDeliveryTemplate(productId);
  if (!template) return res.redirect('/partner/dashboard/upload');

  const filename = `Liefertemplate_${template.product.name.replace(/[^a-zA-Z0-9]+/g, '_')}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(template.header + '\r\n');
});

// PARTNER - CSV Upload Handler
const { processImport } = require('../lib/importLeads');

router.post('/partner/dashboard/upload', requirePartner, partnerUpload.single('csvfile'), (req, res) => {
  if (!canUpload(req)) return res.redirect('/partner/dashboard');
  if (!getContractStatus(req.session.userId)) return res.redirect('/partner/dashboard/upload');
  if (!req.file) return res.redirect('/partner/dashboard/upload');

  const productId = parseInt(req.body.product_id);
  const isApproved = getApprovedProducts(req.session.userId).some(p => p.id === productId);
  if (!isApproved) { try { require('fs').unlinkSync(req.file.path); } catch (_) {} return res.redirect('/partner/dashboard/upload'); }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const supplierName = `${user.first_name} ${user.last_name}`;

  const result = processImport({
    filePath: req.file.path,
    originalFilename: req.file.originalname,
    productId,
    partnerUserId: req.session.userId,
    supplierName,
    maxAssignments: 3,
  });

  if (!result) return res.redirect('/partner/dashboard/upload');
  res.redirect(`/partner/dashboard/upload?success=1&imported=${result.imported}&duplicates=${result.duplicates}&blacklist=${result.blacklisted}&invalid=${result.invalid}`);
});

module.exports = router;
