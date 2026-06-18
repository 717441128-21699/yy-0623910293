const { queryOne, queryAll, execRun, saveDatabase, getLastInsertId, getChangesCount, addColumnIfMissing } = require('../config/database');

class RuleModel {
  static ensureSchema() {
    addColumnIfMissing('rules', 'suppress_minutes', 'INTEGER DEFAULT 60');
  }

  static getAll({ status, page = 1, pageSize = 20 } = {}) {
    this.ensureSchema();
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

    return { total, page, pageSize, list: list.map(this._parse) };
  }

  static getById(id) {
    this.ensureSchema();
    const r = queryOne('SELECT * FROM rules WHERE id = $id', { $id: id });
    return r ? this._parse(r) : null;
  }

  static getActiveRules() {
    this.ensureSchema();
    return queryAll('SELECT * FROM rules WHERE status = 1').map(this._parse);
  }

  static create(data) {
    this.ensureSchema();
    execRun(`
      INSERT INTO rules (rule_name, keywords, combine_logic, department, alert_level, threshold_count, threshold_minutes, verify_action, status, suppress_minutes)
      VALUES ($rule_name, $keywords, $combine_logic, $department, $alert_level, $threshold_count, $threshold_minutes, $verify_action, $status, $suppress_minutes)
    `, {
      $rule_name: data.rule_name,
      $keywords: typeof data.keywords === 'string' ? data.keywords : JSON.stringify(data.keywords),
      $combine_logic: data.combine_logic || 'or',
      $department: data.department,
      $alert_level: data.alert_level || 'notice',
      $threshold_count: data.threshold_count || 3,
      $threshold_minutes: data.threshold_minutes || 10,
      $verify_action: data.verify_action || null,
      $status: data.status !== undefined ? data.status : 1,
      $suppress_minutes: data.suppress_minutes || 60
    });
    saveDatabase();
    return this.getById(getLastInsertId());
  }

  static update(id, data) {
    this.ensureSchema();
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
    if (data.suppress_minutes !== undefined) { fields.push('suppress_minutes = $suppress_minutes'); params.$suppress_minutes = data.suppress_minutes; }

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

  static _parse(rule) {
    if (!rule) return rule;
    const parsed = { ...rule };
    try { parsed.keywords = JSON.parse(rule.keywords); } catch (e) { parsed.keywords = []; }
    if (parsed.suppress_minutes === null || parsed.suppress_minutes === undefined) parsed.suppress_minutes = 60;
    return parsed;
  }
}

module.exports = RuleModel;
