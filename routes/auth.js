const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { getDb } = require('../database');

// EU-Staaten + Schweiz, UK, Norwegen, Island, Liechtenstein – Käufer nur aus diesen Ländern
const ALLOWED_BUYER_COUNTRIES = [
  'DE', 'AT', 'CH', 'BE', 'BG', 'DK', 'EE', 'FI', 'FR', 'GR', 'IE', 'IS', 'IT',
  'HR', 'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SK',
  'SI', 'ES', 'CZ', 'HU', 'GB', 'CY',
];

function redirectForRole(res, role) {
  if (role === 'admin') return res.redirect('/admin');
  if (role === 'partner') return res.redirect('/partner/dashboard');
  if (role === 'qm_lead' || role === 'qm_agent') return res.redirect('/qm');
  return res.redirect('/dashboard');
}

router.get('/register', (req, res) => {
  if (req.session && req.session.userId) return redirectForRole(res, req.session.role);
  req.app.locals.renderPage(res, 'register.html', { pageTitle: 'Registrieren', alertHtml: '' });
});

router.post('/register', async (req, res) => {
  const { company, first_name, last_name, email, phone, street, house_number, postal_code, city, password, password2, country, b2b, agb, newsletter } = req.body;

  if (!company || !first_name || !last_name || !email || !phone || !street || !house_number || !postal_code || !city || !password || !country) {
    return req.app.locals.renderPage(res, 'register.html', {
      pageTitle: 'Registrieren',
      alertHtml: '<div class="alert alert-error">Bitte fülle alle Pflichtfelder aus.</div>'
    });
  }

  if (!b2b) {
    return req.app.locals.renderPage(res, 'register.html', {
      pageTitle: 'Registrieren',
      alertHtml: '<div class="alert alert-error">Die Registrierung ist nur als Unternehmer im Rahmen einer gewerblichen Tätigkeit möglich.</div>'
    });
  }

  if (!ALLOWED_BUYER_COUNTRIES.includes(country)) {
    return req.app.locals.renderPage(res, 'register.html', {
      pageTitle: 'Registrieren',
      alertHtml: '<div class="alert alert-error">Eine Registrierung ist derzeit nur aus Ländern Europas möglich.</div>'
    });
  }

  if (!agb) {
    return req.app.locals.renderPage(res, 'register.html', {
      pageTitle: 'Registrieren',
      alertHtml: '<div class="alert alert-error">Bitte akzeptiere die AGB.</div>'
    });
  }

  if (password !== password2) {
    return req.app.locals.renderPage(res, 'register.html', {
      pageTitle: 'Registrieren',
      alertHtml: '<div class="alert alert-error">Die Passwörter stimmen nicht überein.</div>'
    });
  }

  if (password.length < 6) {
    return req.app.locals.renderPage(res, 'register.html', {
      pageTitle: 'Registrieren',
      alertHtml: '<div class="alert alert-error">Das Passwort muss mindestens 6 Zeichen lang sein.</div>'
    });
  }

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return req.app.locals.renderPage(res, 'register.html', {
      pageTitle: 'Registrieren',
      alertHtml: '<div class="alert alert-error">Diese E-Mail-Adresse ist bereits registriert.</div>'
    });
  }

  const hash = await bcrypt.hash(password, 10);
  const result = db.prepare(`
    INSERT INTO users (email, password_hash, first_name, last_name, phone, street, house_number, postal_code, city, country, company, agb_accepted_at, b2b_confirmed_at, newsletter)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
  `).run(email, hash, first_name, last_name, phone, street, house_number, postal_code, city, country, company, newsletter ? 1 : 0);

  req.session.userId = result.lastInsertRowid;
  req.session.email = email;
  req.session.firstName = first_name;
  req.session.lastName = last_name;
  req.session.role = 'user';

  res.redirect('/dashboard');
});

router.get('/login', (req, res) => {
  if (req.session && req.session.userId) return redirectForRole(res, req.session.role);
  req.app.locals.renderPage(res, 'login.html', { pageTitle: 'Login', alertHtml: '' });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return req.app.locals.renderPage(res, 'login.html', {
      pageTitle: 'Login',
      alertHtml: '<div class="alert alert-error">Bitte fülle alle Felder aus.</div>'
    });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return req.app.locals.renderPage(res, 'login.html', {
      pageTitle: 'Login',
      alertHtml: '<div class="alert alert-error">E-Mail oder Passwort falsch.</div>'
    });
  }

  req.session.userId = user.id;
  req.session.email = user.email;
  req.session.firstName = user.first_name;
  req.session.lastName = user.last_name;
  req.session.role = user.role;

  redirectForRole(res, user.role);
});

router.get('/logout', (req, res) => {
  if (req.session && req.session.qmSessionId) {
    const { getDb } = require('../database');
    getDb().prepare('UPDATE qm_sessions SET logout_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.session.qmSessionId);
  }
  req.session.destroy(() => {
    res.redirect('/');
  });
});

module.exports = router;
