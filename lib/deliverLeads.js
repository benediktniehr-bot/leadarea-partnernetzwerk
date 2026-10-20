const { getDb } = require('../database');
const { sendLeadsReadyMail } = require('./mailer');

// Tier 4 = Exklusiv: nur komplett frische, nie exklusiv gesperrte Datensätze;
// Zuweisung sperrt den Datensatz dauerhaft (max_assignments=1) + 6 Monate
// Sperrvermerk (exclusive_locked_until) für die Kunden-Zusage.
function assignLeadsToItem(db, orderItemId, userId, productId, count, tier, bundesland = null) {
  const isExclusive = tier === 4;
  const regionFilter = bundesland ? 'AND bundesland = ?' : '';

  const leads = isExclusive
    ? db.prepare(`
        SELECT id FROM lead_pool
        WHERE product_id = ?
          AND lead_status = 'pending'
          AND current_assignments = 0
          AND exclusive_locked_until IS NULL
          ${regionFilter}
          AND id NOT IN (SELECT pool_lead_id FROM lead_assignments WHERE user_id = ?)
        ORDER BY created_at ASC
        LIMIT ?
      `).all(...[productId, ...(bundesland ? [bundesland] : []), userId, count])
    : db.prepare(`
        SELECT id FROM lead_pool
        WHERE product_id = ?
          AND lead_status = 'pending'
          AND current_assignments = ?
          AND max_assignments >= ?
          AND exclusive_locked_until IS NULL
          ${regionFilter}
          AND id NOT IN (SELECT pool_lead_id FROM lead_assignments WHERE user_id = ?)
        ORDER BY created_at ASC
        LIMIT ?
      `).all(...[productId, tier - 1, tier, ...(bundesland ? [bundesland] : []), userId, count]);

  if (leads.length === 0) return 0;

  const insertAssignment = db.prepare(
    'INSERT INTO lead_assignments (pool_lead_id, user_id, order_item_id) VALUES (?, ?, ?)'
  );
  const updatePool = isExclusive
    ? db.prepare(`
        UPDATE lead_pool
        SET current_assignments = current_assignments + 1,
            max_assignments = 1,
            exclusive_locked_until = datetime('now', '+6 months')
        WHERE id = ?
      `)
    : db.prepare(
        'UPDATE lead_pool SET current_assignments = current_assignments + 1 WHERE id = ?'
      );

  db.transaction(() => {
    for (const lead of leads) {
      insertAssignment.run(lead.id, userId, orderItemId);
      updatePool.run(lead.id);
    }
  })();

  return leads.length;
}

function checkOrderComplete(db, orderId) {
  const items = db.prepare('SELECT id FROM order_items WHERE order_id = ?').all(orderId);
  const allDone = items.every(item => {
    const q = db.prepare('SELECT * FROM delivery_queue WHERE order_item_id = ?').get(item.id);
    return q && q.quantity_delivered >= q.quantity_ordered;
  });
  if (allDone) {
    db.prepare("UPDATE orders SET status = 'delivered' WHERE id = ?").run(orderId);
  }
}

// Wird nach Zahlungsbestätigung aufgerufen
function deliverLeads(orderId) {
  const db = getDb();
  const order = db.prepare("SELECT * FROM orders WHERE id = ? AND status = 'paid'").get(orderId);
  if (!order) return;

  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);

  db.transaction(() => {
    for (const item of items) {
      const existing = db.prepare('SELECT * FROM delivery_queue WHERE order_item_id = ?').get(item.id);
      const alreadyDelivered = existing ? existing.quantity_delivered : 0;
      const remaining = item.quantity - alreadyDelivered;
      if (remaining <= 0) continue;

      const delivered = assignLeadsToItem(db, item.id, order.user_id, item.product_id, remaining, item.tier, item.bundesland);
      const totalDelivered = alreadyDelivered + delivered;

      if (existing) {
        db.prepare('UPDATE delivery_queue SET quantity_delivered = ? WHERE id = ?')
          .run(totalDelivered, existing.id);
      } else {
        db.prepare(`
          INSERT INTO delivery_queue (order_item_id, user_id, product_id, quantity_ordered, quantity_delivered, tier, bundesland)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(item.id, order.user_id, item.product_id, item.quantity, totalDelivered, item.tier, item.bundesland);
      }
    }
  })();

  checkOrderComplete(db, orderId);
}

// Wird nach jedem Lead-Import aufgerufen — füllt offene Warteschlangen (FIFO nach Bestelldatum)
async function fillDeliveryQueue() {
  const db = getDb();
  const pending = db.prepare(`
    SELECT dq.*, oi.order_id
    FROM delivery_queue dq
    JOIN order_items oi ON dq.order_item_id = oi.id
    JOIN orders o ON oi.order_id = o.id
    WHERE dq.quantity_delivered < dq.quantity_ordered
      AND o.status = 'paid'
    ORDER BY dq.created_at ASC
  `).all();

  for (const entry of pending) {
    const remaining = entry.quantity_ordered - entry.quantity_delivered;
    const delivered = assignLeadsToItem(db, entry.order_item_id, entry.user_id, entry.product_id, remaining, entry.tier, entry.bundesland);
    if (delivered === 0) continue;

    const newTotal = entry.quantity_delivered + delivered;
    db.prepare('UPDATE delivery_queue SET quantity_delivered = ? WHERE id = ?')
      .run(newTotal, entry.id);

    checkOrderComplete(db, entry.order_id);

    // Käufer per E-Mail benachrichtigen
    const user = db.prepare('SELECT email, first_name FROM users WHERE id = ?').get(entry.user_id);
    const product = db.prepare('SELECT name FROM lead_products WHERE id = ?').get(entry.product_id);
    if (user && product) {
      sendLeadsReadyMail({
        toEmail: user.email,
        firstName: user.first_name,
        productName: product.name,
        count: delivered,
      }).catch(err => console.error('[Mailer] Fehler beim Versand:', err.message));
    }
  }
}

module.exports = { deliverLeads, fillDeliveryQueue, assignLeadsToItem };
