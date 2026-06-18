const { v4: uuidv4 } = require('uuid');
const { queryOne, queryAll, execRun, saveDatabase, getLastInsertId } = require('../config/database');

class AlertModel {
  static getAll({ status, alert_level, department, page = 1, pageSize = 20 } = {}) {
    const offset = (page - 1) * pageSize;
    let whereClauses = [];
    let params = {};

    if (status !== undefined && status !== 'all') {
      whereClauses.push('a.status = $status');
      params.$status = status;
    }
    if (alert_level !== undefined && alert_level !== 'all') {
      whereClauses.push('a.alert_level = $alert_level');
      params.$alert_level = alert_level;
    }
    if (department !== undefined && department !== '') {
      whereClauses.push('a.department = $department');
      params.$department = department;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const total = queryOne(`SELECT COUNT(*) as count FROM alerts a ${whereSql}`, params).count;
    const list = queryAll(`
      SELECT a.*, r.rule_name,
             (SELECT COUNT(*) FROM callbacks c WHERE c.alert_id = a.id) as callback_count
      FROM alerts a
      LEFT JOIN rules r ON a.rule_id = r.id
      ${whereSql}
      ORDER BY a.last_updated_at DESC
      LIMIT $pageSize OFFSET $offset
    `, { ...params, $pageSize: pageSize, $offset: offset });

    return { total, page, pageSize, list };
  }

  static getById(id) {
    const alert = queryOne(`
      SELECT a.*, r.rule_name
      FROM alerts a
      LEFT JOIN rules r ON a.rule_id = r.id
      WHERE a.id = $id
    `, { $id: id });
    if (alert) {
      alert.callbacks = queryAll('SELECT * FROM callbacks WHERE alert_id = $id ORDER BY callback_time DESC', { $id: id });
    }
    return alert;
  }

  static getByUuid(alertUuid) {
    const alert = queryOne(`
      SELECT a.*, r.rule_name
      FROM alerts a
      LEFT JOIN rules r ON a.rule_id = r.id
      WHERE a.alert_uuid = $uuid
    `, { $uuid: alertUuid });
    if (alert) {
      alert.callbacks = queryAll('SELECT * FROM callbacks WHERE alert_uuid = $uuid ORDER BY callback_time DESC', { $uuid: alertUuid });
    }
    return alert;
  }

  static findActiveByRule(ruleId, thresholdMinutes) {
    return queryOne(`
      SELECT * FROM alerts
      WHERE rule_id = $ruleId AND status IN ('pending', 'notified')
        AND first_seen_at >= datetime('now', '-' || $minutes || ' minutes')
      ORDER BY first_seen_at DESC
      LIMIT 1
    `, { $ruleId: ruleId, $minutes: thresholdMinutes });
  }

  static create(data) {
    const alertUuid = uuidv4();
    execRun(`
      INSERT INTO alerts (alert_uuid, rule_id, matched_keywords, content_summary, source_platform,
                          suspected_location, alert_level, matched_count, department, verify_action, status)
      VALUES ($alert_uuid, $rule_id, $matched_keywords, $content_summary, $source_platform,
              $suspected_location, $alert_level, $matched_count, $department, $verify_action, $status)
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
      $status: data.status || 'notified'
    });
    saveDatabase();
    return this.getById(getLastInsertId());
  }

  static incrementMatchCount(id, newSummary = null) {
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
    execRun(`UPDATE alerts SET status = $status, last_updated_at = CURRENT_TIMESTAMP WHERE id = $id`, {
      $status: status, $id: id
    });
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
