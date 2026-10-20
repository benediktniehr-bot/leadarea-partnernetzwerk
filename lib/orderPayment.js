const { getDb } = require('../database');
const { deliverLeads } = require('./deliverLeads');
const { sendPaymentReceivedEmail } = require('./mailer');

function getOrderItems(db, orderId) {
  return db.prepare(`
    SELECT oi.*, lp.name as product_name FROM order_items oi
    JOIN lead_products lp ON oi.product_id = lp.id
    WHERE oi.order_id = ?
  `).all(orderId);
}

// Wird aufgerufen, sobald eine Zahlung bestätigt ist (aktuell: Admin bestätigt
// manuell den Eingang der Überweisung; perspektivisch auch von einem künftigen
// Online-Zahlungsweg wie Stripe nutzbar). Setzt die Bestellung auf 'paid',
// löst die Leadproduktion/-zuweisung aus und benachrichtigt den Käufer.
function markOrderPaid(orderId) {
  const db = getDb();
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND status = 'pending'").get(orderId);
  if (!order) return false; // schon bezahlt/storniert oder existiert nicht - nichts tun

  db.prepare("UPDATE orders SET status = 'paid' WHERE id = ?").run(orderId);
  deliverLeads(orderId);

  const buyer = db.prepare('SELECT first_name, last_name, email FROM users WHERE id = ?').get(order.user_id);
  if (buyer) {
    sendPaymentReceivedEmail({
      buyerName: `${buyer.first_name} ${buyer.last_name}`,
      buyerEmail: buyer.email,
      orderId,
    }).catch(err => console.error('[Mailer] Zahlungseingang-Mail Fehler:', err.message));
  }

  return true;
}

module.exports = { markOrderPaid, getOrderItems };
