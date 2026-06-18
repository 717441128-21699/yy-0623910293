const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll, execRun, saveDatabase, getLastInsertId, addColumnIfMissing } = require('../config/database');
const { PushLogModel } = require('./pushModel');

function ensureSchema() {
  addColumnIfMissing('alerts', 'suppress_until', 'DATETIME');
  addColumnIfMissing('alerts', 'reopen_count', 'INTEGER DEFAULT 0');
  addColumnIfMissing('alerts', 'last_notified_at', 'DATETIME');
}

class AlertModel {
  static getAll({ status, alert_level, department, source_platform,
    suspected_location, start_time, end_time,
    with_suppressed, page = 1, pageSize = 20 } = {}) {
    ensureSchema();
    const offset = (page - 1) * pageSize;
    let whereClauses = [];
    let params = {};

    if (status !== undefined && status !== 'all' && status !== '') {
      whereClauses.push('a.status = $status');
      params.$status = status;
    }
    if (alert_level !== undefined && alert_level !== 'all' && alert_level !== '') {
      whereClauses.push('a.alert_level = $alert_level');
      params.$alert_level = alert_level;
    }
    if (department !== undefined && department !== '') {
      whereClauses.push('a.department = $department');
      params.$department = department;
    }
    if (source_platform !== undefined && source_platform !== '') {
      whereClauses.push('a.source_platform LIKE $source_platform');
      params.$source_platform = `%${source_platform}%`;
    }
    if (suspected_location !== undefined && suspected_location !== '') {
      whereClauses.push('a.suspected_location LIKE $suspected_location');
      params.$suspected_location = `%${suspected_location}%`;
    }
    if (start_time) {
      whereClauses.push('a.first_seen_at >= $start_time');
      params.$start_time = String(start_time).replace('T', ' ').substring(0, 19);
    }
    if (end_time) {
      whereClauses.push('a.first_seen_at <= $end_time');
      params.$end_time = String(end_time).replace('T', ' ').substring(0, 19);
    }
    if (with_suppressed === 'false' || with_suppressed === false) {
      whereClauses.push('(a.suppress_until IS NULL OR a.suppress_until <= datetime(\'now\',\'localtime\'))');
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const total = queryOne(`SELECT COUNT(*) as count FROM alerts a ${whereSql}`, params).count;
    const list = queryAll(`
      SELECT a.*, r.rule_name,
             (SELECT COUNT(*) FROM callbacks c WHERE c.alert_id = a.id) as callback_count,
             (SELECT COUNT(*) FROM push_logs pl WHERE pl.alert_id = a.id) as push_count,
             (SELECT COUNT(*) FROM push_logs pl WHERE pl.alert_id = a.id AND pl.status='success') as push_success_count,
             (SELECT COUNT(*) FROM push_logs pl WHERE pl.alert_id = a.id AND pl.status='failed') as push_failed_count
      FROM alerts a
      LEFT JOIN rules r ON a.rule_id = r.id
      ${whereSql}
      ORDER BY a.last_updated_at DESC
      LIMIT $pageSize OFFSET $offset
    `, { ...params, $pageSize: pageSize, $offset: offset });

    return { total, page, pageSize, list };
  }

  static getById(id) {
    ensureSchema();
    const alert = queryOne(`
      SELECT a.*, r.rule_name
      FROM alerts a
      LEFT JOIN rules r ON a.rule_id = r.id
      WHERE a.id = $id
    `, { $id: id });
    if (alert) {
      alert.callbacks = queryAll('SELECT * FROM callbacks WHERE alert_id = $id ORDER BY callback_time DESC', { $id: id });
      alert.push_logs = PushLogModel.getByAlert(id);
    }
    return alert;
  }

  static getByUuid(alertUuid) {
    ensureSchema();
    const alert = queryOne(`
      SELECT a.*, r.rule_name
      FROM alerts a
      LEFT JOIN rules r ON a.rule_id = r.id
      WHERE a.alert_uuid = $uuid
    `, { $uuid: alertUuid });
    if (alert) {
      alert.callbacks = queryAll('SELECT * FROM callbacks WHERE alert_uuid = $uuid ORDER BY callback_time DESC', { $uuid: alertUuid });
      alert.push_logs = PushLogModel.getByAlert(alertUuid);
    }
    return alert;
  }

  static listDistinctDepartments() {
    return queryAll(`SELECT DISTINCT department FROM alerts WHERE department IS NOT NULL AND department != '' ORDER BY department`);
  }

  static listDistinctSources() {
    return queryAll(`SELECT DISTINCT source_platform FROM alerts WHERE source_platform IS NOT NULL AND source_platform != '' ORDER BY source_platform`);
  }

  static findActiveByRule(ruleId, thresholdMinutes) {
    ensureSchema();
    const statuses = `'pending','notified','processing','plan_activated'`;
    return queryOne(`
      SELECT * FROM alerts
      WHERE rule_id = $ruleId
        AND status IN (${statuses})
        AND first_seen_at >= datetime('now', '-' || $minutes || ' minutes')
        AND (suppress_until IS NULL OR suppress_until <= datetime('now','localtime'))
      ORDER BY first_seen_at DESC
      LIMIT 1
    `, { $ruleId: ruleId, $minutes: thresholdMinutes });
  }

  static findSuppressedByRuleDeptLocation(ruleId, department, location, suppressMinutes) {
    ensureSchema();
    if (!department) return null;
    const locationLike = location ? `AND COALESCE(suspected_location,'') LIKE '%' || $location || '%'` : '';
    const row = queryOne(`
      SELECT id, alert_uuid, suppress_until, matched_count
      FROM alerts
      WHERE rule_id = $ruleId
        AND department = $department
        AND status IN ('verified_normal','false_alarm','closed','processing','plan_activated','notified')
        ${locationLike}
        AND datetime('now','localtime') <= datetime(COALESCE(last_notified_at, first_seen_at), '+' || $minutes || ' minutes')
      ORDER BY last_updated_at DESC
      LIMIT 1
    `, Object.assign({ $ruleId: ruleId, $department: department, $minutes: suppressMinutes }, location ? { $location: location } : {}));
    return row;
  }

  static create(data) {
    ensureSchema();
    const alertUuid = uuidv4();
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    execRun(`
      INSERT INTO alerts (alert_uuid, rule_id, matched_keywords, content_summary, source_platform,
                          suspected_location, alert_level, matched_count, department, verify_action, status, last_notified_at)
      VALUES ($alert_uuid, $rule_id, $matched_keywords, $content_summary, $source_platform,
              $suspected_location, $alert_level, $matched_count, $department, $verify_action, $status, $last_notified_at)
    `, {
      $alert_uuid: alertUuid,
      $rule_id: data.rule_id || null,
      $matched_keywords: typeof data.matched_keywords === 'string' ? data.matched_keywords : JSON.stringify(data.matched_keywords || []),
      $content_summary: data.content_summary,
      $source_platform: data.source_platform || null,
      $suspected_location: data.suspected_location || null,
      $alert_level: data.alert_level,
      $matched_count: data.matched_count || 1,
      $department: data.department,
      $verify_action: data.verify_action || null,
      $status: data.status || 'notified',
      $last_notified_at: now
    });
    saveDatabase();
    const lid = getLastInsertId();
    if (lid) {
      const got = this.getById(lid);
      if (got) return got;
    }
    return queryOne('SELECT * FROM alerts WHERE alert_uuid = $uuid', { $uuid: alertUuid });
  }

  static incrementMatchCount(id, newSummary = null) {
    ensureSchema();
    if (!id) return null;
    const current = queryOne('SELECT matched_count, content_summary FROM alerts WHERE id = $id', { $id: id });
    if (!current) return null;

    let summary = current.content_summary || '';
    if (newSummary && typeof newSummary === 'string' && newSummary.length > 0) {
      const snippet = newSummary.substring(0, 30);
      if (!summary || !summary.includes(snippet)) {
        summary = (summary ? summary + '\n...\n' : '') + newSummary;
        if (summary.length > 1000) summary = summary.substring(0, 1000) + '...';
      }
    }
    execRun(`
      UPDATE alerts SET matched_count = matched_count + 1,
                        content_summary = $summary,
                        last_updated_at = CURRENT_TIMESTAMP
      WHERE id = $id
    `, { $summary: summary, $id: id });
    saveDatabase();
    return this.getById(id);
  }

  static updateStatus(id, status, remark = null) {
    ensureSchema();
    execRun(`UPDATE alerts SET status = $status, last_updated_at = CURRENT_TIMESTAMP WHERE id = $id`, {
      $status: status, $id: id
    });
    saveDatabase();
    return this.getById(id);
  }

  static touchNotified(id) {
    ensureSchema();
    execRun(`UPDATE alerts SET last_notified_at = CURRENT_TIMESTAMP, last_updated_at = CURRENT_TIMESTAMP WHERE id = $id`, { $id: id });
    saveDatabase();
  }

  static setSuppressUntil(id, suppressMinutesOrUntil) {
    ensureSchema();
    let until;
    if (typeof suppressMinutesOrUntil === 'number') {
      until = new Date(Date.now() + suppressMinutesOrUntil * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
    } else {
      until = String(suppressMinutesOrUntil).replace('T', ' ').substring(0, 19);
    }
    execRun(`UPDATE alerts SET suppress_until = $until, last_updated_at = CURRENT_TIMESTAMP WHERE id = $id`, { $until: until, $id: id });
    saveDatabase();
    return this.getById(id);
  }

  static reopen(id, reason = null, reopenMinutes = null) {
    ensureSchema();
    const current = this.getById(id);
    if (!current) return null;
    const reopenCount = (current.reopen_count || 0) + 1;
    const fields = ["status = 'notified'", 'reopen_count = $reopenCount', 'suppress_until = NULL', 'last_updated_at = CURRENT_TIMESTAMP', 'last_notified_at = CURRENT_TIMESTAMP'];
    const params = { $id: id, $reopenCount: reopenCount };
    if (reopenMinutes) {
      fields.push("first_seen_at = datetime('now','localtime')");
    }
    execRun(`UPDATE alerts SET ${fields.join(', ')} WHERE id = $id`, params);
    saveDatabase();
    return this.getById(id);
  }

  static addCallback(data) {
    execRun(`
      INSERT INTO callbacks (alert_id, alert_uuid, callback_status, callback_remark, operator)
      VALUES ($alert_id, $alert_uuid, $callback_status, $callback_remark, $operator)
    `, {
      $alert_id: data.alert_id,
      $alert_uuid: data.alert_uuid,
      $callback_status: data.callback_status,
      $callback_remark: data.callback_remark || null,
      $operator: data.operator || null
    });
    saveDatabase();
    return getLastInsertId();
  }
}

module.exports = AlertModel;
