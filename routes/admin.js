const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { getDb } = require('../database');
const { requireAdmin } = require('../middleware/auth');
const { assignLeadsToItem } = require('../lib/deliverLeads');
const { markOrderPaid } = require('../lib/orderPayment');

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'public', 'uploads', 'voicefiles'),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Partner-Passwort-Policy: strenger als die Käufer-Registrierung
// (routes/auth.js, min. 6 Zeichen) - mind. 10 Zeichen, Groß-/Kleinbuchstabe
// und Sonderzeichen, auf Wunsch von Jens/Frank (2026-10-21). Zeichensätze
// bewusst ohne verwechselbare Zeichen (0/O, 1/l/I), da das Passwort als
// Zufallswert ohne eigene Eingabe des Partners vergeben wird.
function generatePartnerPassword(length = 12) {
  const crypto = require('crypto');
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const digits = '23456789';
  const special = '!@#$%&*?';
  const all = lower + upper + digits + special;
  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const chars = [pick(lower), pick(upper), pick(special), pick(digits)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

router.use(requireAdmin);

// Status-Set für Partner-LeadArea (Stand 2026-10-19, angelehnt an SalesTeam):
// Dublette/Ungültig/Blacklist/Spam fliegen schon vor der Auslieferung an den
// Abnehmer raus, der Rest wird manuell gepflegt (Rückmeldung vom Abnehmer
// kommt vorerst nicht automatisiert rein, siehe [[project-leadarea]]).
const LEAD_STATUS_LABELS = {
  in_pruefung: 'In Prüfung',
  pending: 'In Bearbeitung',
  duplicate: 'Dublette',
  invalid: 'Ungültig',
  blacklist: 'Blacklist',
  spam: 'Spam',
  cancelled: 'Storno',
  approved: 'Genehmigt',
  billed: 'Abgerechnet',
  paid: 'Ausgezahlt',
  compensated: 'Vergütet', // Altwert aus dem früheren Marktplatz-Flow
};

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(';') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function renderAdmin(req, res, content, activeTab) {
  req.app.locals.renderPage(res, 'admin/index.html', {
    pageTitle: 'Admin',
    adminContent: content,
    activeOverview: activeTab === 'overview' ? 'active' : '',
    activeProducts: activeTab === 'products' ? 'active' : '',
    activeOrders: activeTab === 'orders' ? 'active' : '',
    activeUsers: activeTab === 'users' ? 'active' : '',
    activeAdminLeads: activeTab === 'leads' ? 'active' : '',
    activeReclamations: activeTab === 'reclamations' ? 'active' : '',
    activePartners: activeTab === 'partners' ? 'active' : '',
    activePool: activeTab === 'pool' ? 'active' : '',
    activeImport: activeTab === 'import' ? 'active' : '',
    activeAssignments: activeTab === 'assignments' ? 'active' : '',
    activeBlacklist: activeTab === 'blacklist' ? 'active' : '',
    activeWiderruf: activeTab === 'widerruf' ? 'active' : '',
    activeProvisionen: activeTab === 'provisionen' ? 'active' : '',
    activeQm: activeTab === 'qm' ? 'active' : '',
  });
}

// OVERVIEW
router.get('/', (req, res) => {
  const db = getDb();

  const totalPool = db.prepare('SELECT COUNT(*) as c FROM lead_pool').get().c;
  const totalAvailable = db.prepare('SELECT COUNT(*) as c FROM lead_pool WHERE current_assignments < max_assignments').get().c;
  const totalAssigned = db.prepare('SELECT COUNT(*) as c FROM lead_assignments').get().c;
  const totalDuplicates = db.prepare('SELECT COALESCE(SUM(duplicates_skipped), 0) as c FROM lead_imports').get().c;
  const revenue = db.prepare('SELECT COALESCE(SUM(total), 0) as t FROM orders WHERE status IN (?, ?)').get('paid', 'delivered').t;
  const openReclamations = db.prepare('SELECT COUNT(*) as c FROM reclamations WHERE status = ?').get('open').c;

  const recentImports = db.prepare(`
    SELECT li.*, lp.name as product_name, lp.lead_type, lc.name as category_name
    FROM lead_imports li
    JOIN lead_products lp ON li.product_id = lp.id
    JOIN lead_categories lc ON lp.category_id = lc.id
    ORDER BY li.imported_at DESC
    LIMIT 10
  `).all();

  const poolByProduct = db.prepare(`
    SELECT lp.lead_type, pr.name as product_name, lc.name as category_name,
      COUNT(*) as total,
      SUM(CASE WHEN lp.current_assignments < lp.max_assignments THEN 1 ELSE 0 END) as available,
      SUM(lp.current_assignments) as assigned
    FROM lead_pool lp
    JOIN lead_products pr ON lp.product_id = pr.id
    JOIN lead_categories lc ON pr.category_id = lc.id
    GROUP BY lp.product_id, lp.lead_type
    ORDER BY lc.sort_order, pr.name
  `).all();

  const customers = db.prepare(`
    SELECT u.id, u.first_name, u.last_name, u.email,
      (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.user_id = u.id AND o.status IN ('paid', 'delivered')) as total_ordered,
      (SELECT COUNT(*) FROM lead_assignments la WHERE la.user_id = u.id) as total_assigned
    FROM users u
    WHERE u.role = 'user'
    AND (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status IN ('paid', 'delivered')) > 0
    ORDER BY u.last_name, u.first_name
  `).all();

  let content = `
    <h2 style="font-size:1.5rem;margin-bottom:24px;">Dashboard</h2>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-number">${totalPool}</div><div class="stat-label">Leads im Pool</div></div>
      <div class="stat-card" style="border-left-color:var(--success);"><div class="stat-number">${totalAvailable}</div><div class="stat-label">Verfügbar</div></div>
      <div class="stat-card" style="border-left-color:var(--accent);"><div class="stat-number">${totalAssigned}</div><div class="stat-label">Zugewiesen</div></div>
      <div class="stat-card" style="border-left-color:var(--warning);"><div class="stat-number">${totalDuplicates}</div><div class="stat-label">Dubletten abgewiesen</div></div>
    </div>
    <div class="stats-grid" style="margin-top:0;">
      <div class="stat-card" style="border-left-color:var(--success);"><div class="stat-number">${revenue.toFixed(2).replace('.', ',')} €</div><div class="stat-label">Umsatz</div></div>
      <div class="stat-card" style="border-left-color:var(--error);"><div class="stat-number">${openReclamations}</div><div class="stat-label">Offene Reklamationen</div></div>
    </div>`;

  // Letzte Imports
  content += '<h3 style="margin:32px 0 16px;">Letzte Einlieferungen</h3>';
  if (recentImports.length === 0) {
    content += '<p style="color:var(--gray-500);">Noch keine Imports.</p>';
  } else {
    content += `
      <table class="data-table">
        <thead><tr><th>Datum</th><th>Partner</th><th>Branche</th><th>Typ</th><th>Importiert</th><th>Dubletten</th><th>Nicht DE</th></tr></thead>
        <tbody>`;
    for (const i of recentImports) {
      content += `
        <tr>
          <td>${new Date(i.imported_at).toLocaleString('de-DE')}</td>
          <td><strong>${i.supplier_name || '-'}</strong></td>
          <td>${i.product_name}</td>
          <td><span class="badge ${i.lead_type === 'b2b' ? 'badge-paid' : 'badge-delivered'}">${i.lead_type === 'b2b' ? 'B2B' : 'B2C'}</span></td>
          <td><strong>${i.lead_count}</strong></td>
          <td style="color:${i.duplicates_skipped > 0 ? 'var(--warning)' : 'var(--gray-500)'};">${i.duplicates_skipped}</td>
          <td style="color:${(i.invalid_plz_skipped || 0) > 0 ? 'var(--error)' : 'var(--gray-500)'};">${i.invalid_plz_skipped || 0}</td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  // Pool nach Branche
  content += '<h3 style="margin:32px 0 16px;">Pool nach Branche</h3>';
  if (poolByProduct.length === 0) {
    content += '<p style="color:var(--gray-500);">Pool ist leer.</p>';
  } else {
    content += `
      <table class="data-table">
        <thead><tr><th>Branche</th><th>Typ</th><th>Im Pool</th><th>Verfügbar</th><th>Zuweisungen</th></tr></thead>
        <tbody>`;
    for (const p of poolByProduct) {
      content += `
        <tr>
          <td>${p.product_name}</td>
          <td><span class="badge ${p.lead_type === 'b2b' ? 'badge-paid' : 'badge-delivered'}">${p.lead_type === 'b2b' ? 'B2B' : 'B2C'}</span></td>
          <td>${p.total}</td>
          <td style="color:var(--success);font-weight:700;">${p.available}</td>
          <td>${p.assigned}</td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  // Partner-Übersicht
  const supplierStats = db.prepare(`
    SELECT li.supplier_name,
      lp.name as product_name, lp.lead_type,
      SUM(li.lead_count) as total_imported,
      SUM(li.duplicates_skipped) as total_duplicates,
      COUNT(li.id) as import_count,
      MAX(li.imported_at) as last_import
    FROM lead_imports li
    JOIN lead_products lp ON li.product_id = lp.id
    WHERE li.supplier_name IS NOT NULL
    GROUP BY li.supplier_name, li.product_id
    ORDER BY li.supplier_name, lp.name
  `).all();

  content += '<h3 style="margin:32px 0 16px;">Partner / Lieferanten</h3>';
  if (supplierStats.length === 0) {
    content += '<p style="color:var(--gray-500);">Noch keine Partner-Daten.</p>';
  } else {
    let currentSupplier = '';
    content += '<table class="data-table"><thead><tr><th>Partner</th><th>Branche</th><th>Typ</th><th>Imports</th><th>Leads gesamt</th><th>Dubletten</th><th>Letzter Import</th></tr></thead><tbody>';
    for (const s of supplierStats) {
      const showName = s.supplier_name !== currentSupplier;
      currentSupplier = s.supplier_name;
      content += `
        <tr>
          <td>${showName ? '<strong>' + s.supplier_name + '</strong>' : ''}</td>
          <td>${s.product_name}</td>
          <td><span class="badge ${s.lead_type === 'b2b' ? 'badge-paid' : 'badge-delivered'}">${s.lead_type === 'b2b' ? 'B2B' : 'B2C'}</span></td>
          <td>${s.import_count}</td>
          <td><strong>${s.total_imported}</strong></td>
          <td style="color:${s.total_duplicates > 0 ? 'var(--warning)' : 'var(--gray-500)'};">${s.total_duplicates}</td>
          <td>${new Date(s.last_import).toLocaleDateString('de-DE')}</td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  // Kunden-Übersicht
  content += '<h3 style="margin:32px 0 16px;">Kunden</h3>';
  if (customers.length === 0) {
    content += '<p style="color:var(--gray-500);">Noch keine Kunden mit Bestellungen.</p>';
  } else {
    content += `
      <table class="data-table">
        <thead><tr><th>Kunde</th><th>E-Mail</th><th>Bestellt</th><th>Geliefert</th><th>Offen</th></tr></thead>
        <tbody>`;
    for (const c of customers) {
      const remaining = Math.max(0, c.total_ordered - c.total_assigned);
      content += `
        <tr>
          <td><strong>${c.first_name} ${c.last_name}</strong></td>
          <td>${c.email}</td>
          <td>${c.total_ordered}</td>
          <td>${c.total_assigned}</td>
          <td style="color:${remaining > 0 ? 'var(--warning)' : 'var(--success)'};font-weight:700;">${remaining}</td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  renderAdmin(req, res, content, 'overview');
});

// PRODUCTS
router.get('/products', (req, res) => {
  const db = getDb();
  const products = db.prepare(`
    SELECT lp.*, lc.name as category_name FROM lead_products lp
    JOIN lead_categories lc ON lp.category_id = lc.id
    ORDER BY lc.sort_order, lp.name
  `).all();
  const categories = db.prepare('SELECT * FROM lead_categories ORDER BY sort_order').all();

  let catOptions = categories.map(c => `<option value="${c.id}">${c.name}</option>`).join('');

  let content = `
    <div class="admin-header">
      <h2>Lead-Produkte</h2>
      <button class="btn btn-primary btn-sm" onclick="document.getElementById('addProductModal').classList.add('active')">+ Neues Produkt</button>
    </div>
    <table class="data-table">
      <thead><tr><th>Name</th><th>Kategorie</th><th>Preis (Frisch / 2. Nutzung / 3. Nutzung / Exklusiv)</th><th>Status</th><th>Aktionen</th></tr></thead>
      <tbody>`;

  for (const p of products) {
    content += `
      <tr>
        <td>${p.name}</td>
        <td>${p.category_name}</td>
        <td>
          <form method="POST" action="/admin/products/${p.id}/price" style="display:flex;gap:4px;align-items:center;">
            <input type="number" name="price" step="0.01" min="0.01" value="${p.price > 0 ? p.price.toFixed(2) : ''}" placeholder="Frisch" title="Frisch" style="width:80px;padding:4px;border-radius:6px;border:1px solid var(--gray-300);">
            <input type="number" name="price_tier2" step="0.01" min="0" value="${p.price_tier2 > 0 ? p.price_tier2.toFixed(2) : ''}" placeholder="2. Nutzung" title="2. Nutzung" style="width:80px;padding:4px;border-radius:6px;border:1px solid var(--gray-300);">
            <input type="number" name="price_tier3" step="0.01" min="0" value="${p.price_tier3 > 0 ? p.price_tier3.toFixed(2) : ''}" placeholder="3. Nutzung" title="3. Nutzung" style="width:80px;padding:4px;border-radius:6px;border:1px solid var(--gray-300);">
            <input type="number" name="price_exclusive" step="0.01" min="0" value="${p.price_exclusive > 0 ? p.price_exclusive.toFixed(2) : ''}" placeholder="Exklusiv" title="Exklusiv" style="width:80px;padding:4px;border-radius:6px;border:1px solid var(--gray-300);">
            <button type="submit" class="btn btn-outline btn-sm">Speichern</button>
          </form>
        </td>
        <td><span class="badge ${p.active ? 'badge-active' : 'badge-cancelled'}">${p.active ? 'Aktiv' : 'Inaktiv'}</span></td>
        <td>
          <form method="POST" action="/admin/products/${p.id}/toggle" style="display:inline;">
            <button type="submit" class="btn btn-outline btn-sm">${p.active ? 'Deaktivieren' : 'Aktivieren'}</button>
          </form>
        </td>
      </tr>`;
  }

  content += `</tbody></table>

    <div class="modal-overlay" id="addProductModal">
      <div class="modal">
        <h3>Neues Lead-Produkt</h3>
        <form method="POST" action="/admin/products">
          <div class="form-group">
            <label>Kategorie *</label>
            <select name="category_id" required>${catOptions}</select>
          </div>
          <div class="form-group"><label>Name *</label><input type="text" name="name" required></div>
          <div class="form-group"><label>Beschreibung</label><textarea name="description"></textarea></div>
          <div class="form-group"><label>Preis Frisch (€) *</label><input type="number" name="price" step="0.01" min="0.01" required></div>
          <div class="form-group"><label>Preis 2. Nutzung (€, optional)</label><input type="number" name="price_tier2" step="0.01" min="0"></div>
          <div class="form-group"><label>Preis 3. Nutzung (€, optional)</label><input type="number" name="price_tier3" step="0.01" min="0"></div>
          <div class="form-group"><label>Preis Exklusiv (€, optional)</label><input type="number" name="price_exclusive" step="0.01" min="0"></div>
          <div class="modal-actions">
            <button type="button" class="btn btn-outline btn-sm" onclick="this.closest('.modal-overlay').classList.remove('active')">Abbrechen</button>
            <button type="submit" class="btn btn-primary btn-sm">Erstellen</button>
          </div>
        </form>
      </div>
    </div>`;

  renderAdmin(req, res, content, 'products');
});

// Prüft, dass die Preisstufen absteigend sind (0 = Stufe nicht gesetzt, kein Verstoß)
function tierPricesValid(price, tier2, tier3) {
  if (tier2 > 0 && tier2 >= price) return false;
  if (tier3 > 0 && tier3 >= (tier2 > 0 ? tier2 : price)) return false;
  return true;
}

router.post('/products', (req, res) => {
  const { category_id, name, description, price } = req.body;
  const tier2 = parseFloat(req.body.price_tier2) || 0;
  const tier3 = parseFloat(req.body.price_tier3) || 0;
  const exclusive = parseFloat(req.body.price_exclusive) || 0;
  if (!tierPricesValid(parseFloat(price), tier2, tier3)) return res.redirect('/admin/products');
  const db = getDb();
  db.prepare('INSERT INTO lead_products (category_id, name, description, price, price_tier2, price_tier3, price_exclusive) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(category_id, name, description || null, parseFloat(price), tier2, tier3, exclusive);
  res.redirect('/admin/products');
});

router.post('/products/:id/price', (req, res) => {
  const price = parseFloat(req.body.price);
  const tier2 = parseFloat(req.body.price_tier2) || 0;
  const tier3 = parseFloat(req.body.price_tier3) || 0;
  const exclusive = parseFloat(req.body.price_exclusive) || 0;
  if (!isNaN(price) && price > 0 && tierPricesValid(price, tier2, tier3)) {
    const db = getDb();
    db.prepare('UPDATE lead_products SET price = ?, price_tier2 = ?, price_tier3 = ?, price_exclusive = ? WHERE id = ?').run(price, tier2, tier3, exclusive, req.params.id);
  }
  res.redirect('/admin/products');
});

router.post('/products/:id/toggle', (req, res) => {
  const db = getDb();
  const product = db.prepare('SELECT active FROM lead_products WHERE id = ?').get(req.params.id);
  if (product) {
    db.prepare('UPDATE lead_products SET active = ? WHERE id = ?').run(product.active ? 0 : 1, req.params.id);
  }
  res.redirect('/admin/products');
});

// ORDERS
router.get('/orders', (req, res) => {
  const db = getDb();
  const orders = db.prepare(`
    SELECT o.*, u.first_name, u.last_name, u.email FROM orders o
    JOIN users u ON o.user_id = u.id ORDER BY o.created_at DESC
  `).all();

  let content = '<h2 style="font-size:1.5rem;margin-bottom:24px;">Bestellungen</h2>';
  content += '<table class="data-table"><thead><tr><th>#</th><th>Kunde</th><th>Datum</th><th>Gesamt</th><th>Status</th><th>Aktionen</th></tr></thead><tbody>';

  for (const o of orders) {
    const statusLabel = { pending: 'Ausstehend', paid: 'Bezahlt', delivered: 'Geliefert', cancelled: 'Storniert' }[o.status] || o.status;
    content += `
      <tr>
        <td>${o.id}</td>
        <td>${o.first_name} ${o.last_name}<br><small style="color:var(--gray-500)">${o.email}</small></td>
        <td>${new Date(o.created_at).toLocaleDateString('de-DE')}</td>
        <td>${o.total.toFixed(2).replace('.', ',')} €</td>
        <td><span class="badge badge-${o.status}">${statusLabel}</span></td>
        <td>
          <form method="POST" action="/admin/orders/${o.id}/status" style="display:flex;gap:4px;">
            <select name="status" style="padding:6px;border-radius:6px;border:1px solid var(--gray-300);font-size:0.8rem;">
              <option value="pending" ${o.status === 'pending' ? 'selected' : ''}>Ausstehend</option>
              <option value="paid" ${o.status === 'paid' ? 'selected' : ''}>Bezahlt</option>
              <option value="delivered" ${o.status === 'delivered' ? 'selected' : ''}>Geliefert</option>
              <option value="cancelled" ${o.status === 'cancelled' ? 'selected' : ''}>Storniert</option>
            </select>
            <button type="submit" class="btn btn-outline btn-sm">Ändern</button>
          </form>
        </td>
      </tr>`;
  }
  content += '</tbody></table>';

  renderAdmin(req, res, content, 'orders');
});

router.post('/orders/:id/status', (req, res) => {
  const db = getDb();
  const validStatuses = ['pending', 'paid', 'delivered', 'cancelled'];
  if (validStatuses.includes(req.body.status)) {
    if (req.body.status === 'paid') {
      // Nutzt dieselbe Logik wie eine Online-Zahlung: löst Leadproduktion/
      // -zuweisung aus und verschickt die Zahlungseingang-Bestätigung an den
      // Käufer. Greift nur, wenn die Bestellung noch 'pending' ist (keine
      // Doppelauslieferung bei versehentlichem erneutem Klick).
      markOrderPaid(req.params.id);
    } else {
      db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
    }
  }
  res.redirect('/admin/orders');
});

// USERS
router.get('/users', (req, res) => {
  const db = getDb();
  const users = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();

  let content = '<h2 style="font-size:1.5rem;margin-bottom:24px;">Nutzer</h2>';
  content += '<table class="data-table"><thead><tr><th>ID</th><th>Name</th><th>E-Mail</th><th>Telefon</th><th>Rolle</th><th>Registriert</th></tr></thead><tbody>';

  for (const u of users) {
    content += `
      <tr>
        <td>${u.id}</td>
        <td>${u.first_name} ${u.last_name}</td>
        <td>${u.email}</td>
        <td>${u.phone || '-'}</td>
        <td><span class="badge ${u.role === 'admin' ? 'badge-delivered' : 'badge-paid'}">${u.role}</span></td>
        <td>${new Date(u.created_at).toLocaleDateString('de-DE')}</td>
      </tr>`;
  }
  content += '</tbody></table>';

  renderAdmin(req, res, content, 'users');
});

// LEADS MANAGEMENT
router.get('/leads', (req, res) => {
  const db = getDb();
  const orders = db.prepare(`
    SELECT o.id, o.user_id, o.status as order_status, u.first_name, u.last_name,
    (SELECT COUNT(*) FROM leads WHERE leads.user_id = o.user_id AND leads.order_item_id IN
      (SELECT oi.id FROM order_items oi WHERE oi.order_id = o.id)) as delivered_count,
    (SELECT SUM(oi.quantity) FROM order_items oi WHERE oi.order_id = o.id) as ordered_count
    FROM orders o JOIN users u ON o.user_id = u.id
    WHERE o.status IN ('paid', 'delivered')
    ORDER BY o.created_at DESC
  `).all();

  let content = `<h2 style="font-size:1.5rem;margin-bottom:24px;">Leads verwalten</h2>
    <p style="color:var(--gray-500);margin-bottom:24px;">Weise bezahlten Bestellungen Leads zu.</p>
    <table class="data-table"><thead><tr><th>Bestellung</th><th>Kunde</th><th>Bestellt</th><th>Geliefert</th><th>Aktion</th></tr></thead><tbody>`;

  for (const o of orders) {
    content += `
      <tr>
        <td>#${o.id}</td>
        <td>${o.first_name} ${o.last_name}</td>
        <td>${o.ordered_count || 0}</td>
        <td>${o.delivered_count || 0}</td>
        <td><a href="/admin/leads/${o.id}" class="btn btn-primary btn-sm">Leads zuweisen</a></td>
      </tr>`;
  }
  content += '</tbody></table>';

  renderAdmin(req, res, content, 'leads');
});

router.get('/leads/:orderId', (req, res) => {
  const db = getDb();
  const order = db.prepare('SELECT o.*, u.first_name, u.last_name FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id = ?').get(req.params.orderId);
  if (!order) return res.redirect('/admin/leads');

  const items = db.prepare(`
    SELECT oi.*, lp.name as product_name FROM order_items oi
    JOIN lead_products lp ON oi.product_id = lp.id WHERE oi.order_id = ?
  `).all(order.id);

  const existingLeads = db.prepare('SELECT * FROM leads WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id = ?)').all(order.id);

  let content = `
    <h2 style="font-size:1.5rem;margin-bottom:8px;">Leads für Bestellung #${order.id}</h2>
    <p style="color:var(--gray-500);margin-bottom:24px;">Kunde: ${order.first_name} ${order.last_name}</p>`;

  for (const item of items) {
    const itemLeads = existingLeads.filter(l => l.order_item_id === item.id);
    const remaining = item.quantity - itemLeads.length;

    content += `
      <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:20px;box-shadow:var(--shadow-sm);">
        <h3 style="margin-bottom:8px;">${item.product_name}</h3>
        <p style="color:var(--gray-500);margin-bottom:16px;">${item.quantity} bestellt, ${itemLeads.length} geliefert, ${remaining} offen</p>`;

    if (remaining > 0) {
      content += `
        <form method="POST" action="/admin/leads/${order.id}/add">
          <input type="hidden" name="order_item_id" value="${item.id}">
          <input type="hidden" name="user_id" value="${order.user_id}">
          <div class="form-row">
            <div class="form-group"><label>Name</label><input type="text" name="contact_name" required></div>
            <div class="form-group"><label>E-Mail</label><input type="email" name="contact_email"></div>
          </div>
          <div class="form-row">
            <div class="form-group"><label>Telefon</label><input type="text" name="contact_phone"></div>
            <div class="form-group"><label>Zusatzinfo</label><input type="text" name="contact_info"></div>
          </div>
          <button type="submit" class="btn btn-primary btn-sm">Lead hinzufügen</button>
        </form>`;
    }

    if (itemLeads.length > 0) {
      content += '<table class="data-table" style="margin-top:16px;"><thead><tr><th>Name</th><th>E-Mail</th><th>Telefon</th><th>Status</th></tr></thead><tbody>';
      for (const lead of itemLeads) {
        content += `<tr><td>${lead.contact_name || '-'}</td><td>${lead.contact_email || '-'}</td><td>${lead.contact_phone || '-'}</td><td><span class="badge badge-${lead.status}">${lead.status === 'active' ? 'Aktiv' : 'Reklamiert'}</span></td></tr>`;
      }
      content += '</tbody></table>';
    }

    content += '</div>';
  }

  content += `<a href="/admin/leads" class="btn btn-outline">Zurück</a>`;
  renderAdmin(req, res, content, 'leads');
});

router.post('/leads/:orderId/add', (req, res) => {
  const { order_item_id, user_id, contact_name, contact_email, contact_phone, contact_info } = req.body;
  const db = getDb();
  db.prepare(`
    INSERT INTO leads (order_item_id, user_id, contact_name, contact_email, contact_phone, contact_info)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(order_item_id, user_id, contact_name, contact_email || null, contact_phone || null, contact_info || null);
  res.redirect(`/admin/leads/${req.params.orderId}`);
});

// RECLAMATIONS
router.get('/reclamations', (req, res) => {
  const db = getDb();
  const reclamations = db.prepare(`
    SELECT r.*, u.first_name, u.last_name, u.email,
    l.contact_name, l.contact_email, l.contact_phone
    FROM reclamations r
    JOIN users u ON r.user_id = u.id
    JOIN leads l ON r.lead_id = l.id
    ORDER BY r.created_at DESC
  `).all();

  let content = '<h2 style="font-size:1.5rem;margin-bottom:24px;">Reklamationen</h2>';
  content += '<table class="data-table"><thead><tr><th>#</th><th>Nutzer</th><th>Lead</th><th>Grund</th><th>Status</th><th>Aktion</th></tr></thead><tbody>';

  for (const r of reclamations) {
    const statusLabel = { open: 'Offen', approved: 'Genehmigt', rejected: 'Abgelehnt' }[r.status] || r.status;
    content += `
      <tr>
        <td>${r.id}</td>
        <td>${r.first_name} ${r.last_name}</td>
        <td>${r.contact_name || r.contact_email || '-'}</td>
        <td>${r.reason}</td>
        <td><span class="badge badge-${r.status}">${statusLabel}</span></td>
        <td>
          ${r.status === 'open' ? `
            <form method="POST" action="/admin/reclamations/${r.id}" style="display:flex;gap:4px;">
              <button type="submit" name="action" value="approve" class="btn btn-primary btn-sm">Genehmigen</button>
              <button type="submit" name="action" value="reject" class="btn btn-danger btn-sm">Ablehnen</button>
            </form>
          ` : `<span style="color:var(--gray-500);font-size:0.85rem;">${statusLabel}</span>`}
        </td>
      </tr>`;
  }
  content += '</tbody></table>';

  renderAdmin(req, res, content, 'reclamations');
});

router.post('/reclamations/:id', (req, res) => {
  const db = getDb();
  const status = req.body.action === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE reclamations SET status = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, req.params.id);
  res.redirect('/admin/reclamations');
});

// PARTNERS
router.get('/partners', (req, res) => {
  const db = getDb();
  const applications = db.prepare('SELECT * FROM partner_applications ORDER BY created_at DESC').all();
  const projectsByApplication = {};
  for (const row of db.prepare(`
    SELECT pap.application_id, lp.name FROM partner_application_projects pap
    JOIN lead_products lp ON lp.id = pap.product_id
  `).all()) {
    if (!projectsByApplication[row.application_id]) projectsByApplication[row.application_id] = [];
    projectsByApplication[row.application_id].push(row.name);
  }

  let content = '<h2 style="font-size:1.5rem;margin-bottom:24px;">Partner-Bewerbungen</h2>';
  const countryNames = { DE:'Deutschland', TR:'Türkei', GR:'Griechenland', XK:'Kosovo', RS:'Serbien', BA:'Bosnien-Herz.', HR:'Kroatien', ME:'Montenegro', MK:'Nordmazedonien', AL:'Albanien', BG:'Bulgarien', RO:'Rumänien', HU:'Ungarn', PL:'Polen', CZ:'Tschechien', SK:'Slowakei', SI:'Slowenien', UA:'Ukraine', RU:'Russland', MD:'Moldau' };
  content += '<table class="data-table"><thead><tr><th>Name</th><th>Firma</th><th>Land</th><th>E-Mail</th><th>Telefon</th><th>Projekte</th><th>Terminwunsch</th><th>Status</th><th>Aktion</th></tr></thead><tbody>';

  for (const a of applications) {
    const statusLabel = { new: 'Neu', contacted: 'Kontaktiert', accepted: 'Angenommen', rejected: 'Abgelehnt' }[a.status] || a.status;
    const partnerUser = a.status === 'accepted' ? db.prepare("SELECT id FROM users WHERE email = ? AND role = 'partner'").get(a.email) : null;
    content += `
      <tr>
        <td>${a.first_name} ${a.last_name}</td>
        <td>${a.company || '-'}</td>
        <td>${countryNames[a.country] || a.country || '-'}</td>
        <td>${a.email}</td>
        <td>${a.phone || '-'}</td>
        <td>${(projectsByApplication[a.id] || []).join(', ') || '-'}</td>
        <td>${a.appointment_request || '-'}</td>
        <td><span class="badge badge-${a.status}">${statusLabel}</span></td>
        <td>
          <form method="POST" action="/admin/partners/${a.id}" style="display:flex;gap:4px;margin-bottom:6px;">
            <select name="status" style="padding:6px;border-radius:6px;border:1px solid var(--gray-300);font-size:0.8rem;">
              <option value="new" ${a.status === 'new' ? 'selected' : ''}>Neu</option>
              <option value="contacted" ${a.status === 'contacted' ? 'selected' : ''}>Kontaktiert</option>
              <option value="accepted" ${a.status === 'accepted' ? 'selected' : ''}>Angenommen</option>
              <option value="rejected" ${a.status === 'rejected' ? 'selected' : ''}>Abgelehnt</option>
            </select>
            <button type="submit" class="btn btn-outline btn-sm">Ändern</button>
          </form>
          ${partnerUser ? `<a href="/admin/partners/manage/${partnerUser.id}" class="btn btn-primary btn-sm">Vertrag/Projekte verwalten</a>` : ''}
        </td>
      </tr>`;
  }
  content += '</tbody></table>';

  renderAdmin(req, res, content, 'partners');
});

router.post('/partners/:id', (req, res) => {
  const db = getDb();
  const bcrypt = require('bcrypt');
  const validStatuses = ['new', 'contacted', 'accepted', 'rejected'];
  const newStatus = req.body.status;
  if (!validStatuses.includes(newStatus)) return res.redirect('/admin/partners');

  const application = db.prepare('SELECT * FROM partner_applications WHERE id = ?').get(req.params.id);
  if (!application) return res.redirect('/admin/partners');

  db.prepare('UPDATE partner_applications SET status = ? WHERE id = ?').run(newStatus, req.params.id);

  if (newStatus === 'accepted' && application.status !== 'accepted') {
    const crypto = require('crypto');
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(application.email);
    if (!existing) {
      const tempPassword = generatePartnerPassword();
      const hash = bcrypt.hashSync(tempPassword, 10);
      const apiKey = 'lp_' + crypto.randomBytes(24).toString('hex');
      db.prepare(`
        INSERT INTO users (email, password_hash, first_name, last_name, phone, country, role, api_key)
        VALUES (?, ?, ?, ?, ?, ?, 'partner', ?)
      `).run(application.email, hash, application.first_name, application.last_name, application.phone || null, application.country || null, apiKey);
      console.log(`Partner-Account erstellt: ${application.email} / ${tempPassword} / API-Key: ${apiKey}`);
    }
  }

  res.redirect('/admin/partners');
});

// PARTNER - Vertragsstatus + Projekt-Freigabe verwalten. Templates/Upload
// bleiben im Partner-Dashboard gesperrt, bis beides hier gesetzt ist
// (siehe routes/partner.js getContractStatus/getApprovedProducts).
router.get('/partners/manage/:userId', (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'partner'").get(req.params.userId);
  if (!user) return res.redirect('/admin/partners');

  const products = db.prepare(`
    SELECT lp.*, lc.name as category_name FROM lead_products lp
    JOIN lead_categories lc ON lp.category_id = lc.id
    WHERE lp.active = 1
    ORDER BY lc.sort_order, lp.name
  `).all();
  const approvedIds = new Set(db.prepare('SELECT product_id FROM partner_approved_products WHERE user_id = ?').all(user.id).map(r => r.product_id));

  const content = `
    <h2 style="font-size:1.5rem;margin-bottom:8px;">Partner verwalten: ${user.first_name} ${user.last_name}</h2>
    <p style="color:var(--gray-500);margin-bottom:24px;">${user.email}</p>

    <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:24px;box-shadow:var(--shadow-sm);">
      <h3 style="margin-bottom:16px;">Vertragsstatus</h3>
      ${user.contract_signed_at
        ? `<p style="color:var(--success);font-weight:700;margin-bottom:12px;">Vertrag unterschrieben am ${user.contract_signed_at}</p>
           <form method="POST" action="/admin/partners/manage/${user.id}/contract"><input type="hidden" name="action" value="clear"><button type="submit" class="btn btn-outline btn-sm">Zurücksetzen (z.B. bei Irrtum)</button></form>`
        : `<p style="color:var(--warning);font-weight:700;margin-bottom:12px;">Noch nicht als unterschrieben markiert - Partner sieht noch keine Liefertemplates/Upload.</p>
           <form method="POST" action="/admin/partners/manage/${user.id}/contract"><input type="hidden" name="action" value="sign"><button type="submit" class="btn btn-primary">Vertrag jetzt als unterschrieben markieren</button></form>`
      }
    </div>

    <div style="background:var(--white);border-radius:var(--radius);padding:24px;box-shadow:var(--shadow-sm);">
      <h3 style="margin-bottom:16px;">Freigegebene Projekte</h3>
      <p style="color:var(--gray-500);margin-bottom:16px;font-size:0.9rem;">Nur hier angehakte Projekte erscheinen im Partner-Dashboard (Liefertemplate + Upload-Auswahl) - unabhängig davon, was bei der Bewerbung gewünscht wurde.</p>
      <form method="POST" action="/admin/partners/manage/${user.id}/projects">
        ${products.map(p => `
          <label style="display:block;margin-bottom:8px;">
            <input type="checkbox" name="product_ids" value="${p.id}" ${approvedIds.has(p.id) ? 'checked' : ''}>
            ${p.category_name} &rarr; ${p.name}
          </label>`).join('')}
        <button type="submit" class="btn btn-primary" style="margin-top:12px;">Freigaben speichern</button>
      </form>
    </div>`;

  renderAdmin(req, res, content, 'partners');
});

router.post('/partners/manage/:userId/contract', (req, res) => {
  const db = getDb();
  if (req.body.action === 'sign') {
    db.prepare("UPDATE users SET contract_signed_at = datetime('now') WHERE id = ? AND role = 'partner'").run(req.params.userId);
  } else {
    db.prepare("UPDATE users SET contract_signed_at = NULL WHERE id = ? AND role = 'partner'").run(req.params.userId);
  }
  res.redirect(`/admin/partners/manage/${req.params.userId}`);
});

router.post('/partners/manage/:userId/projects', (req, res) => {
  const db = getDb();
  const user = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'partner'").get(req.params.userId);
  if (!user) return res.redirect('/admin/partners');

  const productIds = (Array.isArray(req.body.product_ids) ? req.body.product_ids : (req.body.product_ids ? [req.body.product_ids] : []))
    .map(id => parseInt(id)).filter(Boolean);

  db.prepare('DELETE FROM partner_approved_products WHERE user_id = ?').run(user.id);
  const insert = db.prepare('INSERT INTO partner_approved_products (user_id, product_id) VALUES (?, ?)');
  for (const productId of productIds) insert.run(user.id, productId);

  res.redirect(`/admin/partners/manage/${user.id}`);
});

// LEAD POOL - Overview
router.get('/pool', (req, res) => {
  const db = getDb();
  const stats = db.prepare(`
    SELECT lp.product_id, lp.lead_type, pr.name as product_name, lc.name as category_name,
      COUNT(*) as total,
      SUM(CASE WHEN lp.current_assignments < lp.max_assignments THEN 1 ELSE 0 END) as available,
      SUM(CASE WHEN lp.current_assignments >= lp.max_assignments THEN 1 ELSE 0 END) as exhausted
    FROM lead_pool lp
    JOIN lead_products pr ON lp.product_id = pr.id
    JOIN lead_categories lc ON pr.category_id = lc.id
    GROUP BY lp.product_id, lp.lead_type
    ORDER BY lc.sort_order, pr.name, lp.lead_type
  `).all();

  const totalPool = db.prepare('SELECT COUNT(*) as c FROM lead_pool').get().c;
  const totalAvailable = db.prepare('SELECT COUNT(*) as c FROM lead_pool WHERE current_assignments < max_assignments').get().c;
  const totalAssignments = db.prepare('SELECT COUNT(*) as c FROM lead_assignments').get().c;

  let content = `
    <h2 style="font-size:1.5rem;margin-bottom:24px;">Lead-Pool</h2>
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-number">${totalPool}</div><div class="stat-label">Leads im Pool</div></div>
      <div class="stat-card" style="border-left-color:var(--success);"><div class="stat-number">${totalAvailable}</div><div class="stat-label">Verfügbar</div></div>
      <div class="stat-card" style="border-left-color:var(--accent);"><div class="stat-number">${totalAssignments}</div><div class="stat-label">Zuweisungen gesamt</div></div>
    </div>`;

  if (stats.length === 0) {
    content += `
      <div class="empty-state">
        <div class="empty-icon">📥</div>
        <h3>Noch keine Leads im Pool</h3>
        <p>Importiere Leads über den <a href="/admin/pool/import" style="color:var(--primary);font-weight:700;">Pool-Import</a>.</p>
      </div>`;
  } else {
    content += `
      <table class="data-table" style="margin-top:24px;">
        <thead><tr><th>Kategorie</th><th>Produkt</th><th>Typ</th><th>Gesamt</th><th>Verfügbar</th><th>Ausgeschöpft</th></tr></thead>
        <tbody>`;
    for (const s of stats) {
      content += `
        <tr>
          <td>${s.category_name}</td>
          <td>${s.product_name}</td>
          <td><span class="badge ${s.lead_type === 'b2b' ? 'badge-paid' : 'badge-delivered'}">${s.lead_type === 'b2b' ? 'B2B' : 'B2C'}</span></td>
          <td>${s.total}</td>
          <td style="color:var(--success);font-weight:700;">${s.available}</td>
          <td style="color:var(--gray-500);">${s.exhausted}</td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  renderAdmin(req, res, content, 'pool');
});

// LEAD POOL - Import page
router.get('/pool/import', (req, res) => {
  const db = getDb();
  const products = db.prepare(`
    SELECT lp.*, lc.name as category_name FROM lead_products lp
    JOIN lead_categories lc ON lp.category_id = lc.id
    WHERE lp.active = 1
    ORDER BY lc.sort_order, lp.name
  `).all();

  const imports = db.prepare(`
    SELECT li.*, lp.name as product_name, lp.lead_type, lc.name as category_name
    FROM lead_imports li
    JOIN lead_products lp ON li.product_id = lp.id
    JOIN lead_categories lc ON lp.category_id = lc.id
    ORDER BY li.imported_at DESC
    LIMIT 20
  `).all();

  const partners = db.prepare("SELECT id, first_name, last_name, email FROM users WHERE role = 'partner' ORDER BY last_name").all();
  let partnerOptions = '<option value="">-- Kein Partner zugeordnet --</option>' + partners.map(p => `<option value="${p.id}">${p.first_name} ${p.last_name} (${p.email})</option>`).join('');

  const deliveryFieldsByProduct = {};
  for (const row of db.prepare('SELECT product_id, field_label FROM product_delivery_fields ORDER BY product_id, sort_order').all()) {
    if (!deliveryFieldsByProduct[row.product_id]) deliveryFieldsByProduct[row.product_id] = [];
    deliveryFieldsByProduct[row.product_id].push(row.field_label);
  }
  let productOptions = products.map(p => `<option value="${p.id}" data-leadtype="${p.lead_type}" data-extrafields="${(deliveryFieldsByProduct[p.id] || []).join(';')}">${p.category_name} &rarr; ${p.name} (${p.lead_type === 'b2b' ? 'B2B' : 'B2C'})</option>`).join('');

  let content = `
    <h2 style="font-size:1.5rem;margin-bottom:24px;">Lead-Pool Import</h2>
    <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:24px;box-shadow:var(--shadow-sm);">
      <h3 style="margin-bottom:16px;">CSV-Import</h3>
      <p style="color:var(--gray-500);margin-bottom:16px;font-size:0.9rem;">
        CSV-Format (Semikolon-getrennt, mit oder ohne Kopfzeile):<br>
        <code id="formatInfo">Firmenname;Nachname;Strasse;Hausnummer;PLZ;Ort;Telefon;Email;Bemerkungen;Voicefile-Link</code><br>
        <small>Dublettenprüfung: 1. Telefonnummer, 2. Firmenname (B2B) bzw. Name+Vorname+PLZ (B2C). <strong>Voicefile-Link ist Pflicht</strong> (direkter Link zur gehosteten Audiodatei, kein Upload) - erfolgreiche Zeilen landen in der QM-Warteschlange (/qm), nicht mehr direkt im Pool. Produktspezifische Zusatzspalten (falls vorhanden) werden in exakt der angezeigten Reihenfolge NACH dem Voicefile-Link erwartet.</small>
      </p>
      <form method="POST" action="/admin/pool/import" enctype="multipart/form-data">
        <div class="form-row">
          <div class="form-group">
            <label>Partner / Lieferant *</label>
            <select name="partner_user_id">${partnerOptions}</select>
          </div>
          <div class="form-group">
            <label>Oder Name (manuell)</label>
            <input type="text" name="supplier_name" placeholder="z.B. DMP Callcenter">
          </div>
          <div class="form-group">
            <label>Produkt / Branche *</label>
            <select name="product_id" required id="productSelect" onchange="var o=this.options[this.selectedIndex]; var t=o.getAttribute('data-leadtype'); var base = t==='b2b' ? 'Firmenname;Nachname;Strasse;Hausnummer;PLZ;Ort;Telefon;Email;Bemerkungen;Voicefile-Link' : 'Nachname;Vorname;Strasse;Hausnummer;PLZ;Ort;Telefon;Email;Geburtsdatum;Bemerkungen;Voicefile-Link'; var extra = o.getAttribute('data-extrafields'); document.getElementById('formatInfo').textContent = extra ? base + ';' + extra : base; document.getElementById('typeLabel').textContent = t==='b2b' ? 'B2B' : 'B2C';">
              ${productOptions}
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label>Typ</label>
            <span id="typeLabel" class="badge badge-paid" style="display:inline-block;margin-top:8px;">${products.length > 0 ? (products[0].lead_type === 'b2b' ? 'B2B' : 'B2C') : '-'}</span>
          </div>
          <div class="form-group">
            <label>Max. Zuweisungen</label>
            <input type="number" name="max_assignments" value="3" min="1" max="3" style="width:80px;">
          </div>
          <div class="form-group">
            <label>CSV-Datei *</label>
            <input type="file" name="csvfile" accept=".csv,.txt" required>
          </div>
        </div>
        <hr style="margin:20px 0;border:none;border-top:1px solid var(--gray-200);">
        <p style="font-size:0.85rem;color:var(--gray-500);margin-bottom:12px;"><strong>Einwilligungsnachweis (DSGVO)</strong> — für den Beschwerdefall</p>
        <div class="form-row">
          <div class="form-group" style="flex:2;">
            <label>Landingpage / Quelle der Einwilligung</label>
            <input type="url" name="consent_url" placeholder="https://example.de/solar-anfrage">
          </div>
        </div>
        <div class="form-group">
          <label>Einwilligungstext (wie auf der Landingpage)</label>
          <textarea name="consent_text" rows="3" placeholder="Ich bin damit einverstanden, dass meine Daten weitergegeben werden und mich bis zu 3 Spezialisten kontaktieren ..."></textarea>
        </div>
        <button type="submit" class="btn btn-primary">Importieren</button>
      </form>
    </div>

    <h3 style="margin-bottom:16px;">Import-Historie</h3>`;

  if (imports.length === 0) {
    content += '<p style="color:var(--gray-500);">Noch keine Imports durchgeführt.</p>';
  } else {
    content += `
      <table class="data-table">
        <thead><tr><th>Datum</th><th>Partner</th><th>Branche</th><th>Typ</th><th>Datei</th><th>Importiert</th><th>Dubletten</th><th>Nicht DE</th><th>Aktion</th></tr></thead>
        <tbody>`;
    for (const i of imports) {
      content += `
        <tr>
          <td>${new Date(i.imported_at).toLocaleString('de-DE')}</td>
          <td><strong>${i.supplier_name || '-'}</strong></td>
          <td>${i.product_name}</td>
          <td><span class="badge ${i.lead_type === 'b2b' ? 'badge-paid' : 'badge-delivered'}">${i.lead_type === 'b2b' ? 'B2B' : 'B2C'}</span></td>
          <td style="font-size:0.8rem;">${i.filename || '-'}</td>
          <td><strong>${i.lead_count}</strong></td>
          <td style="color:${i.duplicates_skipped > 0 ? 'var(--warning)' : 'var(--gray-500)'};">${i.duplicates_skipped || 0}</td>
          <td style="color:${(i.invalid_plz_skipped || 0) > 0 ? 'var(--error)' : 'var(--gray-500)'};">${i.invalid_plz_skipped || 0}</td>
          <td><a href="/admin/pool/import/${i.id}" class="btn btn-outline btn-sm">Ansehen</a></td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  renderAdmin(req, res, content, 'import');
});

// LEAD POOL - Import detail (list of leads)
router.get('/pool/import/:importId', (req, res) => {
  const db = getDb();
  const imp = db.prepare(`
    SELECT li.*, lp.name as product_name, lp.lead_type, lc.name as category_name
    FROM lead_imports li
    JOIN lead_products lp ON li.product_id = lp.id
    JOIN lead_categories lc ON lp.category_id = lc.id
    WHERE li.id = ?
  `).get(req.params.importId);
  if (!imp) return res.redirect('/admin/pool/import');

  const leads = db.prepare('SELECT * FROM lead_pool WHERE import_id = ? ORDER BY id ASC').all(imp.id);

  let content = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
      <div>
        <h2 style="font-size:1.5rem;margin-bottom:4px;">Import #${imp.id}</h2>
        <p style="color:var(--gray-500);">${new Date(imp.imported_at).toLocaleString('de-DE')} &middot; ${imp.supplier_name || '-'} &middot; ${imp.product_name}
          <span class="badge ${imp.lead_type === 'b2b' ? 'badge-paid' : 'badge-delivered'}" style="margin-left:8px;">${imp.lead_type === 'b2b' ? 'B2B' : 'B2C'}</span>
        </p>
      </div>
      <div style="display:flex;align-items:center;gap:20px;">
        <span style="color:var(--success);font-weight:700;">${imp.lead_count} importiert</span>
        <span style="color:var(--warning);font-weight:700;">${imp.duplicates_skipped} Dubletten</span>
        <span style="color:var(--error);font-weight:700;">${imp.invalid_plz_skipped || 0} nicht DE</span>
        <a href="/admin/pool/import/${imp.id}/export" class="btn btn-outline btn-sm">CSV exportieren</a>
      </div>
    </div>
    ${imp.consent_url || imp.consent_text ? `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-bottom:20px;font-size:0.875rem;">
      <strong style="color:#15803d;">&#10003; Einwilligungsnachweis vorhanden</strong>
      ${imp.consent_url ? `<div style="margin-top:6px;">Quelle: <a href="${imp.consent_url}" target="_blank" style="color:#15803d;">${imp.consent_url}</a></div>` : ''}
      ${imp.consent_text ? `<div style="margin-top:6px;color:#166534;font-style:italic;">"${imp.consent_text}"</div>` : ''}
    </div>` : `
    <div style="background:#fef9c3;border:1px solid #fde047;border-radius:8px;padding:12px 16px;margin-bottom:20px;font-size:0.875rem;color:#854d0e;">
      &#9888; Kein Einwilligungsnachweis hinterlegt.
    </div>`}`;

  if (leads.length === 0) {
    content += '<p style="color:var(--gray-500);">Keine Leads in diesem Import.</p>';
  } else {
    if (imp.lead_type === 'b2b') {
      content += `
        <table class="data-table">
          <thead><tr><th>#</th><th>Firma</th><th>Nachname</th><th>Adresse</th><th>PLZ/Ort</th><th>Telefon</th><th>E-Mail</th><th>Zuweisungen</th><th>Detail</th></tr></thead>
          <tbody>`;
      for (let idx = 0; idx < leads.length; idx++) {
        const l = leads[idx];
        const adresse = [l.street, l.house_number].filter(Boolean).join(' ') || '-';
        const plzOrt = [l.postal_code, l.city].filter(Boolean).join(' ') || '-';
        content += `
          <tr>
            <td>${idx + 1}</td>
            <td><strong>${l.company_name || '-'}</strong></td>
            <td>${l.contact_lastname || '-'}</td>
            <td>${adresse}</td>
            <td>${plzOrt}</td>
            <td>${l.phone || '-'}</td>
            <td>${l.email || '-'}</td>
            <td>${l.current_assignments} / ${l.max_assignments}</td>
            <td><a href="/admin/pool/lead/${l.id}" class="btn btn-outline btn-sm">Ansehen</a></td>
          </tr>`;
      }
      content += '</tbody></table>';
    } else {
      content += `
        <table class="data-table">
          <thead><tr><th>#</th><th>Nachname</th><th>Vorname</th><th>Adresse</th><th>PLZ/Ort</th><th>Telefon</th><th>E-Mail</th><th>Zuweisungen</th><th>Detail</th></tr></thead>
          <tbody>`;
      for (let idx = 0; idx < leads.length; idx++) {
        const l = leads[idx];
        const adresse = [l.street, l.house_number].filter(Boolean).join(' ') || '-';
        const plzOrt = [l.postal_code, l.city].filter(Boolean).join(' ') || '-';
        content += `
          <tr>
            <td>${idx + 1}</td>
            <td><strong>${l.contact_lastname || '-'}</strong></td>
            <td>${l.contact_firstname || '-'}</td>
            <td>${adresse}</td>
            <td>${plzOrt}</td>
            <td>${l.phone || '-'}</td>
            <td>${l.email || '-'}</td>
            <td>${l.current_assignments} / ${l.max_assignments}</td>
            <td><a href="/admin/pool/lead/${l.id}" class="btn btn-outline btn-sm">Ansehen</a></td>
          </tr>`;
      }
      content += '</tbody></table>';
    }
  }

  content += '<div style="margin-top:24px;"><a href="/admin/pool/import" class="btn btn-outline">Zurück</a></div>';
  renderAdmin(req, res, content, 'import');
});

// LEAD POOL - Import CSV export
router.get('/pool/import/:importId/export', (req, res) => {
  const db = getDb();
  const imp = db.prepare(`
    SELECT li.*, lp.name as product_name, lp.lead_type, lc.name as category_name
    FROM lead_imports li
    JOIN lead_products lp ON li.product_id = lp.id
    JOIN lead_categories lc ON lp.category_id = lc.id
    WHERE li.id = ?
  `).get(req.params.importId);
  if (!imp) return res.redirect('/admin/pool/import');

  const leads = db.prepare('SELECT * FROM lead_pool WHERE import_id = ? ORDER BY id ASC').all(imp.id);

  const e = csvEscape;
  let csv = '';
  if (imp.lead_type === 'b2b') {
    csv = 'Firmenname;Nachname;Straße;Hausnummer;PLZ;Ort;Telefon;E-Mail;Bemerkungen;Zuweisungen;Max. Zuweisungen\r\n';
    for (const l of leads) {
      csv += [e(l.company_name), e(l.contact_lastname), e(l.street), e(l.house_number), e(l.postal_code), e(l.city), e(l.phone), e(l.email), e(l.remarks), l.current_assignments, l.max_assignments].join(';') + '\r\n';
    }
  } else {
    csv = 'Nachname;Vorname;Straße;Hausnummer;PLZ;Ort;Telefon;E-Mail;Geburtsdatum;Bemerkungen;Zuweisungen;Max. Zuweisungen\r\n';
    for (const l of leads) {
      csv += [e(l.contact_lastname), e(l.contact_firstname), e(l.street), e(l.house_number), e(l.postal_code), e(l.city), e(l.phone), e(l.email), e(l.date_of_birth), e(l.remarks), l.current_assignments, l.max_assignments].join(';') + '\r\n';
    }
  }

  const date = new Date(imp.imported_at).toISOString().slice(0, 10);
  const filename = `import_${imp.id}_${(imp.supplier_name || 'leads').replace(/[^a-zA-Z0-9]/g, '_')}_${date}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv);
});

// LEAD POOL - Suche nach Telefon/E-Mail (zum manuellen Setzen des Status,
// solange Rückmeldungen vom Abnehmer bei Partner-LeadArea nur manuell reinkommen)
router.get('/pool/search', (req, res) => {
  const db = getDb();
  const { normalizePhone } = require('../lib/importLeads');
  const q = (req.query.q || '').trim();

  let resultHtml = '';
  if (q) {
    const normalizedPhone = normalizePhone(q);
    const leads = db.prepare(`
      SELECT lp.id, lp.lead_type, lp.company_name, lp.contact_lastname, lp.contact_firstname,
        lp.postal_code, lp.city, lp.phone, lp.email, lp.lead_status, lp.created_at,
        pr.name as product_name
      FROM lead_pool lp
      JOIN lead_products pr ON lp.product_id = pr.id
      WHERE lp.phone = ? OR LOWER(lp.email) = LOWER(?)
      ORDER BY lp.created_at DESC
    `).all(normalizedPhone, q);

    if (leads.length === 0) {
      resultHtml = `<div class="alert" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;color:#15803d;">Keine Datensätze zu "${q}" gefunden.</div>`;
    } else {
      resultHtml = `
        <table class="data-table">
          <thead><tr><th>ID</th><th>Projekt</th><th>Name</th><th>PLZ/Ort</th><th>Telefon</th><th>E-Mail</th><th>Geliefert am</th><th>Status</th><th></th></tr></thead>
          <tbody>`;
      for (const l of leads) {
        const nameDisplay = l.lead_type === 'b2b'
          ? (l.company_name || l.contact_lastname || '-')
          : `${l.contact_lastname || ''} ${l.contact_firstname || ''}`.trim() || '-';
        resultHtml += `
            <tr>
              <td>${l.id}</td>
              <td>${l.product_name}</td>
              <td>${nameDisplay}</td>
              <td>${[l.postal_code, l.city].filter(Boolean).join(' ') || '-'}</td>
              <td>${l.phone || '-'}</td>
              <td>${l.email || '-'}</td>
              <td>${new Date(l.created_at).toLocaleDateString('de-DE')}</td>
              <td><span class="badge">${LEAD_STATUS_LABELS[l.lead_status] || l.lead_status}</span></td>
              <td><a href="/admin/pool/lead/${l.id}" class="btn btn-outline btn-sm">Status ändern</a></td>
            </tr>`;
      }
      resultHtml += '</tbody></table>';
    }
  }

  const content = `
    <h2 style="font-size:1.5rem;margin-bottom:24px;">Lead-Suche</h2>
    <p style="color:var(--gray-500);margin-bottom:24px;">Telefonnummer oder E-Mail-Adresse eingeben, um einen gelieferten Lead zu finden und seinen Status zu setzen (z.B. Storno nach Rückmeldung vom Auftraggeber).</p>
    <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:24px;box-shadow:var(--shadow-sm);">
      <form method="GET" action="/admin/pool/search" style="display:flex;gap:12px;">
        <input type="text" name="q" value="${q}" placeholder="Telefonnummer oder E-Mail" style="flex:1;padding:10px;border-radius:6px;border:1px solid var(--gray-300);" autofocus>
        <button type="submit" class="btn btn-primary">Suchen</button>
      </form>
    </div>
    ${resultHtml}`;

  renderAdmin(req, res, content, 'pool');
});

// Die QM-Warteschlange lebt jetzt in einem eigenen Bereich (routes/qm.js,
// Login-Bereich /qm) - Andrea und ihr Team haben mit dem Admin-Bereich
// nichts zu tun, siehe [[project_leadarea]].

// LEAD POOL - Single lead detail view
router.get('/pool/lead/:leadId', (req, res) => {
  const db = getDb();
  const lead = db.prepare(`
    SELECT lp.*, pr.name as product_name, pr.lead_type, lc.name as category_name,
      li.supplier_name, li.imported_at, li.id as import_id
    FROM lead_pool lp
    JOIN lead_products pr ON lp.product_id = pr.id
    JOIN lead_categories lc ON pr.category_id = lc.id
    LEFT JOIN lead_imports li ON lp.import_id = li.id
    WHERE lp.id = ?
  `).get(req.params.leadId);
  if (!lead) return res.redirect('/admin/pool/import');

  const assignments = db.prepare(`
    SELECT la.*, u.first_name, u.last_name, u.email as user_email
    FROM lead_assignments la
    JOIN users u ON la.user_id = u.id
    WHERE la.pool_lead_id = ?
    ORDER BY la.assigned_at DESC
  `).all(lead.id);

  let dataRows = '';
  if (lead.lead_type === 'b2b') {
    dataRows = `
      <tr><td style="color:var(--gray-500);width:180px;">Firmenname</td><td><strong>${lead.company_name || '-'}</strong></td></tr>
      <tr><td style="color:var(--gray-500);">Nachname (AP)</td><td><strong>${lead.contact_lastname || '-'}</strong></td></tr>
      <tr><td style="color:var(--gray-500);">Straße / Nr.</td><td>${[lead.street, lead.house_number].filter(Boolean).join(' ') || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">PLZ / Ort</td><td>${[lead.postal_code, lead.city].filter(Boolean).join(' ') || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">Telefon</td><td>${lead.phone || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">E-Mail</td><td>${lead.email || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">Bemerkungen</td><td>${lead.remarks || '-'}</td></tr>`;
  } else {
    dataRows = `
      <tr><td style="color:var(--gray-500);width:180px;">Nachname</td><td><strong>${lead.contact_lastname || '-'}</strong></td></tr>
      <tr><td style="color:var(--gray-500);">Vorname</td><td><strong>${lead.contact_firstname || '-'}</strong></td></tr>
      <tr><td style="color:var(--gray-500);">Straße / Nr.</td><td>${[lead.street, lead.house_number].filter(Boolean).join(' ') || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">PLZ / Ort</td><td>${[lead.postal_code, lead.city].filter(Boolean).join(' ') || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">Telefon</td><td>${lead.phone || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">E-Mail</td><td>${lead.email || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">Geburtsdatum</td><td>${lead.date_of_birth || '-'}</td></tr>
      <tr><td style="color:var(--gray-500);">Bemerkungen</td><td>${lead.remarks || '-'}</td></tr>`;
  }

  let assignmentRows = '';
  if (assignments.length === 0) {
    assignmentRows = '<p style="color:var(--gray-500);font-size:0.9rem;">Noch keinem Kunden zugewiesen.</p>';
  } else {
    assignmentRows = `
      <table class="data-table" style="font-size:0.85rem;">
        <thead><tr><th>Kunde</th><th>Zugewiesen am</th></tr></thead>
        <tbody>`;
    for (const a of assignments) {
      assignmentRows += `<tr><td>${a.first_name} ${a.last_name}</td><td>${new Date(a.assigned_at).toLocaleString('de-DE')}</td></tr>`;
    }
    assignmentRows += '</tbody></table>';
  }

  const content = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
      <h2 style="font-size:1.5rem;">Lead #${lead.id}</h2>
      <span class="badge ${lead.lead_type === 'b2b' ? 'badge-paid' : 'badge-delivered'}">${lead.lead_type === 'b2b' ? 'B2B' : 'B2C'}</span>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">

      <div style="background:var(--white);border-radius:var(--radius);padding:24px;box-shadow:var(--shadow-sm);">
        <h3 style="margin-bottom:16px;color:var(--primary);">Kontaktdaten</h3>
        <table class="lead-detail-table" style="width:100%;border-collapse:collapse;">
          <tbody>
            ${dataRows}
          </tbody>
        </table>
      </div>

      <div>
        <div style="background:var(--white);border-radius:var(--radius);padding:24px;box-shadow:var(--shadow-sm);margin-bottom:20px;">
          <h3 style="margin-bottom:16px;color:var(--primary);">Lead-Info</h3>
          <table class="lead-detail-table" style="width:100%;border-collapse:collapse;">
            <tbody>
              <tr><td style="color:var(--gray-500);width:160px;">Branche</td><td><strong>${lead.product_name}</strong></td></tr>
              <tr><td style="color:var(--gray-500);">Kategorie</td><td>${lead.category_name}</td></tr>
              <tr><td style="color:var(--gray-500);">Lieferant</td><td>${lead.supplier_name || '-'}</td></tr>
              <tr><td style="color:var(--gray-500);">Import-Datum</td><td>${lead.imported_at ? new Date(lead.imported_at).toLocaleString('de-DE') : '-'}</td></tr>
              <tr><td style="color:var(--gray-500);">Zuweisungen</td><td><strong>${lead.current_assignments}</strong> / ${lead.max_assignments}</td></tr>
              <tr><td style="color:var(--gray-500);">Verfügbarkeit</td><td><span class="badge ${lead.current_assignments < lead.max_assignments ? 'badge-active' : 'badge-cancelled'}">${lead.current_assignments < lead.max_assignments ? 'Verfügbar' : 'Ausgeschöpft'}</span></td></tr>
              <tr><td style="color:var(--gray-500);">Lead-Status</td><td><span class="badge ${{ approved: 'badge-active', billed: 'badge-active', paid: 'badge-active', compensated: 'badge-active', duplicate: 'badge-cancelled', cancelled: 'badge-cancelled', spam: 'badge-cancelled', invalid: 'badge-cancelled' }[lead.lead_status] || 'badge-paid'}">${LEAD_STATUS_LABELS[lead.lead_status] || lead.lead_status}</span></td></tr>
              ${lead.cancel_reason ? `<tr><td style="color:var(--gray-500);">Grund</td><td style="color:var(--error);">${lead.cancel_reason}</td></tr>` : ''}
            </tbody>
          </table>
        </div>

        <div style="background:var(--white);border-radius:var(--radius);padding:24px;box-shadow:var(--shadow-sm);margin-bottom:20px;">
          <h3 style="margin-bottom:16px;color:var(--primary);">Status ändern</h3>
          <form method="POST" action="/admin/pool/lead/${lead.id}/status" style="display:flex;flex-direction:column;gap:12px;">
            <div style="display:flex;gap:8px;align-items:center;">
              <select name="lead_status" style="padding:8px;border-radius:6px;border:1px solid var(--gray-300);flex:1;">
                <option value="pending" ${lead.lead_status === 'pending' ? 'selected' : ''}>In Bearbeitung</option>
                <option value="approved" ${lead.lead_status === 'approved' ? 'selected' : ''}>Genehmigt</option>
                <option value="billed" ${lead.lead_status === 'billed' ? 'selected' : ''}>Abgerechnet</option>
                <option value="paid" ${lead.lead_status === 'paid' ? 'selected' : ''}>Ausgezahlt</option>
                <option value="cancelled" ${lead.lead_status === 'cancelled' ? 'selected' : ''}>Storno</option>
                <option value="spam" ${lead.lead_status === 'spam' ? 'selected' : ''}>Spam</option>
                <option value="duplicate" ${lead.lead_status === 'duplicate' ? 'selected' : ''}>Dublette</option>
                <option value="invalid" ${lead.lead_status === 'invalid' ? 'selected' : ''}>Ungültig</option>
              </select>
            </div>
            <input type="text" name="cancel_reason" placeholder="Grund (z.B. bei Storno/Spam)" value="${lead.cancel_reason || ''}" style="padding:8px;border-radius:6px;border:1px solid var(--gray-300);">
            <button type="submit" class="btn btn-primary btn-sm">Status speichern</button>
          </form>
        </div>

        <div style="background:var(--white);border-radius:var(--radius);padding:24px;box-shadow:var(--shadow-sm);">
          <h3 style="margin-bottom:16px;color:var(--primary);">Zugewiesen an</h3>
          ${assignmentRows}
        </div>
      </div>

    </div>

    <div style="margin-top:24px;">
      <a href="/admin/pool/import/${lead.import_id}" class="btn btn-outline">Zurück zum Import</a>
    </div>`;

  renderAdmin(req, res, content, 'import');
});

// LEAD POOL - Update lead status
router.post('/pool/lead/:leadId/status', (req, res) => {
  const db = getDb();
  const leadId = parseInt(req.params.leadId);
  const validStatuses = ['pending', 'approved', 'billed', 'paid', 'cancelled', 'spam', 'duplicate', 'invalid'];
  const newStatus = req.body.lead_status;
  if (!validStatuses.includes(newStatus)) return res.redirect(`/admin/pool/lead/${leadId}`);

  const cancelReason = (newStatus === 'cancelled' || newStatus === 'spam') ? (req.body.cancel_reason || null) : null;
  db.prepare('UPDATE lead_pool SET lead_status = ?, cancel_reason = ? WHERE id = ?').run(newStatus, cancelReason, leadId);
  res.redirect(`/admin/pool/lead/${leadId}`);
});

// LEAD POOL - CSV Import handler
const csvUpload = multer({ dest: path.join(__dirname, '..', 'public', 'uploads', 'csv') });
const { processImport } = require('../lib/importLeads');

router.post('/pool/import', csvUpload.single('csvfile'), (req, res) => {
  if (!req.file) return res.redirect('/admin/pool/import');

  const db = getDb();
  const partnerUserId = parseInt(req.body.partner_user_id) || null;
  const supplierName = (req.body.supplier_name || '').trim();
  const resolvedSupplier = supplierName || (partnerUserId ? db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(partnerUserId) : null);
  const supplierLabel = supplierName || (resolvedSupplier && resolvedSupplier.first_name ? `${resolvedSupplier.first_name} ${resolvedSupplier.last_name}` : null);

  processImport({
    filePath: req.file.path,
    originalFilename: req.file.originalname,
    productId: parseInt(req.body.product_id),
    partnerUserId,
    supplierName: supplierLabel,
    maxAssignments: Math.max(1, Math.min(3, parseInt(req.body.max_assignments) || 3)),
    consentUrl: (req.body.consent_url || '').trim() || null,
    consentText: (req.body.consent_text || '').trim() || null,
  });

  res.redirect('/admin/pool/import');
});

// LEAD POOL - Assignments overview
router.get('/pool/assignments', (req, res) => {
  const db = getDb();

  const customers = db.prepare(`
    SELECT u.id, u.first_name, u.last_name, u.email,
      (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi
       JOIN orders o ON oi.order_id = o.id
       WHERE o.user_id = u.id AND o.status IN ('paid', 'delivered')) as total_ordered,
      (SELECT COUNT(*) FROM lead_assignments la WHERE la.user_id = u.id) as total_assigned
    FROM users u
    WHERE u.role = 'user'
    AND (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status IN ('paid', 'delivered')) > 0
    ORDER BY u.last_name, u.first_name
  `).all();

  let content = `
    <h2 style="font-size:1.5rem;margin-bottom:24px;">Pool-Zuweisungen</h2>
    <p style="color:var(--gray-500);margin-bottom:24px;">Übersicht: wie viele Leads wurden aus dem Pool an Kunden zugewiesen.</p>`;

  if (customers.length === 0) {
    content += `
      <div class="empty-state">
        <div class="empty-icon">👥</div>
        <h3>Noch keine Kunden mit Bestellungen</h3>
      </div>`;
  } else {
    content += `
      <table class="data-table">
        <thead><tr><th>Kunde</th><th>E-Mail</th><th>Bestellt</th><th>Zugewiesen</th><th>Offen</th><th>Aktion</th></tr></thead>
        <tbody>`;
    for (const c of customers) {
      const remaining = Math.max(0, c.total_ordered - c.total_assigned);
      content += `
        <tr>
          <td>${c.first_name} ${c.last_name}</td>
          <td>${c.email}</td>
          <td>${c.total_ordered}</td>
          <td>${c.total_assigned}</td>
          <td style="color:${remaining > 0 ? 'var(--warning)' : 'var(--success)'};font-weight:700;">${remaining}</td>
          <td>
            ${remaining > 0 ? `<a href="/admin/pool/assignments/${c.id}" class="btn btn-primary btn-sm">Zuweisen</a>` : '<span style="color:var(--success);font-size:0.85rem;">Vollständig</span>'}
          </td>
        </tr>`;
    }
    content += '</tbody></table>';
  }

  renderAdmin(req, res, content, 'assignments');
});

// LEAD POOL - Assign leads to a customer
router.get('/pool/assignments/:userId', (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.redirect('/admin/pool/assignments');

  const openItems = db.prepare(`
    SELECT oi.id as order_item_id, oi.quantity, oi.product_id, lp.name as product_name, lc.name as category_name,
      (SELECT COUNT(*) FROM lead_assignments la WHERE la.order_item_id = oi.id AND la.user_id = ?) as assigned_count
    FROM order_items oi
    JOIN orders o ON oi.order_id = o.id
    JOIN lead_products lp ON oi.product_id = lp.id
    JOIN lead_categories lc ON lp.category_id = lc.id
    WHERE o.user_id = ? AND o.status IN ('paid', 'delivered')
    ORDER BY o.created_at DESC
  `).all(userId, userId);

  let content = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:24px;">
      <div>
        <h2 style="font-size:1.5rem;margin-bottom:4px;">Zuweisungen für ${user.first_name} ${user.last_name}</h2>
        <p style="color:var(--gray-500);">${user.email}</p>
      </div>
      <a href="/admin/pool/assignments/${userId}/export" class="btn btn-outline btn-sm">CSV exportieren</a>
    </div>`;

  for (const item of openItems) {
    const remaining = item.quantity - item.assigned_count;
    const availableLeads = db.prepare(`
      SELECT lp.* FROM lead_pool lp
      WHERE lp.product_id = ? AND lp.current_assignments < lp.max_assignments
      AND lp.id NOT IN (SELECT la.pool_lead_id FROM lead_assignments la WHERE la.user_id = ?)
      ORDER BY lp.created_at ASC
      LIMIT 20
    `).all(item.product_id, userId);

    content += `
      <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:20px;box-shadow:var(--shadow-sm);">
        <h3 style="margin-bottom:4px;">${item.category_name} &rarr; ${item.product_name}</h3>
        <p style="color:var(--gray-500);margin-bottom:16px;">${item.quantity} bestellt, ${item.assigned_count} zugewiesen, <strong>${remaining} offen</strong></p>`;

    if (remaining > 0 && availableLeads.length > 0) {
      content += `
        <form method="POST" action="/admin/pool/assignments/${userId}/assign" style="margin-bottom:16px;">
          <input type="hidden" name="order_item_id" value="${item.order_item_id}">
          <input type="hidden" name="product_id" value="${item.product_id}">
          <div style="display:flex;align-items:center;gap:12px;">
            <label style="white-space:nowrap;">Automatisch zuweisen:</label>
            <input type="number" name="count" value="${Math.min(remaining, availableLeads.length)}" min="1" max="${Math.min(remaining, availableLeads.length)}" class="qty-input" style="width:80px;">
            <span style="color:var(--gray-500);font-size:0.85rem;">(${availableLeads.length} verfügbar im Pool)</span>
            <button type="submit" class="btn btn-primary btn-sm">Zuweisen</button>
          </div>
        </form>`;
    } else if (remaining > 0) {
      content += '<p style="color:var(--warning);font-size:0.9rem;">Keine passenden Leads im Pool verfügbar.</p>';
    }

    const assigned = db.prepare(`
      SELECT lp.*, la.assigned_at, la.downloaded_at, la.id as assignment_id FROM lead_assignments la
      JOIN lead_pool lp ON la.pool_lead_id = lp.id
      WHERE la.user_id = ? AND la.order_item_id = ?
      ORDER BY la.assigned_at DESC
    `).all(userId, item.order_item_id);

    if (assigned.length > 0) {
      content += `
        <table class="data-table" style="margin-top:12px;">
          <thead><tr><th>Typ</th><th>Firma / Name</th><th>Adresse</th><th>PLZ/Ort</th><th>Telefon</th><th>E-Mail</th><th>Zugewiesen am</th><th>Download</th></tr></thead>
          <tbody>`;
      for (const a of assigned) {
        const adresse = [a.street, a.house_number].filter(Boolean).join(' ') || '-';
        const plzOrt = [a.postal_code, a.city].filter(Boolean).join(' ') || '-';
        const nameCol = a.lead_type === 'b2b'
          ? `${a.company_name || '-'} <small style="color:var(--gray-500);">(${a.contact_lastname || '-'})</small>`
          : `${a.contact_lastname || '-'}${a.contact_firstname ? ', ' + a.contact_firstname : ''}`;
        const downloadCell = a.downloaded_at
          ? `<span style="color:var(--gray-500);font-size:0.8rem;">${new Date(a.downloaded_at).toLocaleString('de-DE')}</span>
             <form method="POST" action="/admin/pool/assignment/${a.assignment_id}/reset-download" style="margin-top:4px;">
               <button type="submit" class="btn btn-outline btn-sm" onclick="return confirm('Erneuten Download für diesen Datensatz freigeben?')">Erneut freigeben</button>
             </form>`
          : '<span style="color:var(--gray-500);">Noch nicht</span>';
        content += `
          <tr>
            <td><span class="badge ${a.lead_type === 'b2b' ? 'badge-paid' : 'badge-delivered'}">${a.lead_type === 'b2b' ? 'B2B' : 'B2C'}</span></td>
            <td>${nameCol}</td>
            <td>${adresse}</td>
            <td>${plzOrt}</td>
            <td>${a.phone || '-'}</td>
            <td>${a.email || '-'}</td>
            <td>${new Date(a.assigned_at).toLocaleString('de-DE')}</td>
            <td>${downloadCell}</td>
          </tr>`;
      }
      content += '</tbody></table>';
    }

    content += '</div>';
  }

  content += '<a href="/admin/pool/assignments" class="btn btn-outline">Zurück</a>';
  renderAdmin(req, res, content, 'assignments');
});

// LEAD POOL - Erneuten Download fuer eine Zuweisung freigeben (Sicherheitsregel: normalerweise nur 1x Download)
router.post('/pool/assignment/:id/reset-download', (req, res) => {
  const db = getDb();
  const assignment = db.prepare('SELECT * FROM lead_assignments WHERE id = ?').get(req.params.id);
  if (assignment) {
    db.prepare('UPDATE lead_assignments SET downloaded_at = NULL WHERE id = ?').run(assignment.id);
  }
  res.redirect(req.get('Referrer') || '/admin/pool/assignments');
});

// LEAD POOL - Assignments CSV export
router.get('/pool/assignments/:userId/export', (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) return res.redirect('/admin/pool/assignments');

  const assigned = db.prepare(`
    SELECT lp.*, la.assigned_at, pr.name as product_name, lc.name as category_name,
      li.supplier_name
    FROM lead_assignments la
    JOIN lead_pool lp ON la.pool_lead_id = lp.id
    JOIN lead_products pr ON lp.product_id = pr.id
    JOIN lead_categories lc ON pr.category_id = lc.id
    LEFT JOIN lead_imports li ON lp.import_id = li.id
    WHERE la.user_id = ?
    ORDER BY la.assigned_at DESC
  `).all(userId);

  const e = csvEscape;
  let csv = 'Typ;Branche;Firma/Nachname;Vorname;Straße;Hausnummer;PLZ;Ort;Telefon;E-Mail;Geburtsdatum;Bemerkungen;Lieferant;Zugewiesen am\r\n';
  for (const l of assigned) {
    csv += [
      l.lead_type === 'b2b' ? 'B2B' : 'B2C',
      e(l.product_name),
      l.lead_type === 'b2b' ? e(l.company_name) : e(l.contact_lastname),
      e(l.contact_firstname),
      e(l.street),
      e(l.house_number),
      e(l.postal_code),
      e(l.city),
      e(l.phone),
      e(l.email),
      e(l.date_of_birth),
      e(l.remarks),
      e(l.supplier_name),
      new Date(l.assigned_at).toLocaleString('de-DE'),
    ].join(';') + '\r\n';
  }

  const date = new Date().toISOString().slice(0, 10);
  const filename = `zuweisungen_${user.last_name}_${user.first_name}_${date}.csv`.replace(/[^a-zA-Z0-9_.]/g, '_');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('﻿' + csv);
});

// LEAD POOL - Execute assignment
router.post('/pool/assignments/:userId/assign', (req, res) => {
  const db = getDb();
  const userId = parseInt(req.params.userId);
  const orderItemId = parseInt(req.body.order_item_id);
  const productId = parseInt(req.body.product_id);
  const count = Math.max(1, parseInt(req.body.count) || 1);

  const orderItem = db.prepare('SELECT tier FROM order_items WHERE id = ?').get(orderItemId);
  const tier = orderItem ? orderItem.tier : 1;

  assignLeadsToItem(db, orderItemId, userId, productId, count, tier);

  res.redirect(`/admin/pool/assignments/${userId}`);
});

// BLACKLIST
router.get('/blacklist', (req, res) => {
  const db = getDb();
  const entries = db.prepare('SELECT * FROM phone_blacklist ORDER BY added_at DESC').all();
  const alert = req.query.added ? '<div class="alert alert-success">Nummer zur Blacklist hinzugefügt.</div>'
    : req.query.removed ? '<div class="alert alert-success">Nummer entfernt.</div>' : '';

  let rows = entries.length === 0
    ? '<tr><td colspan="4" style="color:var(--gray-500);text-align:center;">Keine Einträge.</td></tr>'
    : entries.map(e => `
      <tr>
        <td><strong>${e.phone}</strong></td>
        <td>${e.reason || '-'}</td>
        <td>${new Date(e.added_at).toLocaleString('de-DE')}</td>
        <td>
          <form method="POST" action="/admin/blacklist/${e.id}/delete">
            <button type="submit" class="btn btn-danger btn-sm">Entfernen</button>
          </form>
        </td>
      </tr>`).join('');

  const content = `
    <div class="admin-header">
      <h2>Telefon-Blacklist</h2>
    </div>
    ${alert}
    <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:24px;box-shadow:var(--shadow-sm);">
      <h3 style="margin-bottom:16px;">Nummer hinzufügen</h3>
      <form method="POST" action="/admin/blacklist" style="display:flex;gap:12px;flex-wrap:wrap;">
        <div class="form-group" style="flex:1;min-width:200px;">
          <label>Telefonnummer *</label>
          <input type="text" name="phone" placeholder="+491234567890" required>
        </div>
        <div class="form-group" style="flex:2;min-width:200px;">
          <label>Grund</label>
          <input type="text" name="reason" placeholder="z.B. Fake-Nummer, Beschwerde, Betrug">
        </div>
        <div style="display:flex;align-items:flex-end;">
          <button type="submit" class="btn btn-primary">Hinzufügen</button>
        </div>
      </form>
    </div>
    <table class="data-table">
      <thead><tr><th>Telefonnummer</th><th>Grund</th><th>Hinzugefügt am</th><th>Aktion</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  renderAdmin(req, res, content, 'blacklist');
});

router.post('/blacklist', (req, res) => {
  const db = getDb();
  const { normalizePhone } = require('../lib/importLeads');
  const phone = normalizePhone((req.body.phone || '').trim());
  const reason = (req.body.reason || '').trim() || null;
  if (!phone) return res.redirect('/admin/blacklist');
  try {
    db.prepare('INSERT INTO phone_blacklist (phone, reason) VALUES (?, ?)').run(phone, reason);
  } catch (_) {}
  res.redirect('/admin/blacklist?added=1');
});

router.post('/blacklist/:id/delete', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM phone_blacklist WHERE id = ?').run(req.params.id);
  res.redirect('/admin/blacklist?removed=1');
});

// WIDERRUF / OPT-OUT
router.get('/widerruf', (req, res) => {
  const db = getDb();
  const { normalizePhone } = require('../lib/importLeads');
  const rawPhone = (req.query.phone || '').trim();
  const phone = rawPhone ? normalizePhone(rawPhone) : null;

  let resultHtml = '';

  if (phone) {
    const leads = db.prepare(`
      SELECT lp.*, pr.name as product_name, lc.name as category_name,
        li.supplier_name, li.imported_at, li.consent_url, li.consent_text
      FROM lead_pool lp
      JOIN lead_products pr ON lp.product_id = pr.id
      JOIN lead_categories lc ON pr.category_id = lc.id
      LEFT JOIN lead_imports li ON lp.import_id = li.id
      WHERE lp.phone = ?
    `).all(phone);

    if (leads.length === 0) {
      resultHtml = `<div class="alert" style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;color:#15803d;">Keine Datensätze mit dieser Nummer gefunden.</div>`;
    } else {
      for (const lead of leads) {
        const buyers = db.prepare(`
          SELECT u.first_name, u.last_name, u.email, la.assigned_at, la.downloaded_at
          FROM lead_assignments la
          JOIN users u ON la.user_id = u.id
          WHERE la.pool_lead_id = ?
        `).all(lead.id);

        const nameDisplay = lead.lead_type === 'b2b'
          ? (lead.company_name || lead.contact_lastname || '-')
          : `${lead.contact_lastname || ''} ${lead.contact_firstname || ''}`.trim() || '-';

        const statusBadge = {
          pending: '<span class="badge badge-paid">Aktiv</span>',
          cancelled: '<span class="badge badge-cancelled">Widerrufen</span>',
          duplicate: '<span class="badge" style="background:#e5e7eb;color:#6b7280;">Dublette</span>',
        }[lead.lead_status] || `<span class="badge">${lead.lead_status}</span>`;

        const consentBlock = lead.consent_url || lead.consent_text
          ? `<div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:10px;margin-top:10px;font-size:0.8rem;">
              <strong style="color:#15803d;">Einwilligungsnachweis:</strong>
              ${lead.consent_url ? `<div>Quelle: <a href="${lead.consent_url}" target="_blank">${lead.consent_url}</a></div>` : ''}
              ${lead.consent_text ? `<div style="color:#166534;font-style:italic;">"${lead.consent_text}"</div>` : ''}
            </div>`
          : `<div style="background:#fef9c3;border:1px solid #fde047;border-radius:6px;padding:8px 10px;margin-top:10px;font-size:0.8rem;color:#854d0e;">&#9888; Kein Einwilligungsnachweis hinterlegt.</div>`;

        const buyerRows = buyers.length === 0
          ? '<p style="color:var(--gray-500);font-size:0.85rem;">Noch keinem Käufer zugewiesen.</p>'
          : `<table class="data-table" style="margin-top:8px;font-size:0.85rem;">
              <thead><tr><th>Käufer</th><th>E-Mail</th><th>Zugewiesen am</th><th>Heruntergeladen</th></tr></thead>
              <tbody>${buyers.map(b => `
                <tr>
                  <td>${b.first_name} ${b.last_name}</td>
                  <td>${b.email}</td>
                  <td>${new Date(b.assigned_at).toLocaleDateString('de-DE')}</td>
                  <td>${b.downloaded_at ? new Date(b.downloaded_at).toLocaleString('de-DE') : '<span style="color:var(--gray-500);">Nein</span>'}</td>
                </tr>`).join('')}</tbody>
            </table>`;

        resultHtml += `
          <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:20px;box-shadow:var(--shadow-sm);">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;">
              <div>
                <h3 style="margin-bottom:4px;">${nameDisplay}</h3>
                <div style="color:var(--gray-500);font-size:0.875rem;">${lead.product_name} &middot; ${lead.supplier_name || 'Unbekannt'} &middot; ${lead.imported_at ? new Date(lead.imported_at).toLocaleDateString('de-DE') : '-'}</div>
              </div>
              <div style="display:flex;gap:8px;align-items:center;">
                ${statusBadge}
                ${lead.lead_status !== 'cancelled' ? `
                  <form method="POST" action="/admin/widerruf/execute">
                    <input type="hidden" name="lead_id" value="${lead.id}">
                    <input type="hidden" name="phone" value="${rawPhone}">
                    <button type="submit" class="btn btn-danger btn-sm"
                      onclick="return confirm('Widerruf durchführen? Alle Käufer werden per E-Mail informiert.')">
                      Widerruf durchführen
                    </button>
                  </form>` : '<span style="color:var(--error);font-size:0.85rem;">Bereits widerrufen</span>'}
              </div>
            </div>
            ${consentBlock}
            <h4 style="margin:16px 0 8px;">Käufer dieses Datensatzes</h4>
            ${buyerRows}
          </div>`;
      }
    }
  }

  const content = `
    <div class="admin-header">
      <h2>Widerruf / Opt-out</h2>
    </div>
    <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:24px;box-shadow:var(--shadow-sm);">
      <p style="color:var(--gray-500);margin-bottom:16px;font-size:0.9rem;">
        Telefonnummer eingeben um alle Datensätze zu finden und ggf. einen Widerruf durchzuführen.
        Alle Käufer werden per E-Mail informiert; die Nummer wird auf die Blacklist gesetzt.
      </p>
      <form method="GET" action="/admin/widerruf" style="display:flex;gap:12px;align-items:flex-end;">
        <div class="form-group" style="flex:1;margin-bottom:0;">
          <label>Telefonnummer</label>
          <input type="text" name="phone" value="${rawPhone}" placeholder="+491234567890 oder 01234567890" style="font-size:1rem;">
        </div>
        <button type="submit" class="btn btn-primary">Suchen</button>
      </form>
    </div>
    ${resultHtml}`;

  renderAdmin(req, res, content, 'widerruf');
});

router.post('/widerruf/execute', async (req, res) => {
  const db = getDb();
  const { normalizePhone } = require('../lib/importLeads');
  const { sendOptOutNotification } = require('../lib/mailer');
  const leadId = parseInt(req.body.lead_id);
  const phoneRaw = (req.body.phone || '').trim();

  const lead = db.prepare(`
    SELECT lp.*, pr.name as product_name
    FROM lead_pool lp
    JOIN lead_products pr ON lp.product_id = pr.id
    WHERE lp.id = ?
  `).get(leadId);

  if (!lead || lead.lead_status === 'cancelled') {
    return res.redirect('/admin/widerruf?phone=' + encodeURIComponent(phoneRaw));
  }

  // 1. Lead als widerrufen markieren
  db.prepare("UPDATE lead_pool SET lead_status = 'cancelled', cancel_reason = ? WHERE id = ?")
    .run('Widerruf der Einwilligung durch Verbraucher', leadId);

  // 2. Telefonnummer auf Blacklist
  const normalizedPhone = normalizePhone(lead.phone || phoneRaw);
  if (normalizedPhone) {
    try {
      db.prepare('INSERT INTO phone_blacklist (phone, reason) VALUES (?, ?)').run(normalizedPhone, 'Widerruf der Einwilligung');
    } catch (_) {}
  }

  // 3. Alle Käufer per E-Mail benachrichtigen
  const buyers = db.prepare(`
    SELECT u.first_name, u.last_name, u.email
    FROM lead_assignments la
    JOIN users u ON la.user_id = u.id
    WHERE la.pool_lead_id = ?
  `).all(leadId);

  const nameDisplay = lead.lead_type === 'b2b'
    ? (lead.company_name || lead.contact_lastname || 'Unbekannt')
    : `${lead.contact_lastname || ''} ${lead.contact_firstname || ''}`.trim() || 'Unbekannt';

  for (const buyer of buyers) {
    sendOptOutNotification({
      buyerName: `${buyer.first_name} ${buyer.last_name}`,
      buyerEmail: buyer.email,
      leadDisplay: nameDisplay,
      phone: lead.phone || normalizedPhone || '-',
      productName: lead.product_name,
    }).catch(err => console.error('[Mailer] Opt-out Fehler:', err.message));
  }

  res.redirect('/admin/widerruf?phone=' + encodeURIComponent(phoneRaw) + '&done=1');
});

// LEAD-REPORTING (vormals Provisionsabrechnung, nur intern, CCs haben keinen
// Zugriff hierauf): Auswertung über alle oder einen Partner, alle oder ein
// Projekt, freier Zeitraum - Status-Set siehe LEAD_STATUS_LABELS oben.
const REPORT_STATUS_ORDER = ['in_pruefung', 'pending', 'approved', 'billed', 'paid', 'cancelled', 'spam', 'duplicate', 'invalid', 'blacklist'];

const fmtEuro = (n) => n.toFixed(2).replace('.', ',') + ' €';

function buildStatusBreakdownTable(rowLabel, groups, groupOrder, showMoney) {
  const moneyHead = showMoney ? '<th>Offene Provision</th><th>Ausgezahlt</th>' : '';
  let html = `
    <table class="data-table" style="font-size:0.85rem;">
      <thead><tr><th>${rowLabel}</th><th>Gesamt</th>${REPORT_STATUS_ORDER.map(s => `<th>${LEAD_STATUS_LABELS[s]}</th>`).join('')}${moneyHead}</tr></thead>
      <tbody>`;
  for (const key of groupOrder) {
    const g = groups[key];
    const moneyCells = showMoney ? `<td><strong>${fmtEuro(g.openProvision)}</strong></td><td>${fmtEuro(g.paidProvision)}</td>` : '';
    html += `<tr><td>${g.name}</td><td><strong>${g.total}</strong></td>${REPORT_STATUS_ORDER.map(s => `<td>${g.counts[s] || 0}</td>`).join('')}${moneyCells}</tr>`;
  }
  html += '</tbody></table>';
  return html;
}

router.get('/provisionen', (req, res) => {
  const db = getDb();
  const partners = db.prepare("SELECT id, first_name, last_name, email FROM users WHERE role = 'partner' ORDER BY last_name").all();
  const partnerOptions = '<option value="">Alle Partner</option>' +
    partners.map(p => `<option value="${p.id}" ${req.query.partner_user_id == p.id ? 'selected' : ''}>${p.first_name} ${p.last_name} (${p.email})</option>`).join('');

  const products = db.prepare('SELECT id, name FROM lead_products ORDER BY name').all();
  const productOptions = '<option value="">Alle Projekte</option>' +
    products.map(p => `<option value="${p.id}" ${req.query.product_id == p.id ? 'selected' : ''}>${p.name}</option>`).join('');

  const partnerUserId = parseInt(req.query.partner_user_id) || null;
  const productId = parseInt(req.query.product_id) || null;
  const from = req.query.from || '';
  const to = req.query.to || '';

  let content = `
    <h2 style="font-size:1.5rem;margin-bottom:24px;">Lead-Reporting</h2>
    <p style="color:var(--gray-500);margin-bottom:20px;font-size:0.9rem;">
      Nur für internen Gebrauch - Callcenter haben keinen Zugriff auf diese Seite oder sonst irgendeinen
      Teil von LeadArea außer ihrem eigenen Partner-Dashboard. Die eigentliche Abrechnung/Gutschrift
      verschickst du manuell außerhalb des Systems.
    </p>
    <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:24px;box-shadow:var(--shadow-sm);">
      <form method="GET" action="/admin/provisionen" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
        <div class="form-group" style="margin-bottom:0;">
          <label>Partner</label>
          <select name="partner_user_id">${partnerOptions}</select>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label>Projekt</label>
          <select name="product_id">${productOptions}</select>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label>Von *</label>
          <input type="date" name="from" value="${from}" required>
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label>Bis *</label>
          <input type="date" name="to" value="${to}" required>
        </div>
        <button type="submit" class="btn btn-primary btn-sm">Auswerten</button>
        <span style="display:flex;gap:6px;flex-wrap:wrap;">
          <a href="#" onclick="setRange('today');return false;" class="btn btn-outline btn-sm">Heute</a>
          <a href="#" onclick="setRange('week');return false;" class="btn btn-outline btn-sm">Diese Woche</a>
          <a href="#" onclick="setRange('month');return false;" class="btn btn-outline btn-sm">Dieser Monat</a>
          <a href="#" onclick="setRange('lastmonth');return false;" class="btn btn-outline btn-sm">Letzter Monat</a>
          <a href="#" onclick="setRange('year');return false;" class="btn btn-outline btn-sm">Dieses Jahr</a>
        </span>
      </form>
    </div>
    <script>
      function setRange(type) {
        const now = new Date();
        let from, to;
        if (type === 'today') {
          from = now; to = now;
        } else if (type === 'week') {
          const day = (now.getDay() + 6) % 7;
          from = new Date(now); from.setDate(now.getDate() - day);
          to = now;
        } else if (type === 'month') {
          from = new Date(now.getFullYear(), now.getMonth(), 1);
          to = now;
        } else if (type === 'lastmonth') {
          from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          to = new Date(now.getFullYear(), now.getMonth(), 0);
        } else if (type === 'year') {
          from = new Date(now.getFullYear(), 0, 1);
          to = now;
        }
        const fmt = d => d.toISOString().slice(0, 10);
        document.querySelector('input[name="from"]').value = fmt(from);
        document.querySelector('input[name="to"]').value = fmt(to);
      }
    </script>`;

  if (from && to) {
    const toExclusive = to + ' 23:59:59';
    const rows = db.prepare(`
      SELECT lp.id, lp.lead_type, lp.company_name, lp.contact_lastname, lp.contact_firstname,
             lp.postal_code, lp.city, lp.lead_status, lp.cancel_reason, lp.created_at,
             pr.id as product_id, pr.name as product_name, pr.partner_payout,
             li.partner_user_id, u.first_name as partner_first_name, u.last_name as partner_last_name
      FROM lead_pool lp
      JOIN lead_imports li ON lp.import_id = li.id
      JOIN lead_products pr ON lp.product_id = pr.id
      JOIN users u ON li.partner_user_id = u.id
      WHERE li.imported_at >= ? AND li.imported_at <= ?
        AND (? IS NULL OR li.partner_user_id = ?)
        AND (? IS NULL OR lp.product_id = ?)
      ORDER BY u.last_name, pr.name, lp.created_at
    `).all(from + ' 00:00:00', toExclusive, partnerUserId, partnerUserId, productId, productId);

    const totalCounts = {};
    const byPartner = {};
    const byProduct = {};
    let totalOpenProvision = 0;
    let totalPaidProvision = 0;
    let anyPayoutMissing = false;

    for (const r of rows) {
      totalCounts[r.lead_status] = (totalCounts[r.lead_status] || 0) + 1;

      if (!byPartner[r.partner_user_id]) byPartner[r.partner_user_id] = { name: `${r.partner_first_name} ${r.partner_last_name}`, total: 0, counts: {}, openProvision: 0, paidProvision: 0 };
      byPartner[r.partner_user_id].total++;
      byPartner[r.partner_user_id].counts[r.lead_status] = (byPartner[r.partner_user_id].counts[r.lead_status] || 0) + 1;

      if (!byProduct[r.product_id]) byProduct[r.product_id] = { name: r.product_name, payout: r.partner_payout || 0, total: 0, counts: {}, openProvision: 0, paidProvision: 0 };
      byProduct[r.product_id].total++;
      byProduct[r.product_id].counts[r.lead_status] = (byProduct[r.product_id].counts[r.lead_status] || 0) + 1;

      // "Offene Provision" = bereits verdient (genehmigt/abgerechnet), aber noch
      // nicht ausgezahlt - das ist die Summe, die am Monatsende fällig wird.
      if (r.lead_status === 'approved' || r.lead_status === 'billed') {
        if (r.partner_payout === null) anyPayoutMissing = true;
        const payout = r.partner_payout || 0;
        totalOpenProvision += payout;
        byPartner[r.partner_user_id].openProvision += payout;
        byProduct[r.product_id].openProvision += payout;
      } else if (r.lead_status === 'paid') {
        const payout = r.partner_payout || 0;
        totalPaidProvision += payout;
        byPartner[r.partner_user_id].paidProvision += payout;
        byProduct[r.product_id].paidProvision += payout;
      }
    }

    const partnerOrder = Object.keys(byPartner).sort((a, b) => byPartner[a].name.localeCompare(byPartner[b].name));
    const productOrder = Object.keys(byProduct).sort((a, b) => byProduct[a].name.localeCompare(byProduct[b].name));

    const csvParams = new URLSearchParams({ partner_user_id: partnerUserId || '', product_id: productId || '', from, to }).toString();

    content += `
      <div class="stats-grid" style="margin-bottom:24px;">
        <div class="stat-card"><div class="stat-number">${rows.length}</div><div class="stat-label">Geliefert gesamt</div></div>
        <div class="stat-card" style="border-left-color:var(--error);"><div class="stat-number">${totalCounts.cancelled || 0}</div><div class="stat-label">Storno</div></div>
        <div class="stat-card" style="border-left-color:var(--warning);"><div class="stat-number">${totalCounts.duplicate || 0}</div><div class="stat-label">Dubletten</div></div>
        <div class="stat-card" style="border-left-color:var(--primary);"><div class="stat-number">${fmtEuro(totalOpenProvision)}</div><div class="stat-label">Offene Provision (noch zu zahlen)${anyPayoutMissing ? ' *' : ''}</div></div>
        <div class="stat-card" style="border-left-color:var(--success);"><div class="stat-number">${fmtEuro(totalPaidProvision)}</div><div class="stat-label">Bereits ausgezahlt</div></div>
      </div>
      ${anyPayoutMissing ? '<p style="color:var(--warning);font-size:0.85rem;margin-top:-16px;margin-bottom:24px;">* Für mindestens ein Projekt ist noch kein Vergütungssatz hinterlegt - diese Leads fehlen in der Summe.</p>' : ''}

      <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:24px;box-shadow:var(--shadow-sm);">
        <h3 style="margin-bottom:16px;">Gesamtübersicht nach Status</h3>
        ${buildStatusBreakdownTable('Alle', { all: { name: 'Gesamt', total: rows.length, counts: totalCounts } }, ['all'])}
      </div>

      <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:24px;box-shadow:var(--shadow-sm);overflow-x:auto;">
        <h3 style="margin-bottom:16px;">Pro Partner</h3>
        ${partnerOrder.length ? buildStatusBreakdownTable('Partner', byPartner, partnerOrder, true) : '<p style="color:var(--gray-500);">Keine Treffer.</p>'}
      </div>

      <div style="background:var(--white);border-radius:var(--radius);padding:24px;margin-bottom:24px;box-shadow:var(--shadow-sm);overflow-x:auto;">
        <h3 style="margin-bottom:16px;">Pro Projekt</h3>
        ${productOrder.length ? buildStatusBreakdownTable('Projekt', byProduct, productOrder, true) : '<p style="color:var(--gray-500);">Keine Treffer.</p>'}
      </div>

      <div style="background:var(--white);border-radius:var(--radius);padding:24px;box-shadow:var(--shadow-sm);">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <h3>Einzelaufstellung (${rows.length} Datensätze)</h3>
          <a href="/admin/provisionen/export?${csvParams}" class="btn btn-outline btn-sm">Als CSV exportieren</a>
        </div>
        <table class="data-table" style="font-size:0.85rem;">
          <thead><tr><th>Datum</th><th>Partner</th><th>Projekt</th><th>Name/Firma</th><th>PLZ/Ort</th><th>Status</th><th>Grund</th></tr></thead>
          <tbody>`;
    for (const r of rows) {
      const nameDisplay = r.lead_type === 'b2b'
        ? (r.company_name || r.contact_lastname || '-')
        : `${r.contact_lastname || ''} ${r.contact_firstname || ''}`.trim() || '-';
      content += `
            <tr>
              <td>${new Date(r.created_at).toLocaleDateString('de-DE')}</td>
              <td>${r.partner_first_name} ${r.partner_last_name}</td>
              <td>${r.product_name}</td>
              <td>${nameDisplay}</td>
              <td>${r.postal_code || ''} ${r.city || ''}</td>
              <td>${LEAD_STATUS_LABELS[r.lead_status] || r.lead_status}</td>
              <td>${r.cancel_reason || '-'}</td>
            </tr>`;
    }
    content += `
          </tbody>
        </table>
      </div>`;
  } else {
    content += `<div class="empty-state"><p>Zeitraum wählen, um die Auswertung zu sehen (Partner/Projekt optional).</p></div>`;
  }

  renderAdmin(req, res, content, 'provisionen');
});

router.get('/provisionen/export', (req, res) => {
  const db = getDb();
  const partnerUserId = parseInt(req.query.partner_user_id) || null;
  const productId = parseInt(req.query.product_id) || null;
  const from = req.query.from || '';
  const to = req.query.to || '';
  if (!from || !to) return res.redirect('/admin/provisionen');

  const rows = db.prepare(`
    SELECT lp.lead_type, lp.company_name, lp.contact_lastname, lp.contact_firstname,
           lp.street, lp.house_number, lp.postal_code, lp.city, lp.phone, lp.email,
           lp.lead_status, lp.cancel_reason, lp.created_at,
           pr.name as product_name, u.first_name as partner_first_name, u.last_name as partner_last_name
    FROM lead_pool lp
    JOIN lead_imports li ON lp.import_id = li.id
    JOIN lead_products pr ON lp.product_id = pr.id
    JOIN users u ON li.partner_user_id = u.id
    WHERE li.imported_at >= ? AND li.imported_at <= ?
      AND (? IS NULL OR li.partner_user_id = ?)
      AND (? IS NULL OR lp.product_id = ?)
    ORDER BY u.last_name, pr.name, lp.created_at
  `).all(from + ' 00:00:00', to + ' 23:59:59', partnerUserId, partnerUserId, productId, productId);

  let csv = 'Datum;Partner;Produkt;Firma;Nachname;Vorname;Strasse;Hausnummer;PLZ;Ort;Telefon;Email;Status;Grund\n';
  for (const r of rows) {
    csv += [
      new Date(r.created_at).toLocaleDateString('de-DE'),
      `${r.partner_first_name} ${r.partner_last_name}`, r.product_name, r.company_name, r.contact_lastname, r.contact_firstname,
      r.street, r.house_number, r.postal_code, r.city, r.phone, r.email,
      LEAD_STATUS_LABELS[r.lead_status] || r.lead_status, r.cancel_reason,
    ].map(csvEscape).join(';') + '\n';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="lead-reporting_${from}_${to}.csv"`);
  res.send('﻿' + csv);
});

module.exports = router;
