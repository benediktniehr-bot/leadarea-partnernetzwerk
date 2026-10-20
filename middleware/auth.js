function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session || !req.session.userId || req.session.role !== 'admin') {
    return res.redirect('/login');
  }
  next();
}

function attachUser(req, res, next) {
  res.locals.user = null;
  res.locals.cartCount = 0;
  if (req.session && req.session.userId) {
    res.locals.user = {
      id: req.session.userId,
      email: req.session.email,
      firstName: req.session.firstName,
      lastName: req.session.lastName,
      role: req.session.role
    };
  }
  if (req.session && req.session.cart) {
    res.locals.cartCount = req.session.cart.reduce((sum, item) => sum + item.quantity, 0);
  }
  next();
}

function requirePartner(req, res, next) {
  if (!req.session || !req.session.userId || req.session.role !== 'partner') {
    return res.redirect('/login');
  }
  next();
}

// QM-Bereich (Andrea + ihr Team) - bewusst komplett getrennt vom Admin-Bereich,
// sieht nur die QM-Warteschlange und (bei qm_lead) die eigene Team-Verwaltung.
function requireQm(req, res, next) {
  if (!req.session || !req.session.userId || !['qm_lead', 'qm_agent'].includes(req.session.role)) {
    return res.redirect('/login');
  }
  next();
}

function requireQmLead(req, res, next) {
  if (!req.session || !req.session.userId || req.session.role !== 'qm_lead') {
    return res.redirect('/login');
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requirePartner, requireQm, requireQmLead, attachUser };
