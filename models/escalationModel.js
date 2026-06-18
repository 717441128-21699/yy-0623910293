const { queryOne, queryAll, execRun, saveDatabase, getLastInsertId, getChangesCount } = require('../config/database');

class EscalationModel {
  static create(data) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    execRun(`
      INSERT INTO alert_escalations (alert_id, alert_uuid, from_level, to_level, from_channel_type, to_channel_type, reason, escalation_type, result_status, result_message, escalated_at)
      VALUES ($alert_id, $alert_uuid, $from_level, $to_level, $from_channel_type, $to_channel_type, $reason, $escalation_type, $result_status, $result_message, $escalated_at)
    `, {
      $alert_id: data.alert_id || null,
      $alert_uuid: data.alert_uuid || null,
      $from_level: data.from_level || null,
      $to_level: data.to_level || null,
      $from_channel_type: data.from_channel_type || null,
      $to_channel_type: data.to_channel_type || null,
      $reason: data.reason || null,
      $escalation_type: data.escalation_type || 'auto',
      $result_status: data.result_status || 'pending',
      $result_message: data.result_message || null,
      $escalated_at: now
    });
    saveDatabase();
    return this.getById(getLastInsertId());
  }

  static getById(id) {
    return queryOne('SELECT * FROM alert_escalations WHERE id = $id', { $id: id });
  }

  static getByAlert(alertIdOrUuid) {
    const col = typeof alertIdOrUuid === 'number' || /^\d+$/.test(String(alertIdOrUuid)) ? 'alert_id' : 'alert_uuid';
    return queryAll(
      `SELECT * FROM alert_escalations WHERE ${col} = $val ORDER BY escalated_at DESC`,
      { $val: alertIdOrUuid }
    );
  }

  static updateResult(id, { result_status, result_message }) {
    const fields = [];
    const params = { $id: id };
    if (result_status !== undefined) { fields.push('result_status = $result_status'); params.$result_status = result_status; }
    if (result_message !== undefined) { fields.push('result_message = $result_message'); params.$result_message = result_message; }
    if (fields.length === 0) return;
    execRun(`UPDATE alert_escalations SET ${fields.join(', ')} WHERE id = $id`, params);
    saveDatabase();
    return this.getById(id);
  }

  static findOverdueAlerts(escalationMinutes) {
    const minutes = escalationMinutes || 30;
    return queryAll(`
      SELECT a.*, r.rule_name, r.suppress_minutes as rule_suppress_minutes
      FROM alerts a
      LEFT JOIN rules r ON a.rule_id = r.id
      WHERE a.status IN ('notified', 'processing')
        AND a.last_notified_at IS NOT NULL
        AND datetime(a.last_notified_at, '+' || $minutes || ' minutes') <= datetime('now','localtime')
        AND NOT EXISTS (
          SELECT 1 FROM alert_escalations ae
          WHERE ae.alert_id = a.id
            AND ae.escalation_type = 'auto'
            AND ae.escalated_at >= a.last_notified_at
        )
      ORDER BY a.last_notified_at ASC
      LIMIT 50
    `, { $minutes: minutes });
  }

  static getAll({ alert_id, escalation_type, result_status, page = 1, pageSize = 20 } = {}) {
    const offset = (page - 1) * pageSize;
    let where = [];
    let params = {};
    if (alert_id) { where.push('alert_id = $alert_id'); params.$alert_id = alert_id; }
    if (escalation_type) { where.push('escalation_type = $escalation_type'); params.$escalation_type = escalation_type; }
    if (result_status) { where.push('result_status = $result_status'); params.$result_status = result_status; }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = queryOne(`SELECT COUNT(*) as count FROM alert_escalations ${whereSql}`, params).count;
    const list = queryAll(`
      SELECT * FROM alert_escalations ${whereSql}
      ORDER BY escalated_at DESC
      LIMIT $pageSize OFFSET $offset
    `, { ...params, $pageSize: pageSize, $offset: offset });
    return { total, page, pageSize, list };
  }
}

module.exports = EscalationModel;
