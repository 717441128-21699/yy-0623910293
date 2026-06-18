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

  static updateAlertLevel(id, alertLevel) {
    ensureSchema();
    execRun(`UPDATE alerts SET alert_level = $alert_level, last_updated_at = CURRENT_TIMESTAMP WHERE id = $id`, {
      $alert_level: alertLevel, $id: id
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

  static getSituationOverview({ range = 'today', start_time, end_time } = {}) {
    ensureSchema();
    const now = new Date();
    let fromStr, toStr;
    if (range === '24h') {
      fromStr = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
      toStr = now.toISOString().replace('T', ' ').substring(0, 19);
    } else if (range === 'custom' && start_time && end_time) {
      fromStr = String(start_time).replace('T', ' ').substring(0, 19);
      toStr = String(end_time).replace('T', ' ').substring(0, 19);
    } else {
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      fromStr = todayStart.toISOString().replace('T', ' ').substring(0, 19);
      toStr = now.toISOString().replace('T', ' ').substring(0, 19);
    }

    const params = { $from: fromStr, $to: toStr };
    const where = `WHERE first_seen_at >= $from AND first_seen_at <= $to`;

    const totalRow = queryOne(`SELECT COUNT(*) as total FROM alerts ${where}`, params);

    const byLevel = queryAll(`
      SELECT alert_level, COUNT(*) as count
      FROM alerts ${where}
      GROUP BY alert_level
    `, params);

    const byStatus = queryAll(`
      SELECT status, COUNT(*) as count
      FROM alerts ${where}
      GROUP BY status
    `, params);

    const bySource = queryAll(`
      SELECT source_platform, COUNT(*) as count
      FROM alerts ${where}
      GROUP BY source_platform
    `, params);

    const byDepartment = queryAll(`
      SELECT department, COUNT(*) as count,
             SUM(CASE WHEN status IN ('pending','notified','processing','plan_activated') THEN 1 ELSE 0 END) as unclosed_count
      FROM alerts ${where}
      GROUP BY department
      ORDER BY unclosed_count DESC, count DESC
    `, params);

    const pushStats = queryOne(`
      SELECT
        (SELECT COUNT(*) FROM push_logs pl
          JOIN alerts a ON a.id = pl.alert_id
          WHERE a.first_seen_at >= $from AND a.first_seen_at <= $to) as push_total,
        (SELECT COUNT(*) FROM push_logs pl
          JOIN alerts a ON a.id = pl.alert_id
          WHERE a.first_seen_at >= $from AND a.first_seen_at <= $to AND pl.status='success') as push_success,
        (SELECT COUNT(*) FROM push_logs pl
          JOIN alerts a ON a.id = pl.alert_id
          WHERE a.first_seen_at >= $from AND a.first_seen_at <= $to AND pl.status='failed') as push_failed
    `, params) || { push_total: 0, push_success: 0, push_failed: 0 };

    const unclosedDepartments = byDepartment
      .filter(d => (d.unclosed_count || 0) > 0)
      .map(d => ({ department: d.department, unclosed_count: d.unclosed_count, total_count: d.count }));

    return {
      range,
      time_window: { start: fromStr, end: toStr },
      total_alerts: totalRow ? totalRow.total : 0,
      push_success_rate: pushStats.push_total > 0
        ? Math.round((pushStats.push_success / pushStats.push_total) * 10000) / 100
        : 100,
      push_stats: {
        total: pushStats.push_total || 0,
        success: pushStats.push_success || 0,
        failed: pushStats.push_failed || 0
      },
      by_level: byLevel,
      by_status: byStatus,
      by_source: bySource,
      by_department: byDepartment,
      unclosed_departments: unclosedDepartments
    };
  }

  static getDepartmentDashboard({ department, start_time, end_time } = {}) {
    ensureSchema();
    let extraWhere = [];
    let params = {};
    if (department) {
      extraWhere.push('a.department = $department');
      params.$department = department;
    }
    if (start_time) {
      extraWhere.push('a.first_seen_at >= $start_time');
      params.$start_time = String(start_time).replace('T', ' ').substring(0, 19);
    }
    if (end_time) {
      extraWhere.push('a.first_seen_at <= $end_time');
      params.$end_time = String(end_time).replace('T', ' ').substring(0, 19);
    }
    const extraSql = extraWhere.length > 0 ? `AND ${extraWhere.join(' AND ')}` : '';

    const alerts = queryAll(`
      SELECT a.*, r.rule_name, r.suppress_minutes as rule_suppress_minutes,
             (SELECT MAX(callback_time) FROM callbacks c WHERE c.alert_id = a.id) as last_callback_time,
             (SELECT callback_status FROM callbacks c WHERE c.alert_id = a.id ORDER BY callback_time DESC LIMIT 1) as last_callback_status,
             (SELECT operator FROM callbacks c WHERE c.alert_id = a.id ORDER BY callback_time DESC LIMIT 1) as last_callback_operator,
             (SELECT callback_remark FROM callbacks c WHERE c.alert_id = a.id ORDER BY callback_time DESC LIMIT 1) as last_callback_remark,
             (SELECT status FROM push_logs pl WHERE pl.alert_id = a.id ORDER BY pushed_at DESC LIMIT 1) as last_push_status,
             (SELECT error_message FROM push_logs pl WHERE pl.alert_id = a.id ORDER BY pushed_at DESC LIMIT 1) as last_push_error,
             (SELECT pushed_at FROM push_logs pl WHERE pl.alert_id = a.id ORDER BY pushed_at DESC LIMIT 1) as last_push_at
      FROM alerts a
      LEFT JOIN rules r ON a.rule_id = r.id
      WHERE a.status IN ('pending','notified','processing','plan_activated','verified_normal','false_alarm','closed')
      ${extraSql}
      ORDER BY a.last_updated_at DESC
    `, params);

    const deptMap = {};
    for (const a of alerts) {
      const dept = a.department || '未指派';
      if (department && dept !== department) continue;
      if (!deptMap[dept]) {
        deptMap[dept] = {
          department: dept,
          total_count: 0,
          status_counts: {
            pending: 0, notified: 0, processing: 0,
            plan_activated: 0, verified_normal: 0,
            false_alarm: 0, closed: 0
          },
          latest_alerts: []
        };
      }
      const item = deptMap[dept];
      item.total_count++;
      if (item.status_counts[a.status] !== undefined) item.status_counts[a.status]++;

      const nextNudgeMinutes = (a.rule_suppress_minutes === undefined || a.rule_suppress_minutes === null) ? 60 : a.rule_suppress_minutes;
      const baseTime = a.last_notified_at || a.first_seen_at;
      let nextNudgeAt = null;
      if (baseTime && nextNudgeMinutes > 0 && !a.suppress_until) {
        const bt = new Date(String(baseTime).replace(' ', 'T'));
        nextNudgeAt = new Date(bt.getTime() + nextNudgeMinutes * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
      }
      if (a.suppress_until) {
        nextNudgeAt = String(a.suppress_until).substring(0, 19);
      }

      item.latest_alerts.push({
        id: a.id,
        alert_uuid: a.alert_uuid,
        rule_name: a.rule_name,
        alert_level: a.alert_level,
        status: a.status,
        matched_count: a.matched_count,
        suspected_location: a.suspected_location,
        last_callback_time: a.last_callback_time,
        last_callback_status: a.last_callback_status,
        last_callback_operator: a.last_callback_operator,
        last_callback_remark: a.last_callback_remark,
        last_push_status: a.last_push_status,
        last_push_error: a.last_push_error,
        last_push_at: a.last_push_at,
        next_nudge_at: nextNudgeAt,
        suppress_until: a.suppress_until,
        reopen_count: a.reopen_count || 0,
        first_seen_at: a.first_seen_at
      });
    }

    const list = Object.values(deptMap).map(d => {
      d.unclosed_count = d.status_counts.pending + d.status_counts.notified + d.status_counts.processing + d.status_counts.plan_activated;
      d.closed_count = d.status_counts.verified_normal + d.status_counts.false_alarm + d.status_counts.closed;
      d.latest_alerts = d.latest_alerts.slice(0, 20);
      return d;
    }).sort((a, b) => b.unclosed_count - a.unclosed_count);

    return {
      filters: { department: department || null, start_time: start_time || null, end_time: end_time || null },
      total_departments: list.length,
      total_unclosed: list.reduce((s, d) => s + d.unclosed_count, 0),
      departments: list
    };
  }
}

module.exports = AlertModel;
