import Database from 'better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure data directory exists
const dbDir = dirname(join(__dirname, '..', config.dbPath));
mkdirSync(dbDir, { recursive: true });

const db = new Database(join(__dirname, '..', config.dbPath));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  -- Daily progress entries
  CREATE TABLE IF NOT EXISTS progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT NOT NULL,
    percentage REAL DEFAULT 0,
    location TEXT,
    reported_by TEXT,
    photo TEXT,
    photos TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- Materials tracking
  CREATE TABLE IF NOT EXISTS materials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    material_name TEXT NOT NULL,
    category TEXT NOT NULL,
    quantity REAL NOT NULL,
    unit TEXT NOT NULL,
    supplier TEXT,
    po_number TEXT,
    delivery_note TEXT,
    received_by TEXT,
    location TEXT,
    photo TEXT,
    photos TEXT,
    status TEXT DEFAULT 'received',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- Issues tracking
  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'open',
    location TEXT,
    reported_by TEXT,
    assigned_to TEXT,
    photo TEXT,
    photos TEXT,
    resolution TEXT,
    resolved_at TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- Work orders / tasks
  CREATE TABLE IF NOT EXISTS work_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'pending',
    assigned_to TEXT,
    due_date TEXT,
    completed_at TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- Labour attendance
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    worker_name TEXT NOT NULL,
    contractor TEXT,
    role TEXT,
    status TEXT DEFAULT 'present',
    hours_worked REAL DEFAULT 8,
    overtime REAL DEFAULT 0,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- Daily site diary
  CREATE TABLE IF NOT EXISTS diary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    weather TEXT,
    temperature TEXT,
    visitors TEXT,
    general_notes TEXT,
    safety_notes TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  -- Project milestones
  CREATE TABLE IF NOT EXISTS milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    target_date TEXT,
    actual_date TEXT,
    status TEXT DEFAULT 'pending',
    percentage REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// Lightweight migration for DBs created before the multi-photo (photos JSON) column
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`  · schema: added ${table}.${column}`);
  }
}
['progress', 'materials', 'issues'].forEach(t => ensureColumn(t, 'photos', 'TEXT'));

// Dates are stored DD/MM/YYYY, which doesn't sort or compare as text.
// Rearrange to YYYY-MM-DD inside SQL for range filters and ordering.
const ISO_DATE = "(substr(date,7,4)||'-'||substr(date,4,2)||'-'||substr(date,1,2))";
const toISO = (d) => d.split('/').reverse().join('-');

// Alphabetical priority DESC gives urgent, medium, low, high - rank explicitly.
const PRIORITY_ORDER = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

// Progress operations
export const progressDB = {
  add(data) {
    const stmt = db.prepare(`
      INSERT INTO progress (date, category, description, percentage, location, reported_by, photo)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(data.date, data.category, data.description, data.percentage || 0, data.location, data.reportedBy, data.photo);
  },

  getByDate(date) {
    return db.prepare('SELECT * FROM progress WHERE date = ? ORDER BY created_at DESC').all(date);
  },

  getByDateRange(startDate, endDate) {
    return db.prepare(`SELECT * FROM progress WHERE ${ISO_DATE} BETWEEN ? AND ? ORDER BY ${ISO_DATE} DESC, created_at DESC`).all(toISO(startDate), toISO(endDate));
  },

  getById(id) {
    return db.prepare('SELECT * FROM progress WHERE id = ?').get(id);
  },

  getByCategory(category) {
    return db.prepare(`SELECT * FROM progress WHERE category = ? ORDER BY ${ISO_DATE} DESC`).all(category);
  },

  getRecent(limit = 10) {
    return db.prepare('SELECT * FROM progress ORDER BY created_at DESC LIMIT ?').all(limit);
  },

  getOverallProgress() {
    return db.prepare('SELECT AVG(percentage) as avg_progress FROM progress WHERE date = date("now", "localtime")').get();
  },

  delete(id) {
    return db.prepare('DELETE FROM progress WHERE id = ?').run(id);
  },

  updatePhoto(id, photoPath) {
    return db.prepare("UPDATE progress SET photo = ? WHERE id = ?").run(photoPath, id);
  },

  updatePhotos(id, photoPaths) {
    const photosJson = (photoPaths && photoPaths.length) ? JSON.stringify(photoPaths) : null;
    return db.prepare("UPDATE progress SET photos = ? WHERE id = ?").run(photosJson, id);
  }
};

// Materials operations
export const materialsDB = {
  add(data) {
    const stmt = db.prepare(`
      INSERT INTO materials (date, material_name, category, quantity, unit, supplier, po_number, delivery_note, received_by, location, photo, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(data.date, data.materialName, data.category, data.quantity, data.unit, data.supplier, data.poNumber, data.deliveryNote, data.receivedBy, data.location, data.photo, data.status || 'received', data.notes);
  },

  getByDate(date) {
    return db.prepare('SELECT * FROM materials WHERE date = ? ORDER BY created_at DESC').all(date);
  },

  getByDateRange(startDate, endDate) {
    return db.prepare(`SELECT * FROM materials WHERE ${ISO_DATE} BETWEEN ? AND ? ORDER BY ${ISO_DATE} DESC`).all(toISO(startDate), toISO(endDate));
  },

  getByCategory(category) {
    return db.prepare(`SELECT * FROM materials WHERE category = ? ORDER BY ${ISO_DATE} DESC`).all(category);
  },

  getByName(name) {
    return db.prepare(`SELECT * FROM materials WHERE material_name LIKE ? ORDER BY ${ISO_DATE} DESC`).all(`%${name}%`);
  },

  getById(id) {
    return db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
  },

  getRecent(limit = 10) {
    return db.prepare('SELECT * FROM materials ORDER BY created_at DESC LIMIT ?').all(limit);
  },

  getStockSummary() {
    return db.prepare(`
      SELECT material_name, category, SUM(quantity) as total_qty, unit
      FROM materials 
      WHERE status = 'received'
      GROUP BY material_name, unit
      ORDER BY material_name
    `).all();
  },

  updateStatus(id, status) {
    return db.prepare('UPDATE materials SET status = ? WHERE id = ?').run(status, id);
  },

  delete(id) {
    return db.prepare('DELETE FROM materials WHERE id = ?').run(id);
  },

  updatePhoto(id, photoPath) {
    return db.prepare("UPDATE materials SET photo = ? WHERE id = ?").run(photoPath, id);
  },

  updatePhotos(id, photoPaths) {
    const photosJson = (photoPaths && photoPaths.length) ? JSON.stringify(photoPaths) : null;
    return db.prepare("UPDATE materials SET photos = ? WHERE id = ?").run(photosJson, id);
  }
};

// Issues operations
export const issuesDB = {
  add(data) {
    const stmt = db.prepare(`
      INSERT INTO issues (date, title, description, category, priority, status, location, reported_by, assigned_to, photo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(data.date, data.title, data.description, data.category, data.priority || 'medium', data.status || 'open', data.location, data.reportedBy, data.assignedTo, data.photo);
  },

  getById(id) {
    return db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  },

  getByDate(date) {
    return db.prepare('SELECT * FROM issues WHERE date = ? ORDER BY created_at DESC').all(date);
  },

  getByStatus(status) {
    return db.prepare(`SELECT * FROM issues WHERE status = ? ORDER BY ${PRIORITY_ORDER}, created_at DESC`).all(status);
  },

  getByPriority(priority) {
    return db.prepare('SELECT * FROM issues WHERE priority = ? ORDER BY created_at DESC').all(priority);
  },

  getOpenIssues() {
    return db.prepare(`SELECT * FROM issues WHERE status IN ('open', 'in_progress') ORDER BY ${PRIORITY_ORDER}, created_at DESC`).all();
  },

  getRecent(limit = 10) {
    return db.prepare('SELECT * FROM issues ORDER BY created_at DESC LIMIT ?').all(limit);
  },

  updateStatus(id, status, resolution = null) {
    if (resolution) {
      return db.prepare("UPDATE issues SET status = ?, resolution = ?, resolved_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime') WHERE id = ?").run(status, resolution, id);
    }
    return db.prepare("UPDATE issues SET status = ?, updated_at = datetime('now', 'localtime') WHERE id = ?").run(status, id);
  },

  update(id, data) {
    const fields = [];
    const values = [];
    
    if (data.assignedTo !== undefined) {
      fields.push('assigned_to = ?');
      values.push(data.assignedTo);
    }
    if (data.priority !== undefined) {
      fields.push('priority = ?');
      values.push(data.priority);
    }
    
    fields.push("updated_at = datetime('now', 'localtime')");
    values.push(id);
    
    return db.prepare(`UPDATE issues SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  getStats() {
    return db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN priority = 'urgent' AND status IN ('open', 'in_progress') THEN 1 ELSE 0 END) as urgent_open,
        SUM(CASE WHEN priority = 'high' AND status IN ('open', 'in_progress') THEN 1 ELSE 0 END) as high_open
      FROM issues
    `).get();
  },

  delete(id) {
    return db.prepare('DELETE FROM issues WHERE id = ?').run(id);
  },

  updatePhoto(id, photoPath) {
    return db.prepare("UPDATE issues SET photo = ? WHERE id = ?").run(photoPath, id);
  },

  updatePhotos(id, photoPaths) {
    const photosJson = (photoPaths && photoPaths.length) ? JSON.stringify(photoPaths) : null;
    return db.prepare("UPDATE issues SET photos = ? WHERE id = ?").run(photosJson, id);
  }
};

// Work orders operations
export const workOrdersDB = {
  add(data) {
    const stmt = db.prepare(`
      INSERT INTO work_orders (date, title, description, category, priority, status, assigned_to, due_date, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(data.date, data.title, data.description, data.category, data.priority || 'medium', data.status || 'pending', data.assignedTo, data.dueDate, data.notes);
  },

  getById(id) {
    return db.prepare('SELECT * FROM work_orders WHERE id = ?').get(id);
  },

  getPending() {
    return db.prepare(`SELECT * FROM work_orders WHERE status = 'pending' ORDER BY ${PRIORITY_ORDER}, due_date ASC`).all();
  },

  getRecent(limit = 10) {
    return db.prepare('SELECT * FROM work_orders ORDER BY created_at DESC LIMIT ?').all(limit);
  },

  updateStatus(id, status) {
    if (status === 'completed') {
      return db.prepare("UPDATE work_orders SET status = ?, completed_at = datetime('now', 'localtime') WHERE id = ?").run(status, id);
    }
    return db.prepare('UPDATE work_orders SET status = ? WHERE id = ?').run(status, id);
  },

  delete(id) {
    return db.prepare('DELETE FROM work_orders WHERE id = ?').run(id);
  }
};

// Attendance operations
export const attendanceDB = {
  add(data) {
    const stmt = db.prepare(`
      INSERT INTO attendance (date, worker_name, contractor, role, status, hours_worked, overtime, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    return stmt.run(data.date, data.workerName, data.contractor, data.role, data.status || 'present', data.hoursWorked || 8, data.overtime || 0, data.notes);
  },

  getByDate(date) {
    return db.prepare('SELECT * FROM attendance WHERE date = ? ORDER BY worker_name').all(date);
  },

  getWorkerSummary(workerName) {
    return db.prepare(`
      SELECT 
        worker_name,
        COUNT(*) as days_worked,
        SUM(hours_worked) as total_hours,
        SUM(overtime) as total_overtime
      FROM attendance 
      WHERE worker_name LIKE ? AND ${ISO_DATE} >= date('now', 'localtime', '-30 days')
      GROUP BY worker_name
    `).get(`%${workerName}%`);
  },

  getDailyCount(date) {
    return db.prepare('SELECT COUNT(*) as count FROM attendance WHERE date = ?').get(date);
  }
};

// Diary operations
export const diaryDB = {
  upsert(data) {
    const stmt = db.prepare(`
      INSERT INTO diary (date, weather, temperature, visitors, general_notes, safety_notes)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET
        weather = excluded.weather,
        temperature = excluded.temperature,
        visitors = excluded.visitors,
        general_notes = excluded.general_notes,
        safety_notes = excluded.safety_notes,
        updated_at = datetime('now', 'localtime')
    `);
    return stmt.run(data.date, data.weather, data.temperature, data.visitors, data.generalNotes, data.safetyNotes);
  },

  getByDate(date) {
    return db.prepare('SELECT * FROM diary WHERE date = ?').get(date);
  },

  getRecent(limit = 7) {
    return db.prepare(`SELECT * FROM diary ORDER BY ${ISO_DATE} DESC LIMIT ?`).all(limit);
  }
};

// Milestones operations
export const milestonesDB = {
  add(data) {
    const stmt = db.prepare(`
      INSERT INTO milestones (title, description, target_date, status, percentage)
      VALUES (?, ?, ?, ?, ?)
    `);
    return stmt.run(data.title, data.description, data.targetDate, data.status || 'pending', data.percentage || 0);
  },

  getAll() {
    return db.prepare('SELECT * FROM milestones ORDER BY target_date ASC').all();
  },

  update(id, data) {
    const fields = [];
    const values = [];
    
    if (data.percentage !== undefined) {
      fields.push('percentage = ?');
      values.push(data.percentage);
    }
    if (data.status !== undefined) {
      fields.push('status = ?');
      values.push(data.status);
    }
    if (data.actualDate !== undefined) {
      fields.push('actual_date = ?');
      values.push(data.actualDate);
    }
    
    values.push(id);
    return db.prepare(`UPDATE milestones SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  },

  delete(id) {
    return db.prepare('DELETE FROM milestones WHERE id = ?').run(id);
  }
};

export default db;
