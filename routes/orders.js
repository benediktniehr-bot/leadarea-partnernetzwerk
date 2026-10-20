const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { getVatForCountry, formatVatRate } = require('../lib/vat');
const { BANK_DETAILS } = require('../lib/companyInfo');
const { sendPaymentRequestEmail, sendOrderNotification } = require('../lib/mailer');
const { generateInvoicePdfBuffer } = require('../lib/invoicePdf');
const { TIER_LABELS } = require('../lib/tierLabels');

const TIER_PRICE_COLUMNS = { 1: 'price', 2: 'price_tier2', 3: 'price_tier3', 4: 'price_exclusive' };

router.post('/cart/add', requireAuth, (req, res) => {
  const productId = parseInt(req.body.productId);
  const tier = [1, 2, 3, 4].includes(parseInt(req.body.tier)) ? parseInt(req.body.tier) : 1;
  const quantity = Math.max(1, Math.min(100, parseInt(req.body.quantity) || 1));
  // 'bundesweit' / leer = keine Regionseinschränkung
  const bundesland = (req.body.bundesland && req.body.bundesland !== 'bundesweit') ? req.body.bundesland : null;

  const db = getDb();
  const product = db.prepare('SELECT * FROM lead_products WHERE id = ? AND active = 1').get(productId);
  const price = product ? product[TIER_PRICE_COLUMNS[tier]] : 0;
  if (!product || !(price > 0)) return res.redirect('/marktplatz');

  if (!req.session.cart) req.session.cart = [];

  const regionLabel = bundesland ? ` – ${bundesland}` : '';
  const existing = req.session.cart.find(item => item.productId === productId && item.tier === tier && item.bundesland === bundesland);
  if (existing) {
    existing.quantity += quantity;
  } else {
    req.session.cart.push({ productId, tier, bundesland, quantity, name: product.name + TIER_LABELS[tier] + regionLabel, price });
  }

  res.redirect('/checkout');
});

router.post('/cart/update', requireAuth, (req, res) => {
  const productId = parseInt(req.body.productId);
  const tier = parseInt(req.body.tier) || 1;
  const bundesland = req.body.bundesland || null;
  const quantity = parseInt(req.body.quantity);

  if (!req.session.cart) return res.redirect('/checkout');

  if (quantity <= 0) {
    req.session.cart = req.session.cart.filter(item => !(item.productId === productId && item.tier === tier && item.bundesland === bundesland));
  } else {
    const item = req.session.cart.find(item => item.productId === productId && item.tier === tier && item.bundesland === bundesland);
    if (item) item.quantity = Math.min(100, quantity);
  }

  res.redirect('/checkout');
});

router.post('/cart/remove', requireAuth, (req, res) => {
  const productId = parseInt(req.body.productId);
  const tier = parseInt(req.body.tier) || 1;
  const bundesland = req.body.bundesland || null;
  if (req.session.cart) {
    req.session.cart = req.session.cart.filter(item => !(item.productId === productId && item.tier === tier && item.bundesland === bundesland));
  }
  res.redirect('/checkout');
});

router.get('/checkout', requireAuth, (req, res) => {
  const cart = req.session.cart || [];
  let cartContent = '';

  const db0 = getDb();
  const buyer = db0.prepare('SELECT country FROM users WHERE id = ?').get(req.session.userId);
  const vat = getVatForCountry(buyer && buyer.country);

  if (cart.length === 0) {
    cartContent = `
      <div class="empty-state">
        <div class="empty-icon">🛒</div>
        <h3>Dein Warenkorb ist leer</h3>
        <p>Stöbere in unserem Marktplatz und füge Leads hinzu.</p>
        <a href="/marktplatz" class="btn btn-primary">Zum Marktplatz</a>
      </div>`;
  } else {
    const netTotal = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);
    const vatAmount = Math.round(netTotal * vat.rate * 100) / 100;
    const total = Math.round((netTotal + vatAmount) * 100) / 100;
    const vatRowLabel = vat.applies
      ? `zzgl. ${formatVatRate(vat.rate)}% MwSt.`
      : 'MwSt. (steuerfreie Auslandsleistung)';
    let itemsHtml = '';
    for (const item of cart) {
      const itemTotal = item.price * item.quantity;
      itemsHtml += `
        <div class="checkout-item">
          <div class="checkout-item-info">
            <h4>${item.name}</h4>
            <p>${item.price.toFixed(2).replace('.', ',')} € × ${item.quantity} Leads</p>
          </div>
          <div style="display:flex;align-items:center;gap:12px;">
            <form method="POST" action="/cart/update" style="display:flex;align-items:center;gap:8px;">
              <input type="hidden" name="productId" value="${item.productId}">
              <input type="hidden" name="tier" value="${item.tier}">
              <input type="hidden" name="bundesland" value="${item.bundesland || ''}">
              <input type="number" name="quantity" value="${item.quantity}" min="0" max="100" class="qty-input" style="width:60px;">
              <button type="submit" class="btn btn-outline btn-sm">Aktualisieren</button>
            </form>
            <form method="POST" action="/cart/remove">
              <input type="hidden" name="productId" value="${item.productId}">
              <input type="hidden" name="tier" value="${item.tier}">
              <input type="hidden" name="bundesland" value="${item.bundesland || ''}">
              <button type="submit" class="btn btn-danger btn-sm">✕</button>
            </form>
            <div class="checkout-item-price">${itemTotal.toFixed(2).replace('.', ',')} €</div>
          </div>
        </div>`;
    }

    cartContent = `
      <div class="checkout-layout">
        <div class="checkout-items">
          <h3 style="margin-bottom:20px;">Deine Leads</h3>
          ${itemsHtml}
        </div>
        <div class="checkout-summary">
          <h3 style="margin-bottom:20px;">Zusammenfassung</h3>
          <div style="margin-bottom:12px;color:var(--gray-500);font-size:0.9rem;">
            ${cart.reduce((s, i) => s + i.quantity, 0)} Leads in ${cart.length} Kategorie(n)
          </div>
          <div class="checkout-total">
            <div class="checkout-total-row" style="font-weight:400;color:var(--gray-500);font-size:0.9rem;">
              <span>Zwischensumme (netto)</span>
              <span>${netTotal.toFixed(2).replace('.', ',')} €</span>
            </div>
            <div class="checkout-total-row" style="font-weight:400;color:var(--gray-500);font-size:0.9rem;">
              <span>${vatRowLabel}</span>
              <span>${vatAmount.toFixed(2).replace('.', ',')} €</span>
            </div>
            <div class="checkout-total-row">
              <span>Gesamt</span>
              <span>${total.toFixed(2).replace('.', ',')} €</span>
            </div>
          </div>
          <p style="font-size:0.8rem;color:var(--gray-500);margin:12px 0;">Keine versteckten Kosten.</p>
          <form method="POST" action="/order/place">
            <button type="submit" class="btn btn-primary btn-block btn-lg">Jetzt bestellen</button>
          </form>
          <p style="font-size:0.75rem;color:var(--gray-500);margin-top:12px;text-align:center;">
            Keine Vertragsbindung. Jederzeit kündbar.
          </p>
        </div>
      </div>`;
  }

  req.app.locals.renderPage(res, 'checkout.html', { pageTitle: 'Warenkorb', cartContent, alertHtml: '' });
});

router.post('/order/place', requireAuth, (req, res) => {
  const cart = req.session.cart || [];
  if (cart.length === 0) return res.redirect('/checkout');

  const db = getDb();
  const buyer = db.prepare('SELECT company, first_name, last_name, email, street, house_number, postal_code, city, country FROM users WHERE id = ?').get(req.session.userId);
  const vat = getVatForCountry(buyer && buyer.country);
  const netTotal = Math.round(cart.reduce((sum, item) => sum + item.price * item.quantity, 0) * 100) / 100;
  const vatTotal = Math.round(netTotal * vat.rate * 100) / 100;
  const total = Math.round((netTotal + vatTotal) * 100) / 100;

  const placeOrder = db.transaction(() => {
    const order = db.prepare('INSERT INTO orders (user_id, status, total) VALUES (?, ?, ?)').run(req.session.userId, 'pending', total);
    const orderId = order.lastInsertRowid;
    const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price, tier, bundesland) VALUES (?, ?, ?, ?, ?, ?)');
    for (const item of cart) {
      insertItem.run(orderId, item.productId, item.quantity, item.price, item.tier, item.bundesland || null);
    }
    // Vorkasse-Modell: Rechnung wird sofort bei Bestellung erzeugt (nicht erst
    // nach Zahlung) - der Kunde überweist auf Basis dieser Rechnung.
    const invoice = db.prepare(`
      INSERT INTO invoices (order_id, user_id, net_total, vat_total, gross_total, vat_rate, country)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(orderId, req.session.userId, netTotal, vatTotal, total, vat.rate, buyer.country || null);
    return { orderId, invoiceId: invoice.lastInsertRowid };
  });

  const { orderId, invoiceId } = placeOrder();
  const items = cart.map(item => ({ product_name: item.name, quantity: item.quantity, unit_price: item.price }));
  req.session.cart = [];

  const invoiceNumber = `RE-${new Date().getFullYear()}-${String(invoiceId).padStart(6, '0')}`;
  const invoiceDate = new Date().toLocaleDateString('de-DE');

  let pdfBuffer;
  try {
    pdfBuffer = generateInvoicePdfBuffer({
      invoiceNumber,
      invoiceDate,
      orderId,
      orderStatus: 'pending',
      buyer,
      items,
      netTotal,
      vatTotal,
      grossTotal: total,
      vatRate: vat.rate,
      vatApplies: vat.applies,
    });
  } catch (err) {
    console.error('[InvoicePdf] Fehler bei PDF-Erzeugung, Mail geht ohne Anhang raus:', err.message);
  }

  sendPaymentRequestEmail({
    buyerName: `${buyer.first_name} ${buyer.last_name}`,
    buyerEmail: buyer.email,
    invoiceNumber,
    invoiceDate,
    orderId,
    items,
    netTotal,
    vatTotal,
    grossTotal: total,
    vatRate: vat.rate,
    vatApplies: vat.applies,
    bank: BANK_DETAILS,
    pdfBuffer,
  }).catch(err => console.error('[Mailer] Zahlungsaufforderung Fehler:', err.message));

  sendOrderNotification({
    buyerName: `${buyer.first_name} ${buyer.last_name}`,
    buyerEmail: buyer.email,
    orderId,
    items,
    total,
  }).catch(err => console.error('[Mailer] Order-Notify Fehler:', err.message));

  res.redirect('/dashboard/orders?invoiceSent=' + orderId);
});

module.exports = router;
