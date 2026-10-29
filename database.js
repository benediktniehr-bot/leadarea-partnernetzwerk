const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'leadpuls.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initializeDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      api_key TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lead_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      icon TEXT,
      sort_order INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS lead_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL,
      lead_type TEXT NOT NULL DEFAULT 'b2c',
      active INTEGER DEFAULT 1,
      FOREIGN KEY (category_id) REFERENCES lead_categories(id)
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      total REAL NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (product_id) REFERENCES lead_products(id)
    );

    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_item_id INTEGER,
      user_id INTEGER,
      product_id INTEGER,
      contact_name TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      contact_info TEXT,
      voice_file TEXT,
      call_date DATETIME,
      status TEXT NOT NULL DEFAULT 'unassigned',
      delivered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_item_id) REFERENCES order_items(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (product_id) REFERENCES lead_products(id)
    );

    CREATE TABLE IF NOT EXISTS reclamations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (lead_id) REFERENCES leads(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS partner_applications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      street TEXT,
      house_number TEXT,
      postal_code TEXT,
      city TEXT,
      country TEXT NOT NULL DEFAULT 'DE',
      phone TEXT,
      email TEXT NOT NULL,
      tax_number TEXT,
      message TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lead_imports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      partner_user_id INTEGER,
      supplier_name TEXT,
      filename TEXT,
      lead_count INTEGER NOT NULL DEFAULT 0,
      duplicates_skipped INTEGER NOT NULL DEFAULT 0,
      invalid_skipped INTEGER NOT NULL DEFAULT 0,
      blacklist_skipped INTEGER NOT NULL DEFAULT 0,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES lead_products(id),
      FOREIGN KEY (partner_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS delivery_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_item_id INTEGER NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      quantity_ordered INTEGER NOT NULL,
      quantity_delivered INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_item_id) REFERENCES order_items(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (product_id) REFERENCES lead_products(id)
    );

    CREATE TABLE IF NOT EXISTS phone_blacklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL UNIQUE,
      reason TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS lead_pool (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id INTEGER,
      product_id INTEGER NOT NULL,
      partner_user_id INTEGER,
      lead_type TEXT NOT NULL DEFAULT 'b2b',
      company_name TEXT,
      contact_lastname TEXT NOT NULL,
      contact_firstname TEXT,
      street TEXT,
      house_number TEXT,
      postal_code TEXT,
      city TEXT,
      phone TEXT,
      email TEXT,
      date_of_birth TEXT,
      remarks TEXT,
      lead_status TEXT NOT NULL DEFAULT 'pending',
      cancel_reason TEXT,
      max_assignments INTEGER NOT NULL DEFAULT 3,
      current_assignments INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (import_id) REFERENCES lead_imports(id),
      FOREIGN KEY (product_id) REFERENCES lead_products(id),
      FOREIGN KEY (partner_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS lead_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_lead_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      order_item_id INTEGER,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pool_lead_id) REFERENCES lead_pool(id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (order_item_id) REFERENCES order_items(id)
    );

    CREATE TABLE IF NOT EXISTS lead_recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_lead_id INTEGER NOT NULL,
      voice_file TEXT NOT NULL,
      call_date DATETIME,
      source TEXT NOT NULL DEFAULT 'cc_parallel_import',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (pool_lead_id) REFERENCES lead_pool(id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL UNIQUE,
      user_id INTEGER NOT NULL,
      invoice_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      net_total REAL NOT NULL,
      vat_total REAL NOT NULL,
      gross_total REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  // Migrations für bestehende DBs
  const migrations = [
    "ALTER TABLE lead_imports ADD COLUMN invalid_skipped INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE lead_imports ADD COLUMN blacklist_skipped INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE lead_assignments ADD COLUMN downloaded_at DATETIME",
    "ALTER TABLE lead_imports ADD COLUMN consent_url TEXT",
    "ALTER TABLE lead_imports ADD COLUMN consent_text TEXT",
    "ALTER TABLE lead_products ADD COLUMN partner_payout REAL",
    "ALTER TABLE users ADD COLUMN agb_accepted_at DATETIME",
    "ALTER TABLE users ADD COLUMN newsletter INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN country TEXT",
    "ALTER TABLE partner_applications ADD COLUMN agb_accepted_at DATETIME",
    "ALTER TABLE partner_applications ADD COLUMN newsletter INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN vat_rate REAL NOT NULL DEFAULT 0",
    "ALTER TABLE invoices ADD COLUMN country TEXT",
    "ALTER TABLE lead_products ADD COLUMN price_tier2 REAL NOT NULL DEFAULT 0",
    "ALTER TABLE lead_products ADD COLUMN price_tier3 REAL NOT NULL DEFAULT 0",
    "ALTER TABLE order_items ADD COLUMN tier INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE delivery_queue ADD COLUMN tier INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE lead_products ADD COLUMN image_url TEXT",
    "ALTER TABLE lead_products ADD COLUMN price_exclusive REAL NOT NULL DEFAULT 0",
    "ALTER TABLE lead_pool ADD COLUMN exclusive_locked_until DATETIME",
    "ALTER TABLE lead_pool ADD COLUMN bundesland TEXT",
    "ALTER TABLE order_items ADD COLUMN bundesland TEXT",
    "ALTER TABLE delivery_queue ADD COLUMN bundesland TEXT",
    "ALTER TABLE users ADD COLUMN can_upload INTEGER NOT NULL DEFAULT 1",
    "ALTER TABLE users ADD COLUMN company TEXT",
    "ALTER TABLE users ADD COLUMN b2b_confirmed_at DATETIME",
    "ALTER TABLE users ADD COLUMN street TEXT",
    "ALTER TABLE users ADD COLUMN house_number TEXT",
    "ALTER TABLE users ADD COLUMN postal_code TEXT",
    "ALTER TABLE users ADD COLUMN city TEXT",
    "ALTER TABLE partner_applications ADD COLUMN appointment_request TEXT",
    "ALTER TABLE lead_pool ADD COLUMN multicall_checked_at DATETIME",
    "ALTER TABLE lead_pool ADD COLUMN multicall_address_id INTEGER",
    "ALTER TABLE lead_pool ADD COLUMN qm_approved_at DATETIME",
    "ALTER TABLE lead_pool ADD COLUMN qm_processed_by INTEGER",
    "ALTER TABLE users ADD COLUMN qm_team_lead_id INTEGER",
    "ALTER TABLE lead_pool ADD COLUMN assigned_to INTEGER",
    "ALTER TABLE lead_products ADD COLUMN production_paused INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE users ADD COLUMN contract_signed_at DATETIME",
    "ALTER TABLE lead_products ADD COLUMN partner_description TEXT",
    "ALTER TABLE users ADD COLUMN reset_token TEXT",
    "ALTER TABLE users ADD COLUMN reset_token_expires DATETIME",
    "UPDATE lead_categories SET name = 'Automaten' WHERE name = 'Vending & Automaten'",
  ];

  db.exec(`
    CREATE TABLE IF NOT EXISTS product_delivery_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      field_key TEXT NOT NULL,
      field_label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (product_id) REFERENCES lead_products(id)
    );
    CREATE TABLE IF NOT EXISTS lead_pool_attributes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pool_lead_id INTEGER NOT NULL,
      field_key TEXT NOT NULL,
      field_value TEXT,
      FOREIGN KEY (pool_lead_id) REFERENCES lead_pool(id)
    );
    CREATE TABLE IF NOT EXISTS partner_application_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      FOREIGN KEY (application_id) REFERENCES partner_applications(id),
      FOREIGN KEY (product_id) REFERENCES lead_products(id)
    );
    -- Verknuepfung Produkt -> Multicall-Merkmal/Vendor, damit QM-freigegebene
    -- Leads automatisch mit dem richtigen Merkmal nach tl_dmp_address
    -- geschrieben werden koennen. Noch leer, wird pro Partner/Projekt befuellt,
    -- sobald der erste echte Partner als Vendor in Multicall angelegt ist.
    CREATE TABLE IF NOT EXISTS product_multicall_mapping (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL UNIQUE,
      multicall_merkmal TEXT NOT NULL,
      multicall_vendor_shortcut TEXT NOT NULL,
      FOREIGN KEY (product_id) REFERENCES lead_products(id)
    );
    -- Online-Zeit-Tracking je QM-Mitarbeiter (Andrea + ihr Team), Grundlage
    -- fuer deren Verguetung. Eine Zeile pro Login-Session.
    CREATE TABLE IF NOT EXISTS qm_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      login_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_activity_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      logout_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    -- Abhoerzeit je QM-Mitarbeiter und Lead, ebenfalls Verguetungsgrundlage.
    -- Mehrere Zeilen pro Lead moeglich (z.B. mehrfach angehoert/pausiert).
    CREATE TABLE IF NOT EXISTS qm_listen_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      pool_lead_id INTEGER NOT NULL,
      seconds INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (pool_lead_id) REFERENCES lead_pool(id)
    );
    -- Welche Projekte ein Partner tatsaechlich produzieren darf - unabhaengig
    -- davon, was er bei der Bewerbung (partner_application_projects) gewuenscht
    -- hatte. Admin pflegt das erst nach Vertragsunterschrift (users.contract_signed_at),
    -- steuert Sichtbarkeit von Upload-Dropdown + Liefertemplate-Download.
    CREATE TABLE IF NOT EXISTS partner_approved_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      approved_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (product_id) REFERENCES lead_products(id)
    );
  `);
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) {}
  }

  backfillBundesland(db);
  seedData(db);
  seedDeliveryFields(db);
}

// Produktspezifische Zusatzfelder (Liefertemplates) fürs CC bei der Datenproduktion.
// Werden als weitere CSV-Spalten NACH den Standardfeldern erwartet, in dieser
// Reihenfolge (sort_order). Immobilien/Photovoltaik von Jens vorgegeben
// (2026-10-12); Treppenlift/Kaffeevollautomaten entsprechen den bestehenden
// Multicall-Vorlagen TRLFT-TR bzw. CP/Ormigo (von Jens bestätigt, 2026-10-12).
function seedDeliveryFields(db) {
  const existing = db.prepare('SELECT COUNT(*) as c FROM product_delivery_fields').get().c;
  if (existing > 0) return;

  const insert = db.prepare(
    'INSERT INTO product_delivery_fields (product_id, field_key, field_label, sort_order) VALUES (?, ?, ?, ?)'
  );
  const defs = [
    // Immobilien (id 14) - von Jens vorgegeben
    [14, 'haustyp', 'Haustyp', 1],
    [14, 'wohnflaeche_qm', 'Wohnfläche (qm)', 2],
    [14, 'baujahr', 'Baujahr', 3],
    // Photovoltaik (id 3) - von Jens vorgegeben
    [3, 'dacheindeckung', 'Dacheindeckung', 1],
    [3, 'stromverbrauch_kwh_jahr', 'Stromverbrauch (kWh/Jahr)', 2],
    // Treppenlift (id 13) - Vorlage TRLFT-TR (multicall)
    [13, 'tl_eigentuemer', 'Eigentümer der Immobilie', 1],
    [13, 'tl_pflegegrad', 'Pflegegrad vorhanden', 2],
    [13, 'tl_treppenform', 'Treppenform', 3],
    [13, 'tl_etage', 'Etage', 4],
    [13, 'tl_woinstallieren', 'Installationsort (innen/außen)', 5],
    [13, 'tl_liftsuchen', 'Gesuchter Lifttyp', 6],
    // Kaffeevollautomaten (id 5) - Vorlage CP/Ormigo (multicall)
    [5, 'tasse', 'Tassen pro Tag', 1],
    // Wasserspender (id 7) - Vorlage aus der 11-Uhr-Auslieferung Selektion 837
    // (Ormigo - Wasser), Export-Template "cp_water"
    [7, 'tassen', 'Tassen pro Tag', 1],
    [7, 'branche', 'Branche', 2],
    // Snackautomaten (id 6) - gleiche Vorlage wie Wasserspender + Standort
    // (Indoor/Outdoor), von Jens vorgegeben (2026-10-12)
    [6, 'tassen', 'Tassen pro Tag', 1],
    [6, 'branche', 'Branche', 2],
    [6, 'standort', 'Standort (Indoor/Outdoor)', 3],
    // Waermepumpe (id 4) - Vorlage aus der 11-Uhr-Auslieferung Selektion 902
    // (Waermepumpe & Solar (WF)), Export-Template
    // "waermepumpe_solar_stammdaten_export" - Solar/PV-Flag auf Wunsch von
    // Jens wieder entfernt (2026-10-12), nur Wärmepumpe-Interesse relevant
    [4, 'wf_waermepumpe', 'Interesse Wärmepumpe', 1],
    // Alarmanlagen (id 11) und Videoueberwachung (id 12) - gleiche Vorlage,
    // abgeleitet aus Export-Template 245 ("SalesTeam - Alarmanlage"):
    // wert_aa-eingesetzt (Objektart) + wert_aa-nutzungsflaeche (qm), von
    // Jens vorgegeben (2026-10-12)
    [11, 'objektart', 'Objektart (Wohnung/Haus/Grundstück)', 1],
    [11, 'nutzungsflaeche_qm', 'Zu überwachende Fläche (bis 100/200/500/1000 qm oder mehr)', 2],
    [12, 'objektart', 'Objektart (Wohnung/Haus/Grundstück)', 1],
    [12, 'nutzungsflaeche_qm', 'Zu überwachende Fläche (bis 100/200/500/1000 qm oder mehr)', 2],
    // Strom & Gas / Haushalt (id 1) - von Jens vorgegeben (2026-10-12)
    [1, 'stromverbrauch_kwh_jahr', 'Aktueller Stromverbrauch/Jahr (kWh)', 1],
    [1, 'gasverbrauch_m3', 'Aktueller Gasverbrauch/Jahr (m³)', 2],
    // Fenster (8), Dachfenster (9), Haustueren (10) - gleiche Vorlage,
    // von Jens vorgegeben (2026-10-12)
    [8, 'immobilienart', 'Art der Immobilie (Haus/Wohnung)', 1],
    [8, 'neubau_bestand', 'Neubau oder Bestandsimmobilie', 2],
    [9, 'immobilienart', 'Art der Immobilie (Haus/Wohnung)', 1],
    [9, 'neubau_bestand', 'Neubau oder Bestandsimmobilie', 2],
    [10, 'immobilienart', 'Art der Immobilie (Haus/Wohnung)', 1],
    [10, 'neubau_bestand', 'Neubau oder Bestandsimmobilie', 2],
    // Senioren-Produkte: Alltagshilfe(15), Badumbau(16),
    // Elektrorollstuhl(17), Badewannenlift(18), Elektromobil(19) - gleiche
    // Vorlage, von Jens vorgegeben (2026-10-12), entspricht multicall
    // wert_pflegegrad (Werte: Nein / Ja / 1-5)
    [15, 'pflegegrad', 'Pflegegrad (falls vorhanden, welcher)', 1],
    [16, 'pflegegrad', 'Pflegegrad (falls vorhanden, welcher)', 1],
    [17, 'pflegegrad', 'Pflegegrad (falls vorhanden, welcher)', 1],
    [18, 'pflegegrad', 'Pflegegrad (falls vorhanden, welcher)', 1],
    [19, 'pflegegrad', 'Pflegegrad (falls vorhanden, welcher)', 1],
  ];
  for (const d of defs) insert.run(...d);
}

// Bestehende Pool-Einträge ohne Bundesland (vor Einführung dieses Felds
// importiert) rückwirkend aus der PLZ ableiten.
function backfillBundesland(db) {
  const { getBundeslandForPlz } = require('./lib/plzBundesland');
  const rows = db.prepare(
    "SELECT id, postal_code FROM lead_pool WHERE bundesland IS NULL AND postal_code IS NOT NULL"
  ).all();
  if (rows.length === 0) return;
  const update = db.prepare('UPDATE lead_pool SET bundesland = ? WHERE id = ?');
  db.transaction(() => {
    for (const row of rows) {
      const bl = getBundeslandForPlz(row.postal_code);
      if (bl) update.run(bl, row.id);
    }
  })();
}

function seedData(db) {
  const existingCategories = db.prepare('SELECT COUNT(*) as count FROM lead_categories').get();
  if (existingCategories.count > 0) return;

  const insertCategory = db.prepare('INSERT INTO lead_categories (name, icon, sort_order) VALUES (?, ?, ?)');
  const insertProduct = db.prepare('INSERT INTO lead_products (category_id, name, description, price, lead_type) VALUES (?, ?, ?, ?, ?)');

  const seed = db.transaction(() => {
    const cat1 = insertCategory.run('Energie & Haustechnik', '⚡', 1).lastInsertRowid;
    insertProduct.run(cat1, 'Strom & Gas (Haushalt)', 'Telefonisch qualifizierte Leads mit bestätigtem Interesse an Strom- und Gaswechsel. Inkl. Gesprächsaufnahme.', 19.90, 'b2c');
    insertProduct.run(cat1, 'Energieberatung', 'Telefonisch qualifizierte Leads mit bestätigtem Interesse an Energieberatung. Inkl. Gesprächsaufnahme.', 24.90, 'b2c');
    insertProduct.run(cat1, 'Photovoltaik', 'Telefonisch qualifizierte Leads mit bestätigtem Interesse an Photovoltaik-Anlagen. Inkl. Gesprächsaufnahme.', 49.90, 'b2c');
    insertProduct.run(cat1, 'Wärmepumpe', 'Telefonisch qualifizierte Leads mit bestätigtem Interesse an Wärmepumpen. Inkl. Gesprächsaufnahme.', 49.90, 'b2c');

    const cat2 = insertCategory.run('Automaten', '☕', 2).lastInsertRowid;
    insertProduct.run(cat2, 'Kaffeevollautomaten', 'Telefonisch qualifizierte Leads von Unternehmen mit Interesse an Kaffeevollautomaten. Inkl. Gesprächsaufnahme.', 59.90, 'b2b');
    insertProduct.run(cat2, 'Snackautomaten', 'Telefonisch qualifizierte Leads von Unternehmen mit Interesse an Snackautomaten. Inkl. Gesprächsaufnahme.', 59.90, 'b2b');
    insertProduct.run(cat2, 'Wasserspender', 'Telefonisch qualifizierte Leads von Unternehmen mit Interesse an Wasserspendern. Inkl. Gesprächsaufnahme.', 59.90, 'b2b');

    const cat3 = insertCategory.run('Haus & Sicherheit', '🏠', 3).lastInsertRowid;
    insertProduct.run(cat3, 'Fenster', 'Telefonisch qualifizierte Leads mit bestätigtem Interesse an neuen Fenstern. Inkl. Gesprächsaufnahme.', 39.90, 'b2c');
    insertProduct.run(cat3, 'Dachfenster', 'Telefonisch qualifizierte Leads mit bestätigtem Interesse an Dachfenstern. Inkl. Gesprächsaufnahme.', 39.90, 'b2c');
    insertProduct.run(cat3, 'Haustüren', 'Telefonisch qualifizierte Leads mit bestätigtem Interesse an neuen Haustüren. Inkl. Gesprächsaufnahme.', 39.90, 'b2c');
    insertProduct.run(cat3, 'Alarmanlagen', 'Telefonisch qualifizierte Leads mit bestätigtem Interesse an Alarmanlagen. Inkl. Gesprächsaufnahme.', 39.90, 'b2c');
    insertProduct.run(cat3, 'Videoüberwachung', 'Telefonisch qualifizierte Leads mit bestätigtem Interesse an Videoüberwachung. Inkl. Gesprächsaufnahme.', 39.90, 'b2c');

    const cat4 = insertCategory.run('Immobilien', '🏢', 4).lastInsertRowid;
    insertProduct.run(cat4, 'Treppenlift', 'Telefonisch qualifizierte Leads mit bestätigtem Interesse an Treppenliften. Inkl. Gesprächsaufnahme.', 119.90, 'b2c');
    insertProduct.run(cat4, 'Immobilien', 'Telefonisch qualifizierte Leads von Immobilienverkäufern. Inkl. Gesprächsaufnahme.', 149.90, 'b2c');

    // Senioren-Produkte: nur partnerseitig genutzt (Käuferseite/Marktplatz
    // existiert nicht), Preis daher Platzhalter 0 - Provision für
    // Einlieferer wird nachträglich separat eingerichtet.
    const cat5 = insertCategory.run('Senioren-Produkte', '🦽', 5).lastInsertRowid;
    insertProduct.run(cat5, 'Alltagshilfe', 'Leads mit Interesse an Alltagshilfe.', 0, 'b2c');
    insertProduct.run(cat5, 'Badumbau', 'Leads mit Interesse an altersgerechtem Badumbau.', 0, 'b2c');
    insertProduct.run(cat5, 'Elektrorollstuhl', 'Leads mit Interesse an Elektrorollstühlen.', 0, 'b2c');
    insertProduct.run(cat5, 'Badewannenlift', 'Leads mit Interesse an Badewannenliften.', 0, 'b2c');
    insertProduct.run(cat5, 'Elektromobil', 'Leads mit Interesse an Elektromobilen.', 0, 'b2c');

    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const adminHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
      db.prepare(`
        INSERT OR IGNORE INTO users (email, password_hash, first_name, last_name, role)
        VALUES (?, ?, ?, ?, ?)
      `).run(process.env.ADMIN_EMAIL, adminHash, 'Admin', 'LeadArea', 'admin');
    }
  });

  seed();
}

module.exports = { getDb, initializeDatabase };
