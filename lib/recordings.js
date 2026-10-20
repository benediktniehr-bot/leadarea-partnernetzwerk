const fs = require('fs');
const path = require('path');
const { getDb } = require('../database');

// Bewusst außerhalb von public/ (nicht statisch servierbar) und getrennt von
// jeder Multicall-Infrastruktur - LeadArea-eigene Ablage.
const STORAGE_DIR = path.join(__dirname, '..', 'voicelogs');

function ensureStorageDir() {
  if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
  return STORAGE_DIR;
}

// Übernimmt eine bereits auf der Platte liegende Audiodatei (z.B. aus einem
// Upload-Tempverzeichnis) in die Voicelog-Ablage und verknüpft sie mit einem
// lead_pool-Eintrag. Wird NICHT automatisch an Käufer ausgeliefert - nur
// gezielt bei Reklamation abrufbar (siehe admin-Route).
function saveRecording({ poolLeadId, sourceFilePath, originalFilename, callDate, source }) {
  ensureStorageDir();
  const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
  const destName = unique + path.extname(originalFilename || sourceFilePath);
  const destPath = path.join(STORAGE_DIR, destName);
  fs.copyFileSync(sourceFilePath, destPath);

  const db = getDb();
  db.prepare(`
    INSERT INTO lead_recordings (pool_lead_id, voice_file, call_date, source)
    VALUES (?, ?, ?, ?)
  `).run(poolLeadId, destName, callDate || null, source || 'cc_parallel_import');

  return destName;
}

function getRecordingsForPoolLead(poolLeadId) {
  const db = getDb();
  return db.prepare('SELECT * FROM lead_recordings WHERE pool_lead_id = ? ORDER BY created_at DESC').all(poolLeadId);
}

function getRecordingFilePath(voiceFile) {
  // path.basename verhindert Path-Traversal über den DB-Wert
  return path.join(STORAGE_DIR, path.basename(voiceFile));
}

module.exports = { STORAGE_DIR, ensureStorageDir, saveRecording, getRecordingsForPoolLead, getRecordingFilePath };
