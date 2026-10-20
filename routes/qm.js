const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { getDb } = require('../database');
const { requireQm, requireQmLead } = require('../middleware/auth');
const { getRecordingFilePath } = require('../lib/recordings');
const { pushLeadToMulticall } = require('../lib/multicallPush');

router.use(requireQm);

// Session-/Online-Zeit-Tracking: beim ersten Request einer Browser-Session
// im QM-Bereich eine qm_sessions-Zeile anlegen, bei jedem weiteren Request
// last_activity_at aktualisieren. Grundlage fuer Andreas Team-Auswertung.
router.use((req, res, next) => {
  const db = getDb();
  if (!req.session.qmSessionId) {
    req.session.qmSessionId = db.prepare('INSERT INTO qm_sessions (user_id) VALUES (?)').run(req.session.userId).lastInsertRowid;
  } else {
    db.prepare('UPDATE qm_sessions SET last_activity_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.session.qmSessionId);
  }
  next();
});

function renderQm(req, res, content, activeTab) {
  const teamNavItem = req.session.role === 'qm_lead'
    ? `<li><a href="/qm/team" class="${activeTab === 'team' ? 'active' : ''}">Mein Team</a></li>`
    : '';
  req.app.locals.renderPage(res, 'qm-dashboard.html', {
    pageTitle: 'QM',
    qmContent: content,
    activeQueue: activeTab === 'queue' ? 'active' : '',
    teamNavItem,
  });
}

// WARTESCHLANGE
router.get('/', (req, res) => {
  const db = getDb();

  // Teamleitung sieht ALLE offenen Leads (kann zuweisen), ein Agent sieht nur
  // ihm zugewiesene + noch nicht zugewiesene Leads (kein Zugriff auf Leads,
  // die Andrea bewusst jemand anderem gegeben hat).
  const isLead = req.session.role === 'qm_lead';
  const rows = db.prepare(`
    SELECT lp.*, pr.name as product_name, lc.name as category_name, u.first_name as partner_firstname, u.last_name as partner_lastname, u.company as partner_company,
      au.first_name as assignee_firstname, au.last_name as assignee_lastname,
      (SELECT voice_file FROM lead_recordings WHERE pool_lead_id = lp.id ORDER BY created_at DESC LIMIT 1) as voice_file
    FROM lead_pool lp
    JOIN lead_products pr ON pr.id = lp.product_id
    JOIN lead_categories lc ON lc.id = pr.category_id
    LEFT JOIN users u ON u.id = lp.partner_user_id
    LEFT JOIN users au ON au.id = lp.assigned_to
    WHERE lp.lead_status = 'in_pruefung'
      AND (? = 1 OR lp.assigned_to IS NULL OR lp.assigned_to = ?)
    ORDER BY lp.created_at ASC
  `).all(isLead ? 1 : 0, req.session.userId);

  // Team-Mitglieder fuer das Zuweisen-Dropdown (nur fuer die Teamleitung relevant).
  const teamLeadId = isLead ? req.session.userId : null;
  const teamOptions = isLead
    ? [{ id: req.session.userId, first_name: req.session.firstName, last_name: req.session.lastName }, ...db.prepare("SELECT id, first_name, last_name FROM users WHERE qm_team_lead_id = ?").all(teamLeadId)]
    : [];

  const rowsHtml = rows.length === 0
    ? '<p style="color:var(--gray-300);">Keine Leads in der Warteschlange.</p>'
    : rows.map(l => {
      const assigneeName = l.assignee_firstname ? `${l.assignee_firstname} ${l.assignee_lastname}` : null;
      const assignBlock = isLead ? `
            <form method="POST" action="/qm/lead/${l.id}/assign" style="margin-top:10px;display:flex;gap:6px;">
              <select name="assigned_to" style="flex:1;padding:6px;border-radius:6px;border:1px solid var(--gray-300);font-size:0.85rem;">
                <option value="">Nicht zugewiesen</option>
                ${teamOptions.map(t => `<option value="${t.id}" ${l.assigned_to === t.id ? 'selected' : ''}>${t.first_name} ${t.last_name}</option>`).join('')}
              </select>
              <button type="submit" class="btn btn-outline" style="font-size:0.8rem;padding:6px 10px;">Zuweisen</button>
            </form>`
        : (assigneeName ? `<p style="color:var(--gray-400);font-size:0.8rem;margin-top:8px;">Zugewiesen an: ${assigneeName}</p>` : '');

      return `
      <div style="background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:var(--radius);padding:20px;margin-bottom:16px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:12px;">
          <div>
            <strong style="color:var(--white);">${l.contact_firstname || ''} ${l.contact_lastname}</strong>${l.company_name ? ` (${l.company_name})` : ''}<br>
            <span style="color:var(--gray-300);font-size:0.9rem;">${l.category_name} &rarr; ${l.product_name} &middot; Partner: ${l.partner_company || (l.partner_firstname + ' ' + l.partner_lastname)}</span><br>
            <span style="color:var(--gray-400);font-size:0.85rem;">${l.street || ''} ${l.house_number || ''}, ${l.postal_code || ''} ${l.city || ''} &middot; Tel: ${l.phone || '-'} &middot; eingeliefert: ${l.created_at}</span>
            ${l.remarks ? `<p style="margin-top:8px;font-style:italic;color:var(--gray-300);">"${l.remarks}"</p>` : ''}
            ${assignBlock}
          </div>
          <div style="min-width:260px;">
            ${l.voice_file ? `<audio id="audio-${l.id}" controls style="width:100%;margin-bottom:10px;" data-leadid="${l.id}"><source src="/qm/voicefile/${l.id}"></audio>` : '<p style="color:var(--error);font-size:0.85rem;">Kein Voicefile gefunden</p>'}
            <div style="display:flex;gap:8px;">
              <form method="POST" action="/qm/lead/${l.id}/freigeben" style="flex:1;">
                <button type="submit" class="btn btn-primary" style="width:100%;">Freigeben</button>
              </form>
              <button type="button" class="btn btn-outline" style="flex:1;" onclick="document.getElementById('stornoform-${l.id}').style.display='flex'; this.style.display='none';">Stornieren</button>
            </div>
            <form id="stornoform-${l.id}" method="POST" action="/qm/lead/${l.id}/stornieren" style="display:none;gap:8px;margin-top:8px;">
              <input type="text" name="cancel_reason" placeholder="Grund (z.B. schlechte Qualität)" required style="flex:1;padding:8px;border-radius:6px;border:1px solid var(--gray-300);">
              <button type="submit" class="btn btn-accent">Bestätigen</button>
            </form>
          </div>
        </div>
      </div>`;
    }).join('');

  const content = `
    <h2 style="font-size:1.5rem;margin-bottom:8px;color:var(--white);">QM-Warteschlange</h2>
    <p style="color:var(--gray-300);margin-bottom:24px;">Live eingelieferte Leads – Voicefile anhören, Plausibilität prüfen, freigeben oder stornieren.${isLead ? ' Als Teamleitung kannst du Leads gezielt einem Mitarbeiter zuweisen.' : ''}</p>
    ${rowsHtml}
    <script>
    // Abhoerzeit-Tracking: bei jedem Pausieren/Ende der Wiedergabe die seit
    // dem letzten Start vergangene Zeit ans Backend melden (Grundlage fuer
    // die Verguetung, siehe Team-Auswertung).
    document.querySelectorAll('audio[data-leadid]').forEach(function(audio) {
      let playStart = null;
      audio.addEventListener('play', function() { playStart = Date.now(); });
      function reportListen() {
        if (playStart === null) return;
        const seconds = Math.round((Date.now() - playStart) / 1000);
        playStart = null;
        if (seconds < 1) return;
        fetch('/qm/lead/' + audio.dataset.leadid + '/listen-log', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seconds: seconds })
        }).catch(function() {});
      }
      audio.addEventListener('pause', reportListen);
      audio.addEventListener('ended', reportListen);
    });
    // Heartbeat alle 60s, damit Online-Zeit auch waehrend reinem Anhoeren
    // ohne Seitenwechsel weiterlaeuft.
    setInterval(function() { fetch('/qm/heartbeat', { method: 'POST' }).catch(function() {}); }, 60000);
    </script>`;

  renderQm(req, res, content, 'queue');
});

router.get('/voicefile/:leadId', (req, res) => {
  const db = getDb();
  const rec = db.prepare('SELECT voice_file FROM lead_recordings WHERE pool_lead_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.leadId);
  if (!rec) return res.status(404).end();
  res.sendFile(getRecordingFilePath(rec.voice_file));
});

router.post('/lead/:leadId/listen-log', express.json(), (req, res) => {
  const seconds = parseInt(req.body.seconds);
  if (!seconds || seconds < 1) return res.status(204).end();
  const db = getDb();
  db.prepare('INSERT INTO qm_listen_log (user_id, pool_lead_id, seconds) VALUES (?, ?, ?)').run(req.session.userId, req.params.leadId, seconds);
  res.status(204).end();
});

router.post('/heartbeat', (req, res) => {
  // last_activity_at wurde bereits durch die Router-weite Middleware oben aktualisiert.
  res.status(204).end();
});

// Manuelle Zuweisung eines Leads an ein bestimmtes Teammitglied - nur Andrea
// (qm_lead) darf zuweisen. Nur an eigene Teammitglieder (oder sich selbst)
// moeglich, nicht an beliebige Nutzer.
router.post('/lead/:leadId/assign', requireQmLead, (req, res) => {
  const db = getDb();
  const leadId = parseInt(req.params.leadId);
  const assignedTo = req.body.assigned_to ? parseInt(req.body.assigned_to) : null;

  if (assignedTo !== null) {
    const isOwnTeamMember = assignedTo === req.session.userId
      || db.prepare('SELECT id FROM users WHERE id = ? AND qm_team_lead_id = ?').get(assignedTo, req.session.userId);
    if (!isOwnTeamMember) return res.redirect('/qm');
  }

  db.prepare("UPDATE lead_pool SET assigned_to = ? WHERE id = ? AND lead_status = 'in_pruefung'").run(assignedTo, leadId);
  res.redirect('/qm');
});

// Ein Agent darf nur Leads bearbeiten, die ihm zugewiesen sind oder noch
// niemandem zugewiesen wurden - NICHT nur per UI versteckt, sondern hier
// serverseitig erzwungen (ein Agent koennte sonst per direktem POST auf eine
// erratene Lead-ID einem Kollegen die Bearbeitung wegschnappen).
function canActOnLead(req, lead) {
  if (req.session.role === 'qm_lead') return true;
  return lead.assigned_to === null || lead.assigned_to === req.session.userId;
}

router.post('/lead/:leadId/freigeben', (req, res) => {
  const db = getDb();
  const leadId = parseInt(req.params.leadId);
  const lead = db.prepare("SELECT * FROM lead_pool WHERE id = ? AND lead_status = 'in_pruefung'").get(leadId);
  if (!lead || !canActOnLead(req, lead)) return res.redirect('/qm');

  db.prepare("UPDATE lead_pool SET lead_status = 'pending', qm_approved_at = CURRENT_TIMESTAMP, qm_processed_by = ? WHERE id = ?").run(req.session.userId, leadId);

  const pushResult = pushLeadToMulticall(leadId);
  if (!pushResult.pushed) {
    console.warn(`[QM] Lead ${leadId} freigegeben, aber noch nicht nach Multicall uebertragen: ${pushResult.reason}`);
  }

  res.redirect('/qm');
});

router.post('/lead/:leadId/stornieren', (req, res) => {
  const db = getDb();
  const leadId = parseInt(req.params.leadId);
  const lead = db.prepare("SELECT * FROM lead_pool WHERE id = ? AND lead_status = 'in_pruefung'").get(leadId);
  if (!lead || !canActOnLead(req, lead)) return res.redirect('/qm');

  const reason = req.body.cancel_reason || 'Nicht freigegeben durch QM';
  db.prepare("UPDATE lead_pool SET lead_status = 'cancelled', cancel_reason = ?, qm_processed_by = ? WHERE id = ?").run(reason, req.session.userId, leadId);
  res.redirect('/qm');
});

// TEAM-VERWALTUNG (nur qm_lead, z.B. Andrea) - eigene Mitarbeiter anlegen,
// Abhoerzeit/Online-Zeit/bearbeitete Leads je Mitarbeiter als Verguetungsbasis.
router.get('/team', requireQmLead, (req, res) => {
  const db = getDb();
  const agents = db.prepare("SELECT id, first_name, last_name, email FROM users WHERE qm_team_lead_id = ? ORDER BY first_name").all(req.session.userId);
  const teamIds = [req.session.userId, ...agents.map(a => a.id)];

  const rangeFrom = req.query.from || null;
  const rangeTo = req.query.to || null;
  const dateFilter = (col) => rangeFrom && rangeTo ? `AND ${col} BETWEEN '${rangeFrom}' AND '${rangeTo} 23:59:59'` : '';

  function statsFor(userId) {
    const listenSeconds = db.prepare(`SELECT COALESCE(SUM(seconds),0) as s FROM qm_listen_log WHERE user_id = ? ${dateFilter('created_at')}`).get(userId).s;
    const processed = db.prepare(`SELECT COUNT(*) as c FROM lead_pool WHERE qm_processed_by = ? ${dateFilter('qm_approved_at')}`).get(userId).c;
    const sessions = db.prepare(`SELECT login_at, COALESCE(logout_at, last_activity_at) as ended FROM qm_sessions WHERE user_id = ? ${dateFilter('login_at')}`).all(userId);
    const onlineSeconds = sessions.reduce((sum, s) => sum + Math.max(0, (new Date(s.ended) - new Date(s.login_at)) / 1000), 0);
    return { listenSeconds, processed, onlineSeconds: Math.round(onlineSeconds) };
  }

  function fmtDuration(totalSeconds) {
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const h = Math.floor(totalSeconds / 3600), m = Math.floor((totalSeconds % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }

  const allUsers = [{ id: req.session.userId, first_name: req.session.firstName, last_name: req.session.lastName, email: req.session.email, isLead: true }, ...agents];
  const rowsHtml = allUsers.map(u => {
    const s = statsFor(u.id);
    return `<tr>
      <td>${u.first_name} ${u.last_name}${u.isLead ? ' <span class="badge" style="background:var(--primary);">Teamleitung</span>' : ''}</td>
      <td>${u.email}</td>
      <td>${fmtDuration(s.onlineSeconds)}</td>
      <td>${fmtDuration(s.listenSeconds)}</td>
      <td>${s.processed}</td>
    </tr>`;
  }).join('');

  const alertHtml = req.query.created
    ? `<div class="alert alert-success">Mitarbeiter angelegt. Zugangsdaten: <strong>${req.query.created}</strong> / <strong>${req.query.pw}</strong> (bitte notieren, wird nicht nochmal angezeigt).</div>`
    : '';

  const content = `
    <h2 style="font-size:1.5rem;margin-bottom:24px;color:var(--white);">Mein Team</h2>
    ${alertHtml}
    <div style="background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:var(--radius);padding:24px;margin-bottom:24px;">
      <h3 style="color:var(--white);margin-bottom:16px;">Neuen Mitarbeiter anlegen</h3>
      <form method="POST" action="/qm/team/add" style="display:flex;gap:12px;flex-wrap:wrap;">
        <input type="text" name="first_name" placeholder="Vorname" required style="flex:1;min-width:140px;padding:10px;border-radius:6px;border:1px solid var(--gray-300);">
        <input type="text" name="last_name" placeholder="Nachname" required style="flex:1;min-width:140px;padding:10px;border-radius:6px;border:1px solid var(--gray-300);">
        <input type="email" name="email" placeholder="E-Mail" required style="flex:1;min-width:200px;padding:10px;border-radius:6px;border:1px solid var(--gray-300);">
        <button type="submit" class="btn btn-primary">Anlegen</button>
      </form>
    </div>
    <div style="background:rgba(255,255,255,0.045);border:1px solid rgba(255,255,255,0.09);border-radius:var(--radius);padding:24px;">
      <form method="GET" action="/qm/team" style="display:flex;gap:12px;margin-bottom:20px;align-items:flex-end;flex-wrap:wrap;">
        <div><label style="color:var(--gray-300);font-size:0.85rem;display:block;">Von</label><input type="date" name="from" value="${rangeFrom || ''}" style="padding:8px;border-radius:6px;border:1px solid var(--gray-300);"></div>
        <div><label style="color:var(--gray-300);font-size:0.85rem;display:block;">Bis</label><input type="date" name="to" value="${rangeTo || ''}" style="padding:8px;border-radius:6px;border:1px solid var(--gray-300);"></div>
        <button type="submit" class="btn btn-outline">Filtern</button>
      </form>
      <table class="data-table" style="width:100%;">
        <thead><tr><th>Name</th><th>E-Mail</th><th>Online-Zeit</th><th>Abhörzeit</th><th>Bearbeitete Leads</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;

  renderQm(req, res, content, 'team');
});

router.post('/team/add', requireQmLead, (req, res) => {
  const { first_name, last_name, email } = req.body;
  if (!first_name || !last_name || !email) return res.redirect('/qm/team');

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.redirect('/qm/team');

  const tempPassword = Math.random().toString(36).slice(-10);
  const hash = bcrypt.hashSync(tempPassword, 10);
  db.prepare(`
    INSERT INTO users (email, password_hash, first_name, last_name, role, qm_team_lead_id)
    VALUES (?, ?, ?, ?, 'qm_agent', ?)
  `).run(email, hash, first_name, last_name, req.session.userId);

  res.redirect(`/qm/team?created=${encodeURIComponent(email)}&pw=${encodeURIComponent(tempPassword)}`);
});

module.exports = router;
