const express = require('express');
const router = express.Router();
const { getDb } = require('../database');
const { ALLE_BUNDESLAENDER } = require('../lib/plzBundesland');

const TIER_ROWS = [
  { tier: 1, label: 'Frisch', column: 'price' },
  { tier: 2, label: '2. Nutzung', column: 'price_tier2' },
  { tier: 3, label: '3. Nutzung', column: 'price_tier3' },
  { tier: 4, label: 'Exklusiv', column: 'price_exclusive' },
];

// Tier 2/3 können nicht auf Abruf produziert werden (sie entstehen erst,
// wenn genau dieser Datensatz schon 1x bzw. 2x verkauft wurde) - deshalb nur
// kaufbar, wenn im Pool tatsächlich ein Datensatz in diesem Verkaufsstand liegt.
// Tier 1 (Frisch) und Tier 4 (Exklusiv) sind immer bestellbar (Produktion auf Abruf).
function getTierAvailability(db) {
  const rows = db.prepare(`
    SELECT product_id, current_assignments, bundesland, COUNT(*) as cnt
    FROM lead_pool
    WHERE lead_status = 'pending' AND exclusive_locked_until IS NULL AND current_assignments IN (1, 2)
    GROUP BY product_id, current_assignments, bundesland
  `).all();
  const map = {};
  for (const r of rows) {
    if (!map[r.product_id]) map[r.product_id] = {};
    if (!map[r.product_id][r.current_assignments]) map[r.product_id][r.current_assignments] = { total: 0, byBundesland: {} };
    map[r.product_id][r.current_assignments].total += r.cnt;
    if (r.bundesland) map[r.product_id][r.current_assignments].byBundesland[r.bundesland] = r.cnt;
  }
  return map;
}

function buildCategoriesHtml(products, showActions, availability = {}) {
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
      const activeTiers = TIER_ROWS.filter(t => p[t.column] > 0);
      const prodAvail = availability[p.id] || {};
      const tierStock = (t) => prodAvail[t.tier - 1] || { total: 0, byBundesland: {} };
      const tierHasStock = (t) => t.tier === 1 || t.tier === 4 || tierStock(t).total > 0;
      // Nächstfrischere verfügbare Stufe als Alternative vorschlagen, wenn eine
      // Stufe (noch) nicht auf Lager ist (z.B. 3. Nutzung leer -> 2. Nutzung
      // vorschlagen, falls vorhanden, sonst 1. Nutzung).
      const suggestFallback = (t) => {
        const candidates = activeTiers
          .filter(o => o.tier < t.tier && o.tier !== 4 && tierHasStock(o))
          .sort((a, b) => b.tier - a.tier);
        return candidates[0] || null;
      };
      // 1./4. (Produktion auf Abruf): alle Bundesländer wählbar.
      // 2./3.: nur Bundesländer, in denen wirklich ein Datensatz auf dieser
      // Stufe liegt - sonst könnten wir die Regionsauswahl nicht einlösen.
      const regionOptionsFor = (t) => {
        const names = (t.tier === 1 || t.tier === 4) ? ALLE_BUNDESLAENDER : Object.keys(tierStock(t).byBundesland).sort();
        const options = names.map(n => `<option value="${n}">${n}</option>`).join('');
        return `<option value="bundesweit" selected>Bundesweit</option>${options}`;
      };
      // Headline-Preis der Kachel ("ab X €") ist immer der günstigste reguläre
      // Tarif (in der Praxis die 3. Nutzung, falls vorhanden) - Exklusiv (Tier 4)
      // ist immer der teuerste Tarif und wird hier bewusst nicht einbezogen.
      const starterCandidates = activeTiers.filter(t => t.tier !== 4);
      const startingTier = starterCandidates.length
        ? starterCandidates.reduce((min, t) => p[t.column] < p[min.column] ? t : min)
        : activeTiers[0];
      const tierBlock = (t, multi) => {
        const inStock = tierHasStock(t);
        const fallback = inStock ? null : suggestFallback(t);
        const priceLabel = multi
          ? `${t.label} — ${p[t.column].toFixed(2).replace('.', ',')}&nbsp;€ <small>/ Lead</small>`
          : `ab ${p[t.column].toFixed(2).replace('.', ',')}&nbsp;€ <small>/ Lead</small>`;
        return `
        <div class="${multi ? 'lead-tier-row' : ''}">
          <div class="lead-price">${priceLabel}</div>
          ${showActions ? (inStock ? `
            <form method="POST" action="/cart/add" class="lead-card-actions" style="margin-top:16px;flex-wrap:wrap;">
              <input type="hidden" name="productId" value="${p.id}">
              <input type="hidden" name="tier" value="${t.tier}">
              <select name="bundesland" class="qty-input" style="flex:1 1 100%;margin-bottom:8px;">${regionOptionsFor(t)}</select>
              <input type="number" name="quantity" value="1" min="1" max="100" class="qty-input">
              <button type="submit" class="btn btn-primary btn-sm">In den Warenkorb</button>
            </form>
          ` : `<div style="margin-top:16px;">
              <div style="color:var(--gray-500);font-size:0.85rem;">Noch keine ${t.label}-Daten vorhanden.</div>
              ${fallback ? `<div style="color:var(--gray-500);font-size:0.85rem;margin-top:4px;">Du kannst stattdessen frischere Leads zur ${fallback.label === 'Frisch' ? '1. Nutzung' : fallback.label} kaufen.</div>` : ''}
            </div>`) : ''}
        </div>`;
      };
      html += `
        <div class="lead-card">
          ${p.image_url ? `<div class="lead-card-image"><img src="${p.image_url}" alt="${p.name}" loading="lazy"></div>` : ''}
          <h4>${p.name}</h4>
          <p class="lead-desc">${p.description || ''}</p>
          ${activeTiers.length === 0
            ? '<div class="lead-price"><span style="color:var(--gray-500);">Preis folgt in Kürze</span></div>'
            : activeTiers.length === 1
              ? tierBlock(activeTiers[0], false)
              : `<div class="lead-price">ab ${p[startingTier.column].toFixed(2).replace('.', ',')}&nbsp;€ <small>/ Lead</small></div>
                 ${activeTiers.map(t => tierBlock(t, true)).join('')}`}
        </div>`;
    }
    html += '</div></div>';
  }
  return html;
}

router.get('/', (req, res) => {
  const db = getDb();
  const products = db.prepare('SELECT * FROM lead_products WHERE active = 1').all();
  const categoriesHtml = buildCategoriesHtml(products, false, getTierAvailability(db));
  req.app.locals.renderPage(res, 'index.html', {
    pageTitle: 'Leads kaufen – telefonisch qualifiziert',
    metaDescription: 'Leads kaufen ab 19,90 € – telefonisch qualifiziert, mit Gesprächsaufnahme als Nachweis. 14 Branchen, keine Vertragslaufzeit, keine Grundgebühr.',
    categoriesHtml,
  });
});

router.get('/datenschutz', (req, res) => {
  req.app.locals.renderPage(res, 'datenschutz.html', {
    pageTitle: 'Datenschutzerklärung',
    metaDescription: 'Datenschutzerklärung von LeadArea, einer Marke der SwissLeads AG.',
  });
});

router.get('/impressum', (req, res) => {
  req.app.locals.renderPage(res, 'impressum.html', {
    pageTitle: 'Impressum',
    metaDescription: 'Impressum / Anbieterkennzeichnung von LeadArea, einer Marke der SwissLeads AG.',
  });
});

router.get('/agb', (req, res) => {
  req.app.locals.renderPage(res, 'agb.html', {
    pageTitle: 'AGB',
    metaDescription: 'Allgemeine Geschäftsbedingungen von LeadArea, einer Marke der SwissLeads AG.',
  });
});

router.get('/marktplatz', (req, res) => {
  const db = getDb();
  const products = db.prepare('SELECT * FROM lead_products WHERE active = 1').all();
  const isLoggedIn = !!(req.session && req.session.userId);
  const categoriesHtml = buildCategoriesHtml(products, isLoggedIn, getTierAvailability(db));
  const alertHtml = !isLoggedIn
    ? '<div class="alert alert-warning" style="margin-bottom:32px;">Um Leads zu bestellen, musst du dich zuerst <a href="/register" style="color:var(--primary);font-weight:700;">registrieren</a> oder <a href="/login" style="color:var(--primary);font-weight:700;">einloggen</a>.</div>'
    : '';
  req.app.locals.renderPage(res, 'marketplace.html', {
    pageTitle: 'Marktplatz – Leads aus 14 Branchen',
    metaDescription: 'Bestelle telefonisch qualifizierte Leads direkt im Marktplatz – ab 19,90 € pro Lead, sofort verfügbar, ohne Mindestabnahme.',
    categoriesHtml,
    alertHtml,
  });
});

module.exports = router;
