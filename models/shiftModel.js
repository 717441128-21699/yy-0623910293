const { queryOne, queryAll, execRun, saveDatabase, getLastInsertId, getChangesCount } = require('../config/database');
const AlertModel = require('./alertModel');

const SHIFT_TYPES = ['morning', 'afternoon', 'night'];
const SHIFT_TYPE_LABELS = { morning: '早班', afternoon: '中班', night: '晚班' };
const SHIFT_STATUSES = ['active', 'handed_over', 'archived'];
const SHIFT_STATUS_LABELS = { active: '值班中', handed_over: '已交班', archived: '已归档' };

class ShiftModel {
  static create(data) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    execRun(`
      INSERT INTO duty_shifts (shift_name, shift_type, handover_person, successor_person, start_time, notes, status, created_at)
      VALUES ($shift_name, $shift_type, $handover_person, $successor_person, $start_time, $notes, $status, $created_at)
    `, {
      $shift_name: data.shift_name || SHIFT_TYPE_LABELS[data.shift_type] + ' ' + now.substring(0, 10),
      $shift_type: data.shift_type || 'morning',
      $handover_person: data.handover_person || null,
      $successor_person: data.successor_person || null,
      $start_time: data.start_time || now,
      $notes: data.notes || null,
      $status: 'active',
      $created_at: now
    });
    saveDatabase();
    return this.getById(getLastInsertId());
  }

  static getById(id) {
    const row = queryOne('SELECT * FROM duty_shifts WHERE id = $id', { $id: id });
    if (row) row.shift_type_label = SHIFT_TYPE_LABELS[row.shift_type] || row.shift_type;
    if (row) row.status_label = SHIFT_STATUS_LABELS[row.status] || row.status;
    return row;
  }

  static getAll({ status, shift_type, page = 1, pageSize = 20 } = {}) {
    const offset = (page - 1) * pageSize;
    let where = [];
    let params = {};
    if (status) { where.push('status = $status'); params.$status = status; }
    if (shift_type) { where.push('shift_type = $shift_type'); params.$shift_type = shift_type; }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = queryOne(`SELECT COUNT(*) as count FROM duty_shifts ${whereSql}`, params).count;
    const list = queryAll(`
      SELECT * FROM duty_shifts ${whereSql}
      ORDER BY start_time DESC
      LIMIT $pageSize OFFSET $offset
    `, { ...params, $pageSize: pageSize, $offset: offset });
    for (const r of list) {
      r.shift_type_label = SHIFT_TYPE_LABELS[r.shift_type] || r.shift_type;
      r.status_label = SHIFT_STATUS_LABELS[r.status] || r.status;
    }
    return { total, page, pageSize, list };
  }

  static getActive() {
    return queryOne("SELECT * FROM duty_shifts WHERE status = 'active' ORDER BY start_time DESC LIMIT 1");
  }

  static getPrevious(shiftId) {
    return queryOne('SELECT * FROM duty_shifts WHERE id < $id AND status IN (\'handed_over\',\'archived\') ORDER BY id DESC LIMIT 1', { $id: shiftId });
  }

  static handover(id, data) {
    const shift = this.getById(id);
    if (!shift) return null;
    if (shift.status === 'handed_over' || shift.status === 'archived') return null;

    const summary = this.buildHandoverSummary(id);
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

    execRun(`
      UPDATE duty_shifts SET
        successor_person = $successor_person,
        handover_summary = $handover_summary,
        end_time = $end_time,
        handover_at = $handover_at,
        notes = $notes,
        status = 'handed_over',
        updated_at = CURRENT_TIMESTAMP
      WHERE id = $id
    `, {
      $id: id,
      $successor_person: data.successor_person || shift.successor_person,
      $handover_summary: JSON.stringify(summary),
      $end_time: now,
      $handover_at: now,
      $notes: data.notes || shift.notes,
    });
    saveDatabase();
    const result = this.getById(id);
    result.handover_summary = summary;
    return result;
  }

  static buildHandoverSummary(shiftId) {
    const unclosedAlerts = queryAll(`
      SELECT a.id, a.alert_uuid, a.alert_level, a.department, a.status, a.matched_count,
             a.suspected_location, a.first_seen_at, a.last_updated_at, r.rule_name
      FROM alerts a
      LEFT JOIN rules r ON a.rule_id = r.id
      WHERE a.status IN ('pending','notified','processing','plan_activated')
      ORDER BY last_updated_at DESC
    `, {});

    const unclosedByDept = {};
    for (const a of unclosedAlerts) {
      const dept = a.department || '未指派';
      if (!unclosedByDept[dept]) unclosedByDept[dept] = { count: 0, levels: {} };
      unclosedByDept[dept].count++;
      unclosedByDept[dept].levels[a.alert_level] = (unclosedByDept[dept].levels[a.alert_level] || 0) + 1;
    }

    const recentFailedPushes = queryAll(`
      SELECT pl.id, pl.alert_uuid, pl.channel_name, pl.channel_type, pl.error_message, pl.pushed_at
      FROM push_logs pl
      WHERE pl.status = 'failed'
        AND pl.pushed_at >= datetime('now', '-2 hours')
      ORDER BY pl.pushed_at DESC
      LIMIT 20
    `, {});

    return {
      shift_id: shiftId,
      unclosed_alert_count: unclosedAlerts.length,
      unclosed_alerts: unclosedAlerts.slice(0, 30),
      unclosed_by_department: unclosedByDept,
      recent_failed_pushes: recentFailedPushes,
      generated_at: new Date().toISOString().replace('T', ' ').substring(0, 19)
    };
  }

  static updateNotes(id, notes) {
    execRun('UPDATE duty_shifts SET notes = $notes, updated_at = CURRENT_TIMESTAMP WHERE id = $id', { $id: id, $notes: notes });
    saveDatabase();
    return this.getById(id);
  }
}

module.exports = { ShiftModel, SHIFT_TYPES, SHIFT_TYPE_LABELS, SHIFT_STATUSES, SHIFT_STATUS_LABELS };
