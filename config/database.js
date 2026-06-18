const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const DB_PATH = path.join(__dirname, '..', 'db', 'scenic_alert.db');

let dbInstance = null;
let SQL = null;
let saveTimer = null;
let dirty = false;
let _lastInsertId = null;

function markDirty() {
  dirty = true;
}

function saveDatabase() {
  if (!dbInstance || !dirty) return;
  try {
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    const tmpPath = DB_PATH + '.tmp';
    fs.writeFileSync(tmpPath, buffer);
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    fs.renameSync(tmpPath, DB_PATH);
    dirty = false;
  } catch (e) {
    console.error('[database] save error:', e.message);
  }
}

async function initDb() {
  if (dbInstance) return;
  SQL = await initSqlJs();

  const dbDir = path.dirname(DB_PATH);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    dbInstance = new SQL.Database(fileBuffer);
  } else {
    dbInstance = new SQL.Database();
    dirty = true;
    saveDatabase();
  }

  if (saveTimer) clearInterval(saveTimer);
  saveTimer = setInterval(saveDatabase, 2000);

  const origRun = dbInstance.run.bind(dbInstance);
  dbInstance.run = function (...args) {
    const result = origRun(...args);
    markDirty();
    return result;
  };

  const origExec = dbInstance.exec.bind(dbInstance);
  dbInstance.exec = function (...args) {
    const result = origExec(...args);
    markDirty();
    return result;
  };
}

function getDb() {
  if (!dbInstance) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return dbInstance;
}

function sanitizeParams(params) {
  const clean = {};
  for (const k of Object.keys(params)) {
    const v = params[k];
    if (v === undefined) {
      console.warn('[database] 警告: 参数', k, '为 undefined，已替换为 null');
      clean[k] = null;
    } else {
      clean[k] = v;
    }
  }
  return clean;
}

function queryOne(stmt, params = {}) {
  const cleanParams = sanitizeParams(params);
  const prepared = typeof stmt === 'string' ? getDb().prepare(stmt) : stmt;
  try {
    prepared.bind(cleanParams);
    if (!prepared.step()) {
      return null;
    }
    const row = prepared.getAsObject();
    if (!row) return null;
    const values = Object.values(row);
    if (values.length === 0) return null;
    const allUndefined = values.every(function (v) { return v === undefined || v === null; });
    return allUndefined ? null : row;
  } finally {
    prepared.reset();
    if (typeof stmt === 'string') prepared.free();
  }
}

function queryAll(stmt, params = {}) {
  const db = getDb();
  const cleanParams = sanitizeParams(params);
  const prepared = typeof stmt === 'string' ? db.prepare(stmt) : stmt;
  const results = [];
  try {
    prepared.bind(cleanParams);
    while (prepared.step()) {
      results.push(prepared.getAsObject());
    }
    return results;
  } finally {
    prepared.reset();
    if (typeof stmt === 'string') prepared.free();
  }
}

function execRun(sql, params = {}) {
  const db = getDb();
  const cleanParams = sanitizeParams(params);
  const prepared = db.prepare(sql);
  try {
    prepared.run(cleanParams);
    markDirty();
    // Capture last_insert_rowid() immediately after the run while the statement context is fresh
    const idRows = db.exec('SELECT last_insert_rowid() AS id');
    _lastInsertId = idRows && idRows[0] && idRows[0].values && idRows[0].values[0] ? idRows[0].values[0][0] : null;
  } finally {
    prepared.free();
  }
}

function getLastInsertId() {
  if (_lastInsertId !== null && _lastInsertId !== undefined) return _lastInsertId;
  const db = getDb();
  const rows = db.exec('SELECT last_insert_rowid() AS id');
  return rows && rows[0] && rows[0].values && rows[0].values[0] ? rows[0].values[0][0] : null;
}

function getChangesCount() {
  const db = getDb();
  const rows = db.exec('SELECT changes() AS cnt');
  return rows && rows[0] && rows[0].values && rows[0].values[0] ? rows[0].values[0][0] : 0;
}

function tableExists(name) {
  try {
    const row = queryOne(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=$name`,
      { $name: name }
    );
    return !!row;
  } catch (e) { return false; }
}

function columnExists(tableName, colName) {
  try {
    const rows = queryAll(`PRAGMA table_info(${tableName})`);
    return rows.some(r => String(r.name || r.Name || '').toLowerCase() === String(colName).toLowerCase());
  } catch (e) { return false; }
}

function addColumnIfMissing(table, col, definition) {
  if (!tableExists(table)) return false;
  if (columnExists(table, col)) return false;
  try {
    execRun(`ALTER TABLE ${table} ADD COLUMN ${col} ${definition}`);
    console.log(`[schema] 已为 ${table} 新增列: ${col}`);
    return true;
  } catch (e) {
    console.warn(`[schema] 新增列失败 ${table}.${col}:`, e.message);
    return false;
  }
}

function closeDb() {
  saveDatabase();
  if (saveTimer) {
    clearInterval(saveTimer);
    saveTimer = null;
  }
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

process.on('beforeExit', () => {
  try { closeDb(); } catch (e) {}
});
process.on('SIGINT', () => {
  try { closeDb(); } catch (e) {}
  process.exit(0);
});

module.exports = { initDb, getDb, closeDb, DB_PATH, saveDatabase, queryOne, queryAll, execRun, getLastInsertId, getChangesCount, tableExists, columnExists, addColumnIfMissing };
