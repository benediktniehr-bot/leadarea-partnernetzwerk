const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { getDb } = require('../database');
const { sendPasswordResetMail } = require('../lib/mailer');
const { PARTNER_PASSWORD_PATTERN, PARTNER_PASSWORD_HINWEIS } = require('../lib/passwordPolicy');

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
  req.session.loginLogId = db.prepare('INSERT INTO login_log (user_id, role) VALUES (?, ?)').run(user.id, user.role).lastInsertRowid;

  redirectForRole(res, user.role);
});

router.get('/logout', (req, res) => {
  if (req.session && req.session.qmSessionId) {
    const { getDb } = require('../database');
    getDb().prepare('UPDATE qm_sessions SET logout_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.session.qmSessionId);
  }
  if (req.session && req.session.loginLogId) {
    const { getDb } = require('../database');
    getDb().prepare('UPDATE login_log SET logout_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.session.loginLogId);
  }
  req.session.destroy(() => {
    res.redirect('/');
  });
});

router.get('/forgot-password', (req, res) => {
  req.app.locals.renderPage(res, 'forgot-password.html', { pageTitle: 'Passwort vergessen', alertHtml: '' });
});

router.post('/forgot-password', (req, res) => {
  const db = getDb();
  const { email } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email || '');
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expires, user.id);
    sendPasswordResetMail({ toEmail: user.email, firstName: user.first_name, resetToken: token })
      .catch(err => console.error('[Passwort-Reset-Mail] fehlgeschlagen:', err));
  }
  // Immer dieselbe Meldung, egal ob die E-Mail existiert - verhindert, dass
  // sich darüber ausspähen lässt, welche E-Mails registriert sind.
  req.app.locals.renderPage(res, 'forgot-password.html', {
    pageTitle: 'Passwort vergessen',
    alertHtml: '<div class="alert alert-success">Falls diese E-Mail-Adresse bei uns registriert ist, haben wir dir einen Link zum Zurücksetzen geschickt.</div>',
  });
});

router.get('/reset-password/:token', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(req.params.token);
  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return req.app.locals.renderPage(res, 'login.html', {
      pageTitle: 'Login',
      alertHtml: '<div class="alert alert-error">Der Link zum Zurücksetzen ist ungültig oder abgelaufen. Bitte fordere einen neuen an.</div>',
    });
  }
  req.app.locals.renderPage(res, 'reset-password.html', {
    pageTitle: 'Neues Passwort vergeben', token: req.params.token, alertHtml: '',
    passwordMinlength: user.role === 'partner' ? 10 : 6,
    passwordPattern: user.role === 'partner' ? PARTNER_PASSWORD_PATTERN.source.replace(/^\^|\$$/g, '') : '.{6,}',
    passwordHint: user.role === 'partner' ? PARTNER_PASSWORD_HINWEIS : 'Mindestens 6 Zeichen.',
  });
});

router.post('/reset-password/:token', async (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(req.params.token);
  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return req.app.locals.renderPage(res, 'login.html', {
      pageTitle: 'Login',
      alertHtml: '<div class="alert alert-error">Der Link zum Zurücksetzen ist ungültig oder abgelaufen. Bitte fordere einen neuen an.</div>',
    });
  }
  const passwordFieldProps = {
    passwordMinlength: user.role === 'partner' ? 10 : 6,
    passwordPattern: user.role === 'partner' ? PARTNER_PASSWORD_PATTERN.source.replace(/^\^|\$$/g, '') : '.{6,}',
    passwordHint: user.role === 'partner' ? PARTNER_PASSWORD_HINWEIS : 'Mindestens 6 Zeichen.',
  };
  const { password, password2 } = req.body;
  if (password !== password2) {
    return req.app.locals.renderPage(res, 'reset-password.html', {
      pageTitle: 'Neues Passwort vergeben', token: req.params.token, ...passwordFieldProps,
      alertHtml: '<div class="alert alert-error">Die Passwörter stimmen nicht überein.</div>',
    });
  }
  // Partner unterliegen der strengeren Policy (min. 10 Zeichen, siehe
  // lib/passwordPolicy.js), Käufer weiterhin min. 6 Zeichen wie bei der
  // Registrierung in routes/auth.js (nicht Teil dieser Aufgabe geändert).
  const isValid = user.role === 'partner'
    ? PARTNER_PASSWORD_PATTERN.test(password || '')
    : !!password && password.length >= 6;
  if (!isValid) {
    return req.app.locals.renderPage(res, 'reset-password.html', {
      pageTitle: 'Neues Passwort vergeben', token: req.params.token, ...passwordFieldProps,
      alertHtml: `<div class="alert alert-error">${passwordFieldProps.passwordHint}</div>`,
    });
  }
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?').run(hash, user.id);
  req.app.locals.renderPage(res, 'login.html', {
    pageTitle: 'Login',
    alertHtml: '<div class="alert alert-success">Dein Passwort wurde geändert. Du kannst dich jetzt einloggen.</div>',
  });
});

module.exports = router;
