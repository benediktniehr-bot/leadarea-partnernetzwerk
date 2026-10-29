require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const { initializeDatabase } = require('./database');
const { attachUser } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  throw new Error('SESSION_SECRET environment variable is required');
}
const DEFAULT_META_DESCRIPTION = 'Partner-LeadArea: Werde Produktionspartner und profitiere von langjährigen Kooperationen, einem großen Netzwerk und unserem Know-how.';

for (const dir of [
  process.env.UPLOADS_DIR ? path.join(process.env.UPLOADS_DIR, 'voicefiles') : path.join(__dirname, 'public', 'uploads', 'voicefiles'),
  process.env.UPLOADS_DIR ? path.join(process.env.UPLOADS_DIR, 'csv') : path.join(__dirname, 'public', 'uploads', 'csv'),
  process.env.UPLOADS_DIR ? path.join(process.env.UPLOADS_DIR, 'tmp-voicefiles') : path.join(__dirname, 'public', 'uploads', 'tmp-voicefiles'),
]) {
  fs.mkdirSync(dir, { recursive: true });
}

initializeDatabase();

const SQLiteStore = require('connect-sqlite3')(session);

// Stripe Webhook braucht raw body — muss VOR express.json() registriert werden
const paymentRoutes = require('./routes/payment');
app.use('/webhooks/stripe', paymentRoutes);

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new SQLiteStore({ db: 'sessions.db', dir: process.env.DATA_DIR || __dirname }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

app.use(attachUser);

// HARTE Sperre (nicht nur Nav-Link-Verstecken): Solange nur Partner-LeadArea
// (Produktionspartner-Akquise) live geht, darf NICHTS auf das Kaeuferportal/
// den Marktplatz hinweisen - sonst funktioniert die Strategie nicht (Partner
// sollen nicht sehen/wissen, dass "ihre" Leads anderswo verkauft werden, und
// Besucher sollen gar nicht erst auf die Kaeuferseite stossen). Gilt fuer
// ALLE Rollen (auch anonyme Besucher und Kaeufer-Accounts) ausser Admin -
// nur Admin darf den Marktplatz zu Verwaltungszwecken noch sehen.
const MARKETPLACE_RESTRICTED_PREFIXES = ['/marktplatz', '/dashboard', '/cart', '/checkout', '/order', '/register'];
app.use((req, res, next) => {
  const role = req.session && req.session.role;
  if (role === 'admin') return next();
  if (req.path === '/') return res.redirect('/partner');
  if (!MARKETPLACE_RESTRICTED_PREFIXES.some(p => req.path === p || req.path.startsWith(p + '/'))) return next();

  if (role === 'partner') return res.redirect('/partner/dashboard');
  if (role === 'qm_lead' || role === 'qm_agent') return res.redirect('/qm');
  return res.redirect('/partner');
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\n' +
    'Allow: /\n' +
    'Disallow: /marktplatz\n' +
    'Disallow: /register\n' +
    'Disallow: /dashboard\n' +
    'Disallow: /cart\n' +
    'Disallow: /checkout\n' +
    'Disallow: /order\n' +
    'Disallow: /partner/dashboard\n' +
    'Disallow: /admin\n' +
    'Disallow: /qm\n' +
    'Disallow: /api\n' +
    `\nSitemap: ${BASE_URL}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const pages = ['/partner', '/login'];
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
  const headerClaim = isPartnerArea ? 'unser Netzwerk ist dein Erfolg' : 'Vorsprung beginnt hier';
  const headerClaimClass = isPartnerArea ? 'header-claim-partner' : '';
  // Solange nur Partner-LeadArea live ist, darf der Marktplatz-Link nirgends
  // auftauchen (siehe harte Sperre weiter oben) - Ausnahme nur fuer Admin,
  // der den Marktplatz weiterhin zu Verwaltungszwecken erreichen koennen soll.
  const canSeeMarketplace = allData.user && allData.user.role === 'admin';
  const navMarketplace = (canSeeMarketplace && !isPartnerArea && !isQmArea) ? '<a href="/marktplatz" class="nav-link">Marktplatz</a>' : '';
  const footerMarketplace = (canSeeMarketplace && !isPartnerArea && !isQmArea) ? '<li><a href="/marktplatz">Marktplatz</a></li>' : '';
  const cartBadge = (canSeeMarketplace && !isPartnerArea && !isQmArea && allData.cartCount > 0)
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
