const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { initializeDatabase } = require('./database');
const { attachUser } = require('./middleware/auth');

const app = express();
const PORT = 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const DEFAULT_META_DESCRIPTION = 'LeadArea ist der Marktplatz für telefonisch qualifizierte Leads – ab 19,90 € pro Lead, ohne Vertragslaufzeit, mit Gesprächsaufnahme als Nachweis.';

initializeDatabase();

const SQLiteStore = require('connect-sqlite3')(session);

// Stripe Webhook braucht raw body — muss VOR express.json() registriert werden
const paymentRoutes = require('./routes/payment');
app.use('/webhooks/stripe', paymentRoutes);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: __dirname }),
  secret: 'leadpuls-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(attachUser);

// HARTE Sperre (nicht nur Nav-Link-Verstecken): Marktplatz/Preise sind streng
// vertraulich - Partner und QM-Mitarbeiter duerfen dort unter keinen
// Umstaenden hinkommen, auch nicht per direkt eingetippter URL. Blockiert
// alle Marktplatz-/Warenkorb-/Checkout-/Kaeufer-Dashboard-Pfade fuer diese
// Rollen und schickt sie in ihren eigenen Bereich zurueck.
const MARKETPLACE_RESTRICTED_PREFIXES = ['/marktplatz', '/dashboard', '/cart', '/checkout', '/order'];
app.use((req, res, next) => {
  const role = req.session && req.session.role;
  if (!role || !['partner', 'qm_lead', 'qm_agent'].includes(role)) return next();
  if (!MARKETPLACE_RESTRICTED_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();

  if (role === 'partner') return res.redirect('/partner/dashboard');
  return res.redirect('/qm');
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /dashboard\n' +
    'Disallow: /partner/dashboard\n' +
    'Disallow: /admin\n' +
    'Disallow: /qm\n' +
    'Disallow: /checkout\n' +
    'Disallow: /api\n' +
    `\nSitemap: ${BASE_URL}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const pages = ['/', '/marktplatz', '/partner', '/register', '/login'];
  const urls = pages.map(p => `  <url><loc>${BASE_URL}${p}</loc></url>`).join('\n');
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `${urls}\n` +
    '</urlset>\n'
  );
});

const layoutHtml = fs.readFileSync(path.join(__dirname, 'views', 'layout.html'), 'utf8');

function renderPage(res, viewName, data = {}) {
  const viewPath = path.join(__dirname, 'views', viewName);
  let content = fs.readFileSync(viewPath, 'utf8');

  const allData = { ...data, ...res.locals };

  content = replaceTemplateVars(content, allData);

  const canonicalUrl = `${BASE_URL}${res.req.path}`;
  const metaDescription = data.metaDescription || DEFAULT_META_DESCRIPTION;
  const ogImage = data.ogImage || `${BASE_URL}/images/callcenteragent.jpg`;
  const ogTitle = data.pageTitle ? `${data.pageTitle} – LeadArea` : 'LeadArea';

  const dashboardLink = allData.user && allData.user.role === 'partner' ? '/partner/dashboard'
    : allData.user && ['qm_lead', 'qm_agent'].includes(allData.user.role) ? '/qm'
    : '/dashboard';
  const navUser = allData.user
    ? `<div class="user-menu">
         <span class="user-greeting">Hallo, ${allData.user.firstName}</span>
         <a href="${dashboardLink}" class="nav-link">Dashboard</a>
         ${allData.user.role === 'admin' ? '<a href="/admin" class="nav-link">Admin</a>' : ''}
         <a href="/logout" class="nav-link">Logout</a>
       </div>`
    : `<a href="/login" class="nav-link">Login</a>
       <a href="/register" class="btn btn-primary btn-sm">Registrieren</a>`;

  // Partner-LeadArea ist strikt vom Marktplatz getrennt: ein Partner darf nie
  // sehen, zu welchem Preis "seine" Leads dort verkauft werden - deshalb auf
  // jeder /partner-Seite (inkl. Dashboard) jeglichen Marktplatz-Verweis
  // (Nav-Link, Footer-Link, Warenkorb) komplett ausblenden. Der QM-Bereich
  // (Andrea + Team) unterliegt aus demselben Grund derselben Sperre - siehe
  // auch die harte serverseitige Blockade weiter oben (MARKETPLACE_RESTRICTED_PREFIXES).
  const isPartnerArea = res.req.path.startsWith('/partner');
  // /qm ist (anders als /partner) als Sub-Router MIT Praefix gemountet
  // (app.use('/qm', qmRoutes)) - req.path ist dort relativ zum Mountpoint
  // und haette den Praefix schon abgeschnitten, deshalb hier originalUrl.
  const isQmArea = res.req.originalUrl.startsWith('/qm');
  const isRestrictedArea = isPartnerArea || isQmArea;
  const headerClaim = isPartnerArea ? 'unser Netzwerk ist dein Erfolg' : 'Vorsprung beginnt hier';
  const headerClaimClass = isPartnerArea ? 'header-claim-partner' : '';
  const navMarketplace = isRestrictedArea ? '' : '<a href="/marktplatz" class="nav-link">Marktplatz</a>';
  const footerMarketplace = isRestrictedArea ? '' : '<li><a href="/marktplatz">Marktplatz</a></li>';
  const cartBadge = (!isRestrictedArea && allData.cartCount > 0)
    ? `<a href="/checkout" class="cart-link"><span class="cart-icon">🛒</span><span class="cart-badge">${allData.cartCount}</span></a>`
    : '';

  let page = layoutHtml;
  page = page.replace('{{content}}', content);
  page = page.replace('{{pageTitle}}', data.pageTitle || 'LeadArea');
  page = page.replace('{{navUser}}', navUser);
  page = page.replace('{{navMarketplace}}', navMarketplace);
  page = page.replace('{{headerClaim}}', headerClaim);
  page = page.replace('{{headerClaimClass}}', headerClaimClass);
  page = page.replace('{{footerMarketplace}}', footerMarketplace);
  page = page.replace('{{cartBadge}}', cartBadge);
  page = page.replace(/\{\{metaDescription\}\}/g, metaDescription);
  page = page.replace(/\{\{canonicalUrl\}\}/g, canonicalUrl);
  page = page.replace(/\{\{ogImage\}\}/g, ogImage);
  page = page.replace(/\{\{ogTitle\}\}/g, ogTitle);
  page = page.replace(/\{\{baseUrl\}\}/g, BASE_URL);
  page = replaceTemplateVars(page, allData);

  res.send(page);
}

function replaceTemplateVars(html, data) {
  return html.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key in data) {
      const val = data[key];
      if (typeof val === 'string' || typeof val === 'number') return val;
    }
    return '';
  });
}

app.locals.renderPage = renderPage;

const authRoutes = require('./routes/auth');
const marketplaceRoutes = require('./routes/marketplace');
const orderRoutes = require('./routes/orders');
const dashboardRoutes = require('./routes/dashboard');
const partnerRoutes = require('./routes/partner');
const adminRoutes = require('./routes/admin');
const apiRoutes = require('./routes/api');
const qmRoutes = require('./routes/qm');

app.use('/', authRoutes);
app.use('/', paymentRoutes);
app.use('/', marketplaceRoutes);
app.use('/', orderRoutes);
app.use('/', dashboardRoutes);
app.use('/', partnerRoutes);
app.use('/admin', adminRoutes);
app.use('/api', apiRoutes);
app.use('/qm', qmRoutes);

app.listen(PORT, () => {
  console.log(`Leadpuls läuft auf http://localhost:${PORT}`);
});
