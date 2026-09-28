import postgres from 'postgres';
import config from '../config.js';

// Supabase Postgres. Tables are created once from supabase/schema.sql.
if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is not set - see .env.example');
}
// SSL for Supabase; a local test DB (localhost) doesn't speak it.
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(config.databaseUrl);
export const sql = postgres(config.databaseUrl, { ssl: isLocal ? false : 'require' });

// Run a query with $1, $2... placeholders. undefined/NaN -> NULL so a bad
// id (e.g. parseInt('abc')) just matches nothing, as it did under SQLite.
const q = (text, ...params) => sql.unsafe(text, params.map(p => p === undefined || Number.isNaN(p) ? null : p));
const one = async (text, ...params) => (await q(text, ...params))[0];
const insert = async (text, ...params) => ({ lastInsertRowid: (await one(text + ' RETURNING id', ...params)).id });
const change = async (text, ...params) => ({ changes: (await q(text, ...params)).count });

// Dates are stored DD/MM/YYYY, which doesn't sort or compare as text.
// Rearrange to YYYY-MM-DD inside SQL for range filters and ordering.
const ISO_DATE = "(substr(date,7,4)||'-'||substr(date,4,2)||'-'||substr(date,1,2))";
const toISO = (d) => d.split('/').reverse().join('-');

// Alphabetical priority DESC gives urgent, medium, low, high - rank explicitly.
const PRIORITY_ORDER = "CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END";

const photosJson = (photoPaths) => (photoPaths && photoPaths.length) ? JSON.stringify(photoPaths) : null;

// Progress operations
export const progressDB = {
  add(data) {
    return insert(`
      INSERT INTO progress (date, category, description, percentage, location, reported_by, photo)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, data.date, data.category, data.description, data.percentage || 0, data.location, data.reportedBy, data.photo);
  },

  getByDate(date) {
    return q('SELECT * FROM progress WHERE date = $1 ORDER BY created_at DESC', date);
  },

  getByDateRange(startDate, endDate) {
    return q(`SELECT * FROM progress WHERE ${ISO_DATE} BETWEEN $1 AND $2 ORDER BY ${ISO_DATE} DESC, created_at DESC`, toISO(startDate), toISO(endDate));
  },

  getById(id) {
    return one('SELECT * FROM progress WHERE id = $1', id);
  },

  getByCategory(category) {
    return q(`SELECT * FROM progress WHERE category = $1 ORDER BY ${ISO_DATE} DESC`, category);
  },

  getRecent(limit = 10) {
    return q('SELECT * FROM progress ORDER BY created_at DESC LIMIT $1', limit);
  },

  delete(id) {
    return change('DELETE FROM progress WHERE id = $1', id);
  },

  updatePhoto(id, photoPath) {
    return change('UPDATE progress SET photo = $1 WHERE id = $2', photoPath, id);
  },

  updatePhotos(id, photoPaths) {
    return change('UPDATE progress SET photos = $1 WHERE id = $2', photosJson(photoPaths), id);
  }
};

// Materials operations
export const materialsDB = {
  add(data) {
    return insert(`
      INSERT INTO materials (date, material_name, category, quantity, unit, supplier, po_number, delivery_note, received_by, location, photo, status, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    `, data.date, data.materialName, data.category, data.quantity, data.unit, data.supplier, data.poNumber, data.deliveryNote, data.receivedBy, data.location, data.photo, data.status || 'received', data.notes);
  },

  getByDate(date) {
    return q('SELECT * FROM materials WHERE date = $1 ORDER BY created_at DESC', date);
  },

  getByDateRange(startDate, endDate) {
    return q(`SELECT * FROM materials WHERE ${ISO_DATE} BETWEEN $1 AND $2 ORDER BY ${ISO_DATE} DESC`, toISO(startDate), toISO(endDate));
  },

  getByCategory(category) {
    return q(`SELECT * FROM materials WHERE category = $1 ORDER BY ${ISO_DATE} DESC`, category);
  },

  getByName(name) {
    return q(`SELECT * FROM materials WHERE material_name ILIKE $1 ORDER BY ${ISO_DATE} DESC`, `%${name}%`);
  },

  getById(id) {
    return one('SELECT * FROM materials WHERE id = $1', id);
  },

  getRecent(limit = 10) {
    return q('SELECT * FROM materials ORDER BY created_at DESC LIMIT $1', limit);
  },

  getStockSummary() {
    return q(`
      SELECT material_name, MIN(category) as category, SUM(quantity)::float8 as total_qty, unit
      FROM materials
      WHERE status = 'received'
      GROUP BY material_name, unit
      ORDER BY material_name
    `);
  },

  updateStatus(id, status) {
    return change('UPDATE materials SET status = $1 WHERE id = $2', status, id);
  },

  delete(id) {
    return change('DELETE FROM materials WHERE id = $1', id);
  },

  updatePhoto(id, photoPath) {
    return change('UPDATE materials SET photo = $1 WHERE id = $2', photoPath, id);
  },

  updatePhotos(id, photoPaths) {
    return change('UPDATE materials SET photos = $1 WHERE id = $2', photosJson(photoPaths), id);
  }
};

// Issues operations
export const issuesDB = {
  add(data) {
    return insert(`
      INSERT INTO issues (date, title, description, category, priority, status, location, reported_by, assigned_to, photo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, data.date, data.title, data.description, data.category, data.priority || 'medium', data.status || 'open', data.location, data.reportedBy, data.assignedTo, data.photo);
  },

  getById(id) {
    return one('SELECT * FROM issues WHERE id = $1', id);
  },

  getByDate(date) {
    return q('SELECT * FROM issues WHERE date = $1 ORDER BY created_at DESC', date);
  },

  getByStatus(status) {
    return q(`SELECT * FROM issues WHERE status = $1 ORDER BY ${PRIORITY_ORDER}, created_at DESC`, status);
  },

  getByPriority(priority) {
    return q('SELECT * FROM issues WHERE priority = $1 ORDER BY created_at DESC', priority);
  },

  getOpenIssues() {
    return q(`SELECT * FROM issues WHERE status IN ('open', 'in_progress') ORDER BY ${PRIORITY_ORDER}, created_at DESC`);
  },

  getRecent(limit = 10) {
    return q('SELECT * FROM issues ORDER BY created_at DESC LIMIT $1', limit);
  },

  updateStatus(id, status, resolution = null) {
    if (resolution) {
      return change('UPDATE issues SET status = $1, resolution = $2, resolved_at = local_now(), updated_at = local_now() WHERE id = $3', status, resolution, id);
    }
    return change('UPDATE issues SET status = $1, updated_at = local_now() WHERE id = $2', status, id);
  },

  update(id, data) {
    const fields = [];
    const values = [];

    if (data.assignedTo !== undefined) {
      values.push(data.assignedTo);
      fields.push(`assigned_to = $${values.length}`);
    }
    if (data.priority !== undefined) {
      values.push(data.priority);
      fields.push(`priority = $${values.length}`);
    }

    fields.push('updated_at = local_now()');
    values.push(id);

    return change(`UPDATE issues SET ${fields.join(', ')} WHERE id = $${values.length}`, ...values);
  },

  getStats() {
    return one(`
      SELECT
        COUNT(*)::int as total,
        COUNT(*) FILTER (WHERE status = 'open')::int as open,
        COUNT(*) FILTER (WHERE status = 'in_progress')::int as in_progress,
        COUNT(*) FILTER (WHERE status = 'resolved')::int as resolved,
        COUNT(*) FILTER (WHERE status = 'closed')::int as closed,
        COUNT(*) FILTER (WHERE priority = 'urgent' AND status IN ('open', 'in_progress'))::int as urgent_open,
        COUNT(*) FILTER (WHERE priority = 'high' AND status IN ('open', 'in_progress'))::int as high_open
      FROM issues
    `);
  },

  delete(id) {
    return change('DELETE FROM issues WHERE id = $1', id);
  },

  updatePhoto(id, photoPath) {
    return change('UPDATE issues SET photo = $1 WHERE id = $2', photoPath, id);
  },

  updatePhotos(id, photoPaths) {
    return change('UPDATE issues SET photos = $1 WHERE id = $2', photosJson(photoPaths), id);
  }
};

// Work orders operations
export const workOrdersDB = {
  add(data) {
    return insert(`
      INSERT INTO work_orders (date, title, description, category, priority, status, assigned_to, due_date, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, data.date, data.title, data.description, data.category, data.priority || 'medium', data.status || 'pending', data.assignedTo, data.dueDate, data.notes);
  },

  getById(id) {
    return one('SELECT * FROM work_orders WHERE id = $1', id);
  },

  getPending() {
    return q(`SELECT * FROM work_orders WHERE status = 'pending' ORDER BY ${PRIORITY_ORDER}, due_date ASC`);
  },

  getRecent(limit = 10) {
    return q('SELECT * FROM work_orders ORDER BY created_at DESC LIMIT $1', limit);
  },

  updateStatus(id, status) {
    if (status === 'completed') {
      return change('UPDATE work_orders SET status = $1, completed_at = local_now() WHERE id = $2', status, id);
    }
    return change('UPDATE work_orders SET status = $1 WHERE id = $2', status, id);
  },

  delete(id) {
    return change('DELETE FROM work_orders WHERE id = $1', id);
  }
};

// Attendance operations
export const attendanceDB = {
  add(data) {
    return insert(`
      INSERT INTO attendance (date, worker_name, contractor, role, status, hours_worked, overtime, notes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, data.date, data.workerName, data.contractor, data.role, data.status || 'present', data.hoursWorked || 8, data.overtime || 0, data.notes);
  },

  getByDate(date) {
    return q('SELECT * FROM attendance WHERE date = $1 ORDER BY worker_name', date);
  },

  getWorkerSummary(workerName) {
    return one(`
      SELECT
        worker_name,
        COUNT(*)::int as days_worked,
        SUM(hours_worked)::float8 as total_hours,
        SUM(overtime)::float8 as total_overtime
      FROM attendance
      WHERE worker_name ILIKE $1 AND ${ISO_DATE} >= to_char((now() at time zone 'Asia/Kuala_Lumpur')::date - 30, 'YYYY-MM-DD')
      GROUP BY worker_name
    `, `%${workerName}%`);
  },

  getDailyCount(date) {
    return one('SELECT COUNT(*)::int as count FROM attendance WHERE date = $1', date);
  }
};

// Diary operations
export const diaryDB = {
  upsert(data) {
    return change(`
      INSERT INTO diary (date, weather, temperature, visitors, general_notes, safety_notes)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT(date) DO UPDATE SET
        weather = excluded.weather,
        temperature = excluded.temperature,
        visitors = excluded.visitors,
        general_notes = excluded.general_notes,
        safety_notes = excluded.safety_notes,
        updated_at = local_now()
    `, data.date, data.weather, data.temperature, data.visitors, data.generalNotes, data.safetyNotes);
  },

  getByDate(date) {
    return one('SELECT * FROM diary WHERE date = $1', date);
  },

  getRecent(limit = 7) {
    return q(`SELECT * FROM diary ORDER BY ${ISO_DATE} DESC LIMIT $1`, limit);
  }
};

// Milestones operations
export const milestonesDB = {
  add(data) {
    return insert(`
      INSERT INTO milestones (title, description, target_date, status, percentage)
      VALUES ($1, $2, $3, $4, $5)
    `, data.title, data.description, data.targetDate, data.status || 'pending', data.percentage || 0);
  },

  getAll() {
    return q('SELECT * FROM milestones ORDER BY target_date ASC');
  },

  update(id, data) {
    const fields = [];
    const values = [];

    if (data.percentage !== undefined) {
      values.push(data.percentage);
      fields.push(`percentage = $${values.length}`);
    }
    if (data.status !== undefined) {
      values.push(data.status);
      fields.push(`status = $${values.length}`);
    }
    if (data.actualDate !== undefined) {
      values.push(data.actualDate);
      fields.push(`actual_date = $${values.length}`);
    }

    values.push(id);
    return change(`UPDATE milestones SET ${fields.join(', ')} WHERE id = $${values.length}`, ...values);
  },

  delete(id) {
    return change('DELETE FROM milestones WHERE id = $1', id);
  }
};
