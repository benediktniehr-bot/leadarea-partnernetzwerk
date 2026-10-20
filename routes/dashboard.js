const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { sendReaccessRequest } = require('../lib/mailer');
const { formatVatRate } = require('../lib/vat');
const { SELLER: SELLER_PLACEHOLDER, BANK_DETAILS } = require('../lib/companyInfo');
const { generateInvoicePdfBuffer } = require('../lib/invoicePdf');
const { withTierLabel } = require('../lib/tierLabels');

// Datenminimierung ggü. Käufer: der Pflegegrad (1-5) wird vom CC erfasst/gespeichert,
// an Käufer aber bewusst nur als Ja/Nein weitergegeben, nicht die konkrete Stufe.
function buyerFacingAttrValue(fieldKey, value) {
  if (fieldKey !== 'pflegegrad') return value;
  if (!value) return value;
  return /^nein$/i.test(value.trim()) ? 'Nein' : 'Ja';
}

function renderDashboard(req, res, content, activeTab) {
  req.app.locals.renderPage(res, 'dashboard.html', {
    pageTitle: 'Dashboard',
    dashboardContent: content,
    activeDashboard: activeTab === 'dashboard' ? 'active' : '',
    activeOrders: activeTab === 'orders' ? 'active' : '',
    activeLeads: activeTab === 'leads' ? 'active' : '',
    activeInvoices: activeTab === 'invoices' ? 'active' : '',
  });
}

router.get('/dashboard', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.session.userId;

  const orderCount = db.prepare('SELECT COUNT(*) as count FROM orders WHERE user_id = ?').get(userId).count;
  const leadCount = db.prepare('SELECT COUNT(*) as count FROM lead_assignments WHERE user_id = ?').get(userId).count;
  const totalSpent = db.prepare('SELECT COALESCE(SUM(total), 0) as total FROM orders WHERE user_id = ?').get(userId).total;
  const openReclamations = db.prepare('SELECT COUNT(*) as count FROM reclamations WHERE user_id = ? AND status = ?').get(userId, 'open').count;

  const content = `
    <h2 style="font-size:1.5rem;margin-bottom:24px;">Willkommen, ${req.session.firstName}!</h2>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-number">${orderCount}</div>
        <div class="stat-label">Bestellungen</div>
      </div>
      <div class="stat-card" style="border-left-color:var(--accent);">
        <div class="stat-number">${leadCount}</div>
        <div class="stat-label">Erhaltene Leads</div>
      </div>
      <div class="stat-card" style="border-left-color:var(--warning);">
        <div class="stat-number">${totalSpent.toFixed(2).replace('.', ',')} €</div>
        <div class="stat-label">Ausgegeben</div>
      </div>
      <div class="stat-card" style="border-left-color:var(--error);">
        <div class="stat-number">${openReclamations}</div>
        <div class="stat-label">Offene Reklamationen</div>
      </div>
    </div>
    <div style="margin-top:24px;">
      <a href="/marktplatz" class="btn btn-primary">Neue Leads bestellen</a>
    </div>`;

  renderDashboard(req, res, content, 'dashboard');
});

router.get('/dashboard/orders', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const orders = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  const successId = req.query.success;

  let alertHtml = '';
  if (req.query.paid) {
    alertHtml = `<div class="alert alert-success">Zahlung bestätigt! Deine Leads werden jetzt zugewiesen.</div>`;
  } else if (req.query.pending) {
    alertHtml = `<div class="alert alert-warning">Bestellung eingegangen – deine SEPA-Lastschrift wird noch verarbeitet (kann einige Werktage dauern). Sobald das Geld bei uns eingegangen ist, werden deine Leads automatisch zugewiesen.</div>`;
  } else if (req.query.invoiceSent) {
    alertHtml = `<div class="alert alert-success">Bestellung #${req.query.invoiceSent} aufgegeben! Die Rechnung mit den Zahlungsinformationen wurde dir per E-Mail zugeschickt. Sobald deine Zahlung bei uns eingegangen ist, wird deine Bestellung bearbeitet.</div>`;
  } else if (successId) {
    alertHtml = `<div class="alert alert-success">Bestellung #${successId} aufgegeben – bitte jetzt bezahlen.</div>`;
  }

  let content = alertHtml + '<h2 style="font-size:1.5rem;margin-bottom:24px;">Meine Bestellungen</h2>';

  if (orders.length === 0) {
    content += `
      <div class="empty-state">
        <div class="empty-icon">📦</div>
        <h3>Noch keine Bestellungen</h3>
        <p>Bestelle deine ersten Leads im Marktplatz.</p>
        <a href="/marktplatz" class="btn btn-primary">Zum Marktplatz</a>
      </div>`;
  } else {
    content += '<table class="data-table"><thead><tr><th>#</th><th>Datum</th><th>Gesamt</th><th>Status</th><th>Details</th></tr></thead><tbody>';
    for (const order of orders) {
      const statusClass = `badge-${order.status}`;
      const statusLabel = { pending: 'Ausstehend', paid: 'Bezahlt', delivered: 'Geliefert', cancelled: 'Storniert' }[order.status] || order.status;
      content += `
        <tr>
          <td>${order.id}</td>
          <td>${new Date(order.created_at).toLocaleDateString('de-DE')}</td>
          <td>${order.total.toFixed(2).replace('.', ',')} €</td>
          <td><span class="badge ${statusClass}">${statusLabel}</span></td>
          <td><a href="/dashboard/orders/${order.id}" class="btn btn-outline btn-sm">Ansehen</a></td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  renderDashboard(req, res, content, 'orders');
});

router.get('/dashboard/orders/:id', requireAuth, (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!order) return res.redirect('/dashboard/orders');

  const items = db.prepare(`
    SELECT oi.*, lp.name as product_name FROM order_items oi
    JOIN lead_products lp ON oi.product_id = lp.id
    WHERE oi.order_id = ?
  `).all(order.id).map(i => ({ ...i, product_name: withTierLabel(i.product_name, i.tier) }));

  const statusLabel = { pending: 'Ausstehend', paid: 'Bezahlt', delivered: 'Geliefert', cancelled: 'Storniert' }[order.status] || order.status;

  let content = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
      <h2 style="font-size:1.5rem;">Bestellung #${order.id}</h2>
      <span class="badge badge-${order.status}">${statusLabel}</span>
    </div>
    <p style="color:var(--gray-500);margin-bottom:24px;">Bestellt am ${new Date(order.created_at).toLocaleDateString('de-DE')}</p>
    <table class="data-table">
      <thead><tr><th>Produkt</th><th>Anzahl</th><th>Stückpreis</th><th>Gesamt</th></tr></thead>
      <tbody>`;

  for (const item of items) {
    content += `
      <tr>
        <td>${item.product_name}</td>
        <td>${item.quantity}</td>
        <td>${item.unit_price.toFixed(2).replace('.', ',')} €</td>
        <td>${(item.unit_price * item.quantity).toFixed(2).replace('.', ',')} €</td>
      </tr>`;
  }

  content += `
      </tbody>
    </table>
    <div style="text-align:right;margin-top:16px;font-size:1.2rem;font-weight:800;">
      Gesamt: ${order.total.toFixed(2).replace('.', ',')} €
    </div>
    <div style="margin-top:24px;">
      <a href="/dashboard/orders" class="btn btn-outline">Zurück zu Bestellungen</a>
    </div>`;

  renderDashboard(req, res, content, 'orders');
});

// ─── RECHNUNGEN ──────────────────────────────────────────────────────────────

router.get('/dashboard/invoices', requireAuth, (req, res) => {
  const db = getDb();
  const invoices = db.prepare(`
    SELECT i.*, o.id as order_id FROM invoices i
    JOIN orders o ON i.order_id = o.id
    WHERE i.user_id = ?
    ORDER BY i.id DESC
  `).all(req.session.userId);

  let content = '<h2 style="font-size:1.5rem;margin-bottom:24px;">Meine Rechnungen</h2>';

  if (invoices.length === 0) {
    content += `
      <div class="empty-state">
        <div class="empty-icon">🧾</div>
        <h3>Noch keine Rechnungen</h3>
        <p>Rechnungen erscheinen hier, sobald eine Bestellung bezahlt wurde.</p>
      </div>`;
  } else {
    content += '<table class="data-table"><thead><tr><th>Rechnungs-Nr.</th><th>Datum</th><th>Bestellung</th><th>Gesamt (brutto)</th><th></th></tr></thead><tbody>';
    for (const inv of invoices) {
      const invoiceNumber = `RE-${new Date(inv.invoice_date).getFullYear()}-${String(inv.id).padStart(6, '0')}`;
      content += `
        <tr>
          <td>${invoiceNumber}</td>
          <td>${new Date(inv.invoice_date).toLocaleDateString('de-DE')}</td>
          <td>#${inv.order_id}</td>
          <td>${inv.gross_total.toFixed(2).replace('.', ',')} €</td>
          <td><a href="/dashboard/invoices/${inv.id}" class="btn btn-outline btn-sm">Ansehen</a></td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  renderDashboard(req, res, content, 'invoices');
});

router.get('/dashboard/invoices/:id', requireAuth, (req, res) => {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!invoice) return res.redirect('/dashboard/invoices');

  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(invoice.order_id);
  const buyer = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  const items = db.prepare(`
    SELECT oi.*, lp.name as product_name FROM order_items oi
    JOIN lead_products lp ON oi.product_id = lp.id
    WHERE oi.order_id = ?
  `).all(invoice.order_id).map(i => ({ ...i, product_name: withTierLabel(i.product_name, i.tier) }));

  const invoiceNumber = `RE-${new Date(invoice.invoice_date).getFullYear()}-${String(invoice.id).padStart(6, '0')}`;
  const vatApplies = invoice.vat_rate > 0;
  const vatLabel = vatApplies
    ? `zzgl. ${formatVatRate(invoice.vat_rate)}% MwSt.`
    : 'MwSt. (steuerfreie Auslandsleistung)';
  const reverseChargeNote = vatApplies ? '' :
    '<p style="margin-top:8px;font-size:0.8rem;color:var(--gray-500);">Steuerfreie Auslandsleistung – Steuerschuldnerschaft ggf. beim Leistungsempfänger.</p>';

  let itemRows = '';
  for (const item of items) {
    itemRows += `
      <tr>
        <td>${item.product_name}</td>
        <td>${item.quantity}</td>
        <td>${item.unit_price.toFixed(2).replace('.', ',')} €</td>
        <td>${(item.unit_price * item.quantity).toFixed(2).replace('.', ',')} €</td>
      </tr>`;
  }

  const content = `
    <div class="invoice-print-area" style="background:var(--white);color:var(--dark);border-radius:var(--radius);padding:40px;box-shadow:var(--shadow-sm);max-width:800px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:40px;">
        <div>
          <h2 style="font-size:1.3rem;margin-bottom:8px;">${SELLER_PLACEHOLDER.name}</h2>
          <p style="color:var(--gray-500);font-size:0.9rem;">${SELLER_PLACEHOLDER.address}<br>${SELLER_PLACEHOLDER.vatId}</p>
        </div>
        <div style="text-align:right;">
          <h1 style="font-size:1.5rem;">Rechnung</h1>
          <p style="color:var(--gray-500);font-size:0.9rem;">
            Rechnungs-Nr.: <strong>${invoiceNumber}</strong><br>
            Rechnungsdatum: ${new Date(invoice.invoice_date).toLocaleDateString('de-DE')}<br>
            Bestellung: #${invoice.order_id}
          </p>
        </div>
      </div>

      <div style="margin-bottom:32px;">
        <p style="color:var(--gray-500);font-size:0.85rem;margin-bottom:4px;">Rechnungsempfänger</p>
        <p>${buyer.company ? `<strong>${buyer.company}</strong><br>` : ''}${buyer.first_name} ${buyer.last_name}<br>${buyer.street || ''} ${buyer.house_number || ''}<br>${buyer.postal_code || ''} ${buyer.city || ''}<br>${buyer.email}</p>
      </div>

      <table class="data-table">
        <thead><tr><th>Produkt</th><th>Anzahl</th><th>Einzelpreis (netto)</th><th>Gesamt (netto)</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>

      <div style="margin-top:16px;text-align:right;">
        <div style="color:var(--gray-500);">Zwischensumme (netto): ${invoice.net_total.toFixed(2).replace('.', ',')} €</div>
        <div style="color:var(--gray-500);">${vatLabel}: ${invoice.vat_total.toFixed(2).replace('.', ',')} €</div>
        <div style="font-size:1.3rem;font-weight:800;margin-top:8px;">Gesamt: ${invoice.gross_total.toFixed(2).replace('.', ',')} €</div>
      </div>
      ${reverseChargeNote}

      <p style="margin-top:16px;font-size:0.8rem;color:var(--gray-700);background:var(--gray-50);border-radius:6px;padding:12px 16px;">
        <strong>Nutzungshinweis:</strong> Die mit dieser Bestellung erworbenen Kontaktdaten dürfen ausschließlich zur
        Kontaktaufnahme bezüglich des jeweils bestellten Produkts/der jeweils bestellten Branche verwendet werden
        (siehe Spalte "Produkt" oben). Eine Verwendung der Daten für andere Produkte, Branchen oder Zwecke ist
        nicht gestattet.
      </p>

      ${order && order.status === 'pending' ? `
      <table style="width:100%;border-collapse:collapse;background:var(--gray-50);border-radius:8px;margin-top:16px;">
        <tr><td colspan="2" style="padding:10px 12px 2px;font-weight:700;">Bitte überweise den Betrag auf folgendes Konto</td></tr>
        <tr><td style="padding:2px 12px;color:var(--gray-500);width:140px;">Kontoinhaber</td><td style="padding:2px 12px;">${BANK_DETAILS.kontoinhaber}</td></tr>
        <tr><td style="padding:2px 12px;color:var(--gray-500);">IBAN</td><td style="padding:2px 12px;">${BANK_DETAILS.iban}</td></tr>
        <tr><td style="padding:2px 12px;color:var(--gray-500);">BIC</td><td style="padding:2px 12px;">${BANK_DETAILS.bic}</td></tr>
        <tr><td style="padding:2px 12px;color:var(--gray-500);">Bank</td><td style="padding:2px 12px;">${BANK_DETAILS.bankname}</td></tr>
        <tr><td style="padding:2px 12px 10px;color:var(--gray-500);">Verwendungszweck</td><td style="padding:2px 12px 10px;"><strong>Bestellung #${invoice.order_id}</strong></td></tr>
      </table>` : `
      <p style="margin-top:16px;font-size:0.8rem;color:var(--gray-500);">Der Betrag wurde bereits über die Bestellung beglichen.</p>`}
    </div>

    <div class="no-print" style="margin-top:24px;display:flex;gap:12px;">
      <a href="/dashboard/invoices/${invoice.id}/pdf" class="btn btn-primary">PDF herunterladen</a>
      <a href="/dashboard/invoices" class="btn btn-outline">Zurück</a>
    </div>`;

  renderDashboard(req, res, content, 'invoices');
});

router.get('/dashboard/invoices/:id/pdf', requireAuth, (req, res) => {
  const db = getDb();
  const invoice = db.prepare('SELECT * FROM invoices WHERE id = ? AND user_id = ?').get(req.params.id, req.session.userId);
  if (!invoice) return res.redirect('/dashboard/invoices');

  const order = db.prepare('SELECT status FROM orders WHERE id = ?').get(invoice.order_id);
  const buyer = db.prepare('SELECT company, first_name, last_name, email, street, house_number, postal_code, city FROM users WHERE id = ?').get(req.session.userId);
  const items = db.prepare(`
    SELECT oi.*, lp.name as product_name FROM order_items oi
    JOIN lead_products lp ON oi.product_id = lp.id
    WHERE oi.order_id = ?
  `).all(invoice.order_id).map(i => ({ ...i, product_name: withTierLabel(i.product_name, i.tier) }));

  const invoiceNumber = `RE-${new Date(invoice.invoice_date).getFullYear()}-${String(invoice.id).padStart(6, '0')}`;

  try {
    const pdfBuffer = generateInvoicePdfBuffer({
      invoiceNumber,
      invoiceDate: new Date(invoice.invoice_date).toLocaleDateString('de-DE'),
      orderId: invoice.order_id,
      orderStatus: order ? order.status : 'pending',
      buyer,
      items,
      netTotal: invoice.net_total,
      vatTotal: invoice.vat_total,
      grossTotal: invoice.gross_total,
      vatRate: invoice.vat_rate,
      vatApplies: invoice.vat_rate > 0,
    });
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${invoiceNumber}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[InvoicePdf] Download-Fehler:', err.message);
    res.redirect(`/dashboard/invoices/${invoice.id}`);
  }
});

router.get('/dashboard/leads', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.session.userId;

  // Pool-Leads aus bezahlten Bestellungen mit Download-Status
  const poolLeads = db.prepare(`
    SELECT lp.*, pr.name as product_name, pr.id as product_id_ref, lc.name as category_name,
           la.assigned_at, la.downloaded_at, la.id as assignment_id
    FROM lead_assignments la
    JOIN lead_pool lp ON la.pool_lead_id = lp.id
    JOIN order_items oi ON la.order_item_id = oi.id
    JOIN orders o ON oi.order_id = o.id
    JOIN lead_products pr ON lp.product_id = pr.id
    JOIN lead_categories lc ON pr.category_id = lc.id
    WHERE la.user_id = ? AND o.status IN ('paid', 'delivered')
    ORDER BY pr.id, la.assigned_at ASC
  `).all(userId);

  // Direkte Leads (Legacy) aus bezahlten Bestellungen
  const directLeads = db.prepare(`
    SELECT l.*, lp.name as product_name FROM leads l
    JOIN order_items oi ON l.order_item_id = oi.id
    JOIN orders o ON oi.order_id = o.id
    JOIN lead_products lp ON oi.product_id = lp.id
    WHERE l.user_id = ? AND o.status IN ('paid', 'delivered')
    ORDER BY l.delivered_at DESC
  `).all(userId);

  // Pool-Leads nach Branche gruppieren
  const byProduct = {};
  for (const l of poolLeads) {
    const key = l.product_id_ref;
    if (!byProduct[key]) byProduct[key] = { product_name: l.product_name, category_name: l.category_name, leads: [] };
    byProduct[key].leads.push(l);
  }

  const accessRequestAlert = req.query.accessRequested
    ? '<div class="alert alert-success" style="margin-bottom:20px;">Anfrage verschickt – unser Team meldet sich, sobald der erneute Download freigegeben ist.</div>'
    : '';

  let content = accessRequestAlert + '<h2 style="font-size:1.5rem;margin-bottom:24px;">Meine Leads</h2>';

  if (Object.keys(byProduct).length === 0 && directLeads.length === 0) {
    content += `
      <div class="empty-state">
        <div class="empty-icon">👤</div>
        <h3>Noch keine Leads erhalten</h3>
        <p>Sobald deine Bestellung bearbeitet wird, erscheinen deine Leads hier.</p>
      </div>`;
  }

  // Pro Branche: Download-Kachel + Tabelle
  for (const [productId, group] of Object.entries(byProduct)) {
    const total = group.leads.length;
    const downloaded = group.leads.filter(l => l.downloaded_at).length;
    const remaining = total - downloaded;

    content += `
      <div style="background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:var(--radius);padding:24px;margin-bottom:28px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
          <div>
            <h3 style="margin-bottom:4px;color:var(--white);">${group.product_name}</h3>
            <small style="color:var(--gray-300);">${group.category_name}</small>
          </div>
          <div style="display:flex;gap:20px;text-align:center;">
            <div><div style="font-size:1.4rem;font-weight:800;color:var(--white);">${total}</div><div style="font-size:0.75rem;color:var(--gray-300);">Zugewiesen</div></div>
            <div><div style="font-size:1.4rem;font-weight:800;color:var(--success);">${downloaded}</div><div style="font-size:0.75rem;color:var(--gray-300);">Heruntergeladen</div></div>
            <div><div style="font-size:1.4rem;font-weight:800;color:${remaining > 0 ? 'var(--accent)' : 'var(--gray-400)'};">${remaining}</div><div style="font-size:0.75rem;color:var(--gray-300);">Verfügbar</div></div>
          </div>
        </div>`;

    if (remaining > 0) {
      content += `
        <form method="GET" action="/dashboard/leads/export" style="display:flex;align-items:center;gap:12px;padding:16px;background:rgba(255,255,255,0.05);border-radius:8px;margin-bottom:16px;">
          <input type="hidden" name="productId" value="${productId}">
          <label style="white-space:nowrap;font-weight:600;color:var(--gray-200);">Jetzt herunterladen:</label>
          <input type="number" name="count" value="${remaining}" min="1" max="${remaining}"
            style="width:80px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.05);color:var(--white);font-size:0.95rem;">
          <span style="color:var(--gray-300);font-size:0.85rem;">von ${remaining} verfügbaren Leads</span>
          <button type="submit" class="btn btn-primary btn-sm">Als CSV herunterladen</button>
        </form>`;
    } else {
      content += `<div style="padding:12px 16px;background:#f0fdf4;border-radius:8px;margin-bottom:16px;color:var(--success);font-weight:600;">Alle Leads bereits heruntergeladen.</div>`;
    }

    // Produktspezifische Zusatzfelder (Liefertemplate) für diese Branche
    const deliveryFieldDefs = db.prepare(
      'SELECT field_key, field_label FROM product_delivery_fields WHERE product_id = ? ORDER BY sort_order'
    ).all(productId);
    const getAttrsForLead = db.prepare('SELECT field_key, field_value FROM lead_pool_attributes WHERE pool_lead_id = ?');
    const extraColHeader = deliveryFieldDefs.length > 0 ? '<th>Zusatzinfos</th>' : '';

    // Tabelle der Leads dieser Branche
    content += `
      <table class="data-table" style="font-size:0.875rem;">
        <thead><tr><th>Firma / Name</th><th>PLZ/Ort</th><th>Telefon</th><th>E-Mail</th>${extraColHeader}<th>Zugewiesen am</th><th>Status</th></tr></thead>
        <tbody>`;
    for (const l of group.leads) {
      const plzOrt = [l.postal_code, l.city].filter(Boolean).join(' ') || '-';
      const nameCol = l.lead_type === 'b2b'
        ? `${l.company_name || '-'} <small style="color:var(--gray-500);">(${l.contact_lastname || ''})</small>`
        : `${l.contact_lastname || ''}${l.contact_firstname ? ', ' + l.contact_firstname : ''}`;

      let extraCol = '';
      if (deliveryFieldDefs.length > 0) {
        const attrMap = {};
        for (const a of getAttrsForLead.all(l.id)) attrMap[a.field_key] = buyerFacingAttrValue(a.field_key, a.field_value);
        const parts = deliveryFieldDefs
          .filter(f => attrMap[f.field_key])
          .map(f => `${f.field_label}: ${attrMap[f.field_key]}`);
        extraCol = `<td style="color:var(--gray-300);font-size:0.8rem;">${parts.join(' · ') || '-'}</td>`;
      }

      if (l.downloaded_at) {
        // Aus Sicherheitsgründen: nach dem einmaligen Download werden Kontaktdaten
        // nicht mehr dauerhaft angezeigt. Erneuter Zugriff nur nach manueller Freigabe.
        content += `
          <tr>
            <td colspan="${deliveryFieldDefs.length > 0 ? 5 : 4}" style="color:var(--gray-500);">
              &#128274; Bereits am ${new Date(l.downloaded_at).toLocaleDateString('de-DE')} heruntergeladen — Kontaktdaten aus Sicherheitsgründen ausgeblendet.
              <form method="POST" action="/dashboard/leads/${l.assignment_id}/request-access" style="display:inline;margin-left:8px;">
                <button type="submit" class="btn btn-outline btn-sm">Zugriff erneut anfragen</button>
              </form>
            </td>
            <td>${new Date(l.assigned_at).toLocaleDateString('de-DE')}</td>
            <td><span class="badge badge-delivered">Geladen</span></td>
          </tr>`;
      } else {
        content += `
          <tr>
            <td>${nameCol}</td>
            <td>${plzOrt}</td>
            <td>${l.phone || '-'}</td>
            <td>${l.email || '-'}</td>
            ${extraCol}
            <td>${new Date(l.assigned_at).toLocaleDateString('de-DE')}</td>
            <td><span class="badge badge-paid">Neu</span></td>
          </tr>`;
      }
    }
    content += '</tbody></table></div>';
  }

  // Direkte Leads (Legacy)
  if (directLeads.length > 0) {
    content += '<h3 style="margin:24px 0 16px;">Weitere Leads</h3>';
    content += '<table class="data-table"><thead><tr><th>Kategorie</th><th>Name</th><th>E-Mail</th><th>Status</th><th>Aktion</th></tr></thead><tbody>';
    for (const l of directLeads) {
      const statusLabel = l.status === 'active' ? 'Aktiv' : 'Reklamiert';
      content += `
        <tr>
          <td>${l.product_name}</td>
          <td>${l.contact_name || '-'}</td>
          <td>${l.contact_email || '-'}</td>
          <td><span class="badge badge-${l.status}">${statusLabel}</span></td>
          <td>
            ${l.status === 'active' ? `
              <form method="POST" action="/dashboard/leads/${l.id}/reclaim" style="display:inline;">
                <button type="submit" class="btn btn-danger btn-sm" onclick="return confirm('Lead wirklich reklamieren?')">Reklamieren</button>
              </form>
            ` : '<span style="color:var(--gray-500);font-size:0.85rem;">Reklamiert</span>'}
          </td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  renderDashboard(req, res, content, 'leads');
});

router.get('/dashboard/leads/export', requireAuth, (req, res) => {
  const db = getDb();
  const userId = req.session.userId;
  const productId = parseInt(req.query.productId);
  const count = Math.max(1, parseInt(req.query.count) || 1);

  if (!productId) return res.redirect('/dashboard/leads');

  // Nur ungeladene Leads aus bezahlten Bestellungen, FIFO
  const toDownload = db.prepare(`
    SELECT lp.*, pr.name as product_name, la.id as assignment_id, la.assigned_at
    FROM lead_assignments la
    JOIN lead_pool lp ON la.pool_lead_id = lp.id
    JOIN order_items oi ON la.order_item_id = oi.id
    JOIN orders o ON oi.order_id = o.id
    JOIN lead_products pr ON lp.product_id = pr.id
    WHERE la.user_id = ? AND lp.product_id = ?
      AND la.downloaded_at IS NULL
      AND o.status IN ('paid', 'delivered')
    ORDER BY la.assigned_at ASC
    LIMIT ?
  `).all(userId, productId, count);

  if (toDownload.length === 0) return res.redirect('/dashboard/leads');

  // Als heruntergeladen markieren
  const markDone = db.prepare('UPDATE lead_assignments SET downloaded_at = CURRENT_TIMESTAMP WHERE id = ?');
  db.transaction(() => { for (const l of toDownload) markDone.run(l.assignment_id); })();

  function e(val) {
    if (val === null || val === undefined) return '';
    const s = String(val);
    if (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  const leadType = toDownload[0].lead_type;

  // Produktspezifische Zusatzfelder (Liefertemplate) für dieses Produkt mit anhängen
  const deliveryFields = db.prepare(
    'SELECT field_key, field_label FROM product_delivery_fields WHERE product_id = ? ORDER BY sort_order'
  ).all(productId);
  const getAttrs = db.prepare('SELECT field_key, field_value FROM lead_pool_attributes WHERE pool_lead_id = ?');

  const baseHeader = leadType === 'b2b'
    ? ['Firmenname', 'Nachname', 'Straße', 'Hausnummer', 'PLZ', 'Ort', 'Telefon', 'E-Mail', 'Bemerkungen']
    : ['Nachname', 'Vorname', 'Straße', 'Hausnummer', 'PLZ', 'Ort', 'Telefon', 'E-Mail', 'Geburtsdatum', 'Bemerkungen'];
  let csv = [...baseHeader, ...deliveryFields.map(f => f.field_label)].join(';') + '\r\n';

  for (const l of toDownload) {
    const baseRow = leadType === 'b2b'
      ? [e(l.company_name), e(l.contact_lastname), e(l.street), e(l.house_number), e(l.postal_code), e(l.city), e(l.phone), e(l.email), e(l.remarks)]
      : [e(l.contact_lastname), e(l.contact_firstname), e(l.street), e(l.house_number), e(l.postal_code), e(l.city), e(l.phone), e(l.email), e(l.date_of_birth), e(l.remarks)];
    const attrMap = {};
    for (const a of getAttrs.all(l.id)) attrMap[a.field_key] = buyerFacingAttrValue(a.field_key, a.field_value);
    const extraRow = deliveryFields.map(f => e(attrMap[f.field_key] || ''));
    csv += [...baseRow, ...extraRow].join(';') + '\r\n';
  }

  const productName = (toDownload[0].product_name || 'leads').replace(/[^a-zA-Z0-9]/g, '_');
  const date = new Date().toISOString().slice(0, 10);
  const filename = `leads_${productName}_${date}_${toDownload.length}Stk.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv);
});

// Käufer fragt erneuten Zugriff auf einen bereits heruntergeladenen Lead an
// (Sicherheitsregel: 1x Download, danach nur nach manueller Freigabe im Admin-Bereich)
router.post('/dashboard/leads/:assignmentId/request-access', requireAuth, (req, res) => {
  const db = getDb();
  const assignment = db.prepare(`
    SELECT la.*, lp.contact_lastname, lp.contact_firstname, lp.company_name, lp.phone, pr.name as product_name
    FROM lead_assignments la
    JOIN lead_pool lp ON la.pool_lead_id = lp.id
    JOIN lead_products pr ON lp.product_id = pr.id
    WHERE la.id = ? AND la.user_id = ?
  `).get(req.params.assignmentId, req.session.userId);

  if (assignment) {
    const leadDisplay = assignment.company_name || `${assignment.contact_lastname || ''} ${assignment.contact_firstname || ''}`.trim() || '-';
    sendReaccessRequest({
      buyerName: `${req.session.firstName} ${req.session.lastName}`,
      buyerEmail: req.session.email,
      leadDisplay,
      phone: assignment.phone || '-',
      productName: assignment.product_name,
      assignmentId: assignment.id,
    }).catch(err => console.error('[Mailer] Re-Access-Anfrage Fehler:', err.message));
  }

  res.redirect('/dashboard/leads?accessRequested=1');
});

router.post('/dashboard/leads/:id/reclaim', requireAuth, (req, res) => {
  const db = getDb();
  const leadId = req.params.id;
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND user_id = ?').get(leadId, req.session.userId);
  if (!lead || lead.status !== 'active') return res.redirect('/dashboard/leads');

  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run('reclaimed', leadId);
  db.prepare('INSERT INTO reclamations (lead_id, user_id, reason) VALUES (?, ?, ?)').run(leadId, req.session.userId, 'Lead reklamiert durch Nutzer');

  res.redirect('/dashboard/leads');
});

module.exports = router;
