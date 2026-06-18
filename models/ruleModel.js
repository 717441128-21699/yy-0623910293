const { queryOne, queryAll, execRun, saveDatabase, getLastInsertId, getChangesCount } = require('../config/database');

class RuleModel {
  static getAll({ status, page = 1, pageSize = 20 } = {}) {
    const offset = (page - 1) * pageSize;
    let whereClauses = [];
    let params = {};

    if (status !== undefined) {
      whereClauses.push('status = $status');
      params.$status = status;
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const total = queryOne(`SELECT COUNT(*) as count FROM rules ${whereSql}`, params).count;
    const list = queryAll(`
      SELECT * FROM rules ${whereSql}
      ORDER BY id DESC
      LIMIT $pageSize OFFSET $offset
    `, { ...params, $pageSize: pageSize, $offset: offset });

    return { total, page, pageSize, list };
  }

  static getById(id) {
    return queryOne('SELECT * FROM rules WHERE id = $id', { $id: id });
  }

  static getActiveRules() {
    return queryAll('SELECT * FROM rules WHERE status = 1');
  }

  static create(data) {
    execRun(`
      INSERT INTO rules (rule_name, keywords, combine_logic, department, alert_level, threshold_count, threshold_minutes, verify_action, status)
      VALUES ($rule_name, $keywords, $combine_logic, $department, $alert_level, $threshold_count, $threshold_minutes, $verify_action, $status)
    `, {
      $rule_name: data.rule_name,
      $keywords: typeof data.keywords === 'string' ? data.keywords : JSON.stringify(data.keywords),
      $combine_logic: data.combine_logic || 'or',
      $department: data.department,
      $alert_level: data.alert_level || 'notice',
      $threshold_count: data.threshold_count || 3,
      $threshold_minutes: data.threshold_minutes || 10,
      $verify_action: data.verify_action || null,
      $status: data.status !== undefined ? data.status : 1
    });
    saveDatabase();
    return this.getById(getLastInsertId());
  }

  static update(id, data) {
    const existing = this.getById(id);
    if (!existing) return null;

    const fields = [];
    const params = { $id: id };

    if (data.rule_name !== undefined) { fields.push('rule_name = $rule_name'); params.$rule_name = data.rule_name; }
    if (data.keywords !== undefined) { fields.push('keywords = $keywords'); params.$keywords = typeof data.keywords === 'string' ? data.keywords : JSON.stringify(data.keywords); }
    if (data.combine_logic !== undefined) { fields.push('combine_logic = $combine_logic'); params.$combine_logic = data.combine_logic; }
    if (data.department !== undefined) { fields.push('department = $department'); params.$department = data.department; }
    if (data.alert_level !== undefined) { fields.push('alert_level = $alert_level'); params.$alert_level = data.alert_level; }
    if (data.threshold_count !== undefined) { fields.push('threshold_count = $threshold_count'); params.$threshold_count = data.threshold_count; }
    if (data.threshold_minutes !== undefined) { fields.push('threshold_minutes = $threshold_minutes'); params.$threshold_minutes = data.threshold_minutes; }
    if (data.verify_action !== undefined) { fields.push('verify_action = $verify_action'); params.$verify_action = data.verify_action; }
    if (data.status !== undefined) { fields.push('status = $status'); params.$status = data.status; }

    if (fields.length === 0) return existing;
    fields.push("updated_at = CURRENT_TIMESTAMP");

    execRun(`UPDATE rules SET ${fields.join(', ')} WHERE id = $id`, params);
    saveDatabase();
    return this.getById(id);
  }

  static delete(id) {
    execRun('DELETE FROM rules WHERE id = $id', { $id: id });
    saveDatabase();
    return getChangesCount() > 0;
  }
}

module.exports = RuleModel;
