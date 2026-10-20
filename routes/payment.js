const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { requireAuth } = require('../middleware/auth');
const { getVatForCountry, formatVatRate } = require('../lib/vat');
const { markOrderPaid } = require('../lib/orderPayment');

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PUB = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID || '';
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET || '';
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'sandbox'; // 'sandbox' oder 'live'

const stripe = STRIPE_SECRET ? require('stripe')(STRIPE_SECRET) : null;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Hilfsfunktion: Bestellung laden + prüfen ob sie dem Nutzer gehört
function getOrder(orderId, userId) {
  const db = getDb();
  return db.prepare('SELECT o.*, u.first_name, u.last_name, u.email, u.country FROM orders o JOIN users u ON o.user_id = u.id WHERE o.id = ? AND o.user_id = ?').get(orderId, userId);
}

function getOrderItems(orderId) {
  const db = getDb();
  return db.prepare(`
    SELECT oi.*, lp.name as product_name FROM order_items oi
    JOIN lead_products lp ON oi.product_id = lp.id
    WHERE oi.order_id = ?
  `).all(orderId);
}

// markOrderPaid() kommt jetzt aus lib/orderPayment.js (geteilt mit dem
// manuellen Zahlungseingang-Bestätigen im Admin-Bereich, siehe routes/admin.js).
// Hinweis: Diese Stripe/PayPal-Zahlungsseite ist aktuell NICHT in den normalen
// Bestellfluss eingebunden (siehe routes/orders.js - Vorkasse per Überweisung
// ist seit 2026-10-13 der aktive Weg) und nur für eine mögliche spätere
// Online-Zahlungs-Stufe vorbereitet/erreichbar.

// ─── ZAHLUNGSSEITE ──────────────────────────────────────────────────────────

router.get('/payment/:orderId', requireAuth, (req, res) => {
  const order = getOrder(req.params.orderId, req.session.userId);
  if (!order || order.status !== 'pending') return res.redirect('/dashboard/orders');

  const items = getOrderItems(order.id);
  const demoMode = !STRIPE_SECRET && !PAYPAL_CLIENT_ID;

  const vat = getVatForCountry(order.country);
  const netSubtotal = items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
  const vatAmount = Math.round((order.total - netSubtotal) * 100) / 100;
  const vatRowLabel = vat.applies
    ? `zzgl. ${formatVatRate(vat.rate)}% MwSt.`
    : 'MwSt. (steuerfreie Auslandsleistung)';

  let itemsHtml = items.map(i => `
    <div style="display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid rgba(255,255,255,0.08);">
      <span>${i.product_name} <small style="color:var(--gray-300);">× ${i.quantity}</small></span>
      <strong>${(i.unit_price * i.quantity).toFixed(2).replace('.', ',')} €</strong>
    </div>`).join('');

  const paypalSdkUrl = PAYPAL_CLIENT_ID
    ? `https://www.paypal.com/sdk/js?client-id=${PAYPAL_CLIENT_ID}&currency=EUR`
    : '';

  const demoBtn = demoMode ? `
    <div style="background:rgba(255,255,255,0.05);border:2px dashed rgba(255,255,255,0.25);border-radius:12px;padding:20px;text-align:center;margin-top:8px;">
      <p style="color:var(--gray-300);font-size:0.85rem;margin-bottom:12px;">⚙️ Demo-Modus — Zahlungsanbieter noch nicht konfiguriert</p>
      <form method="POST" action="/payment/${order.id}/demo">
        <button type="submit" class="btn btn-outline">Zahlung simulieren (Test)</button>
      </form>
    </div>` : '';

  const stripeBtn = STRIPE_SECRET ? `
    <form method="POST" action="/payment/${order.id}/stripe">
      <button type="submit" class="btn btn-primary btn-block" style="display:flex;align-items:center;justify-content:center;gap:10px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z"/></svg>
        Mit Kreditkarte bezahlen
      </button>
    </form>` : '';

  const paypalBtn = PAYPAL_CLIENT_ID ? `
    <script src="${paypalSdkUrl}"></script>
    <div id="paypal-button-container"></div>
    <script>
      paypal.Buttons({
        createOrder: () => fetch('/payment/${order.id}/paypal/create', { method: 'POST' }).then(r => r.json()).then(d => d.id),
        onApprove: (data) => fetch('/payment/${order.id}/paypal/capture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderID: data.orderID })
        }).then(r => r.json()).then(d => { if (d.success) window.location = '/dashboard/orders?paid=${order.id}'; }),
        onError: (err) => { alert('PayPal-Fehler: ' + err); }
      }).render('#paypal-button-container');
    </script>` : '';

  const content = `
    <div class="dark-area" style="max-width:560px;margin:0 auto;padding:40px 20px;">
      <h2 style="font-size:1.5rem;margin-bottom:8px;color:var(--white);">Bestellung #${order.id} bezahlen</h2>
      <p style="color:var(--gray-300);margin-bottom:24px;">${order.first_name} ${order.last_name} &middot; ${order.email}</p>

      <div style="background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:var(--radius);padding:24px;margin-bottom:24px;">
        <h3 style="margin-bottom:16px;font-size:1rem;color:var(--gray-300);text-transform:uppercase;letter-spacing:0.05em;">Bestellübersicht</h3>
        ${itemsHtml}
        <div style="display:flex;justify-content:space-between;padding:10px 0 0;color:var(--gray-300);font-size:0.9rem;">
          <span>Zwischensumme (netto)</span>
          <span>${netSubtotal.toFixed(2).replace('.', ',')} €</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:4px 0;color:var(--gray-300);font-size:0.9rem;">
          <span>${vatRowLabel}</span>
          <span>${vatAmount.toFixed(2).replace('.', ',')} €</span>
        </div>
        <div style="display:flex;justify-content:space-between;padding:14px 0 0;font-size:1.2rem;font-weight:800;color:var(--white);">
          <span>Gesamt</span>
          <span>${order.total.toFixed(2).replace('.', ',')} €</span>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:12px;">
        ${stripeBtn}
        ${paypalBtn}
        ${demoBtn}
      </div>

      <p style="text-align:center;margin-top:20px;font-size:0.8rem;color:var(--gray-300);">
        <a href="/checkout" style="color:var(--gray-300);">← Zurück zum Warenkorb</a>
      </p>
    </div>`;

  req.app.locals.renderPage(res, 'payment.html', { pageTitle: `Zahlung – Bestellung #${order.id}`, content });
});

// ─── DEMO-ZAHLUNG (nur ohne echte Keys) ─────────────────────────────────────

router.post('/payment/:orderId/demo', requireAuth, (req, res) => {
  if (STRIPE_SECRET || PAYPAL_CLIENT_ID) return res.redirect(`/payment/${req.params.orderId}`);
  const order = getOrder(req.params.orderId, req.session.userId);
  if (!order || order.status !== 'pending') return res.redirect('/dashboard/orders');
  markOrderPaid(order.id);
  res.redirect('/dashboard/orders?paid=' + order.id);
});

// ─── STRIPE ─────────────────────────────────────────────────────────────────

router.post('/payment/:orderId/stripe', requireAuth, async (req, res) => {
  if (!stripe) return res.redirect(`/payment/${req.params.orderId}`);
  const order = getOrder(req.params.orderId, req.session.userId);
  if (!order || order.status !== 'pending') return res.redirect('/dashboard/orders');

  const items = getOrderItems(order.id);
  const vat = getVatForCountry(order.country);
  const lineItems = items.map(i => ({
    price_data: {
      currency: 'eur',
      product_data: { name: i.product_name },
      unit_amount: Math.round(i.unit_price * (1 + vat.rate) * 100),
    },
    quantity: i.quantity,
  }));

  try {
    const session = await stripe.checkout.sessions.create({
      // sepa_debit braucht IBAN+Mandat - Stripe sammelt das automatisch auf der
      // Checkout-Seite. Lastschrift braucht Tage bis zur Kontobuchung, deshalb ist
      // payment_status direkt nach dem Checkout noch 'unpaid' (siehe /stripe/success
      // und den async_payment_*-Webhook weiter unten) - Leads werden erst produziert/
      // zugewiesen, wenn das Geld tatsächlich eingegangen ist.
      payment_method_types: ['card', 'sepa_debit'],
      line_items: lineItems,
      mode: 'payment',
      customer_email: order.email,
      metadata: { orderId: String(order.id) },
      success_url: `${BASE_URL}/payment/${order.id}/stripe/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/payment/${order.id}`,
    });
    res.redirect(303, session.url);
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.redirect(`/payment/${order.id}`);
  }
});

router.get('/payment/:orderId/stripe/success', requireAuth, async (req, res) => {
  if (!stripe) return res.redirect('/dashboard/orders');
  const order = getOrder(req.params.orderId, req.session.userId);
  if (!order) return res.redirect('/dashboard/orders');

  let paidNow = false;
  try {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    if (session.payment_status === 'paid' && order.status === 'pending') {
      markOrderPaid(order.id);
      paidNow = true;
    }
  } catch (err) {
    console.error('Stripe success verify error:', err.message);
  }
  // Bei SEPA-Lastschrift ist payment_status direkt nach dem Checkout noch 'unpaid'
  // (Buchung dauert Tage) - dann NICHT "bezahlt" vorgaukeln, sondern auf die
  // ausstehende Zahlung hinweisen. markOrderPaid() kommt in dem Fall erst später
  // über den async_payment_succeeded-Webhook unten.
  const param = paidNow || order.status === 'paid' || order.status === 'delivered' ? 'paid' : 'pending';
  res.redirect(`/dashboard/orders?${param}=${order.id}`);
});

// Stripe Webhook (für zuverlässige Bestätigung)
router.post('/webhooks/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.sendStatus(200);
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.sendStatus(400);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status === 'paid' && session.metadata?.orderId) {
      const db = getDb();
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(parseInt(session.metadata.orderId));
      if (order && order.status === 'pending') markOrderPaid(order.id);
    }
  } else if (event.type === 'checkout.session.async_payment_succeeded') {
    // Feuert bei SEPA-Lastschrift (& anderen verzögerten Zahlarten), sobald das
    // Geld tatsächlich eingegangen ist - erst DANN Leads produzieren/zuweisen.
    const session = event.data.object;
    if (session.metadata?.orderId) {
      const db = getDb();
      const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(parseInt(session.metadata.orderId));
      if (order && order.status === 'pending') markOrderPaid(order.id);
    }
  } else if (event.type === 'checkout.session.async_payment_failed') {
    // SEPA-Lastschrift wurde zurückgebucht/ist fehlgeschlagen - Bestellung bewusst
    // NICHT automatisch stornieren (könnte ein vorübergehendes Problem sein),
    // nur geloggt für manuelle Prüfung.
    const session = event.data.object;
    console.error('[Stripe] async_payment_failed für Bestellung', session.metadata?.orderId, '- manuell prüfen (z.B. SEPA-Rücklastschrift)');
  }
  res.sendStatus(200);
});

// ─── PAYPAL ──────────────────────────────────────────────────────────────────

async function getPayPalToken() {
  const base = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const resp = await fetch(`${base}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await resp.json();
  return { token: data.access_token, base };
}

router.post('/payment/:orderId/paypal/create', requireAuth, async (req, res) => {
  if (!PAYPAL_CLIENT_ID) return res.status(400).json({ error: 'PayPal nicht konfiguriert' });
  const order = getOrder(req.params.orderId, req.session.userId);
  if (!order || order.status !== 'pending') return res.status(400).json({ error: 'Ungültige Bestellung' });

  try {
    const { token, base } = await getPayPalToken();
    const resp = await fetch(`${base}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          reference_id: String(order.id),
          amount: { currency_code: 'EUR', value: order.total.toFixed(2) },
          description: `Leadpuls Bestellung #${order.id}`,
        }],
      }),
    });
    const data = await resp.json();
    res.json({ id: data.id });
  } catch (err) {
    console.error('PayPal create error:', err.message);
    res.status(500).json({ error: 'PayPal-Fehler' });
  }
});

router.post('/payment/:orderId/paypal/capture', requireAuth, async (req, res) => {
  if (!PAYPAL_CLIENT_ID) return res.status(400).json({ error: 'PayPal nicht konfiguriert' });
  const order = getOrder(req.params.orderId, req.session.userId);
  if (!order || order.status !== 'pending') return res.status(400).json({ error: 'Ungültige Bestellung' });

  try {
    const { token, base } = await getPayPalToken();
    const resp = await fetch(`${base}/v2/checkout/orders/${req.body.orderID}/capture`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
    const data = await resp.json();
    if (data.status === 'COMPLETED') {
      markOrderPaid(order.id);
      return res.json({ success: true });
    }
    res.json({ success: false });
  } catch (err) {
    console.error('PayPal capture error:', err.message);
    res.status(500).json({ error: 'PayPal-Fehler' });
  }
});

module.exports = router;
