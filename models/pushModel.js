const { queryOne, queryAll, execRun, saveDatabase, getLastInsertId, getChangesCount } = require('../config/database');

const VALID_TYPES = ['webhook', 'sms', 'broadcast', 'email', 'dingtalk', 'wecom'];
const VALID_LEVELS = ['notice', 'verify', 'emergency'];

class PushChannelModel {
  static getAll({ enabled, channel_type, page = 1, pageSize = 20 } = {}) {
    const offset = (page - 1) * pageSize;
    let where = [];
    let params = {};

    if (enabled !== undefined) { where.push('enabled = $enabled'); params.$enabled = enabled ? 1 : 0; }
    if (channel_type) { where.push('channel_type = $channel_type'); params.$channel_type = channel_type; }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = queryOne(`SELECT COUNT(*) as count FROM push_channels ${whereSql}`, params).count;
    const list = queryAll(`
      SELECT * FROM push_channels ${whereSql}
      ORDER BY priority DESC, id DESC
      LIMIT $pageSize OFFSET $offset
    `, { ...params, $pageSize: pageSize, $offset: offset });

    return { total, page, pageSize, list: list.map(this._parse) };
  }

  static listActive(alertLevel = null) {
    let rows = queryAll('SELECT * FROM push_channels WHERE enabled = 1 ORDER BY priority DESC');
    rows = rows.map(this._parse);
    if (!alertLevel) return rows;
    return rows.filter(c => c.applicable_levels.includes(alertLevel));
  }

  static getById(id) {
    const row = queryOne('SELECT * FROM push_channels WHERE id = $id', { $id: id });
    return row ? this._parse(row) : null;
  }

  static create(data) {
    if (!data.channel_name || !data.channel_name.trim()) throw new Error('channel_name 为必填');
    if (!VALID_TYPES.includes(data.channel_type)) throw new Error('channel_type 无效，可选: ' + VALID_TYPES.join(','));
    if (!data.target_url || !data.target_url.trim()) throw new Error('target_url 为必填');
    const levels = Array.isArray(data.applicable_levels) && data.applicable_levels.length > 0
      ? data.applicable_levels.filter(l => VALID_LEVELS.includes(l))
      : VALID_LEVELS;
    execRun(`
      INSERT INTO push_channels (channel_name, channel_type, applicable_levels, target_url, auth_headers, payload_template, enabled, priority, retry_times, retry_interval_seconds, remark)
      VALUES ($channel_name, $channel_type, $applicable_levels, $target_url, $auth_headers, $payload_template, $enabled, $priority, $retry_times, $retry_interval_seconds, $remark)
    `, {
      $channel_name: data.channel_name,
      $channel_type: data.channel_type || 'webhook',
      $applicable_levels: JSON.stringify(levels),
      $target_url: data.target_url || null,
      $auth_headers: data.auth_headers ? JSON.stringify(data.auth_headers) : null,
      $payload_template: data.payload_template ? JSON.stringify(data.payload_template) : null,
      $enabled: data.enabled !== undefined ? (data.enabled ? 1 : 0) : 1,
      $priority: data.priority || 50,
      $retry_times: data.retry_times || 3,
      $retry_interval_seconds: data.retry_interval_seconds || 60,
      $remark: data.remark || null
    });
    saveDatabase();
    return this.getById(getLastInsertId());
  }

  static update(id, data) {
    const existing = this.getById(id);
    if (!existing) return null;

    const fields = [];
    const params = { $id: id };

    if (data.channel_name !== undefined) { fields.push('channel_name=$channel_name'); params.$channel_name = data.channel_name; }
    if (data.channel_type !== undefined) {
      if (!VALID_TYPES.includes(data.channel_type)) throw new Error('channel_type 无效');
      fields.push('channel_type=$channel_type'); params.$channel_type = data.channel_type;
    }
    if (data.applicable_levels !== undefined) {
      fields.push('applicable_levels=$applicable_levels');
      params.$applicable_levels = Array.isArray(data.applicable_levels)
        ? JSON.stringify(data.applicable_levels.filter(l => VALID_LEVELS.includes(l)))
        : JSON.stringify(VALID_LEVELS);
    }
    if (data.target_url !== undefined) { fields.push('target_url=$target_url'); params.$target_url = data.target_url || null; }
    if (data.auth_headers !== undefined) {
      fields.push('auth_headers=$auth_headers');
      params.$auth_headers = (data.auth_headers && typeof data.auth_headers === 'object') ? JSON.stringify(data.auth_headers) : (data.auth_headers || null);
    }
    if (data.payload_template !== undefined) {
      fields.push('payload_template=$payload_template');
      params.$payload_template = (data.payload_template && typeof data.payload_template === 'object') ? JSON.stringify(data.payload_template) : (data.payload_template || null);
    }
    if (data.enabled !== undefined) { fields.push('enabled=$enabled'); params.$enabled = data.enabled ? 1 : 0; }
    if (data.priority !== undefined) { fields.push('priority=$priority'); params.$priority = data.priority; }
    if (data.retry_times !== undefined) { fields.push('retry_times=$retry_times'); params.$retry_times = data.retry_times; }
    if (data.retry_interval_seconds !== undefined) { fields.push('retry_interval_seconds=$retry_interval_seconds'); params.$retry_interval_seconds = data.retry_interval_seconds; }
    if (data.remark !== undefined) { fields.push('remark=$remark'); params.$remark = data.remark || null; }

    if (fields.length === 0) return existing;
    fields.push('updated_at=CURRENT_TIMESTAMP');

    execRun(`UPDATE push_channels SET ${fields.join(',')} WHERE id=$id`, params);
    saveDatabase();
    return this.getById(id);
  }

  static setEnabled(id, enabled) {
    execRun('UPDATE push_channels SET enabled=$enabled, updated_at=CURRENT_TIMESTAMP WHERE id=$id', {
      $enabled: enabled ? 1 : 0, $id: id
    });
    saveDatabase();
    return getChangesCount() > 0;
  }

  static delete(id) {
    execRun('DELETE FROM push_channels WHERE id=$id', { $id: id });
    saveDatabase();
    return getChangesCount() > 0;
  }

  static _parse(row) {
    if (!row) return row;
    const out = { ...row };
    try { out.applicable_levels = JSON.parse(row.applicable_levels || '[]'); } catch (e) { out.applicable_levels = []; }
    try { out.auth_headers = row.auth_headers ? JSON.parse(row.auth_headers) : null; } catch (e) { out.auth_headers = null; }
    try { out.payload_template = row.payload_template ? JSON.parse(row.payload_template) : null; } catch (e) { out.payload_template = null; }
    out.enabled = !!row.enabled;
    return out;
  }
}

class PushLogModel {
  static getAll({ alert_id, alert_uuid, channel_id, status, page = 1, pageSize = 20 } = {}) {
    const offset = (page - 1) * pageSize;
    let where = [];
    let params = {};
    if (alert_id) { where.push('alert_id=$alert_id'); params.$alert_id = alert_id; }
    if (alert_uuid) { where.push('alert_uuid=$alert_uuid'); params.$alert_uuid = alert_uuid; }
    if (channel_id) { where.push('channel_id=$channel_id'); params.$channel_id = channel_id; }
    if (status) { where.push('status=$status'); params.$status = status; }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const total = queryOne(`SELECT COUNT(*) as count FROM push_logs ${whereSql}`, params).count;
    const list = queryAll(`
      SELECT l.*, c.channel_name, c.channel_type
      FROM push_logs l LEFT JOIN push_channels c ON l.channel_id = c.id
      ${whereSql}
      ORDER BY l.id DESC
      LIMIT $pageSize OFFSET $offset
    `, { ...params, $pageSize: pageSize, $offset: offset });
    return { total, page, pageSize, list };
  }

  static getByAlert(alertIdOrUuid) {
    const byId = Number(alertIdOrUuid);
    if (!isNaN(byId)) {
      const r = queryAll(`
        SELECT l.*, c.channel_name, c.channel_type FROM push_logs l
        LEFT JOIN push_channels c ON l.channel_id = c.id
        WHERE alert_id = $id ORDER BY l.id DESC`, { $id: byId });
      if (r && r.length) return r;
    }
    return queryAll(`
      SELECT l.*, c.channel_name, c.channel_type FROM push_logs l
      LEFT JOIN push_channels c ON l.channel_id = c.id
      WHERE alert_uuid = $uuid ORDER BY l.id DESC`, { $uuid: String(alertIdOrUuid) });
  }

  static getById(id) {
    return queryOne('SELECT * FROM push_logs WHERE id=$id', { $id: id });
  }

  static create(data) {
    execRun(`
      INSERT INTO push_logs (alert_id, alert_uuid, channel_id, channel_name, channel_type,
        request_payload, response_body, http_status, status, error_message,
        retry_count, next_retry_at, pushed_at)
      VALUES ($alert_id, $alert_uuid, $channel_id, $channel_name, $channel_type,
        $request_payload, $response_body, $http_status, $status, $error_message,
        $retry_count, $next_retry_at, $pushed_at)
    `, {
      $alert_id: data.alert_id || null,
      $alert_uuid: data.alert_uuid,
      $channel_id: data.channel_id || null,
      $channel_name: data.channel_name || null,
      $channel_type: data.channel_type || null,
      $request_payload: data.request_payload ? (typeof data.request_payload === 'string' ? data.request_payload : JSON.stringify(data.request_payload)) : null,
      $response_body: data.response_body ? (typeof data.response_body && typeof data.response_body === 'string' ? data.response_body : JSON.stringify(data.response_body)) : null,
      $http_status: data.http_status || null,
      $status: data.status || 'pending',
      $error_message: data.error_message || null,
      $retry_count: data.retry_count || 0,
      $next_retry_at: data.next_retry_at || null,
      $pushed_at: data.pushed_at || new Date().toISOString().replace('T', ' ').substring(0, 19)
    });
    saveDatabase();
    return getLastInsertId();
  }

  static markResult(id, { status, http_status, response_body, error_message, retry_count, next_retry_at }) {
    const fields = [];
    const params = { $id: id };
    if (status !== undefined) { fields.push('status=$status'); params.$status = status; }
    if (http_status !== undefined) { fields.push('http_status=$http_status'); params.$http_status = http_status; }
    if (response_body !== undefined) {
      fields.push('response_body=$response_body');
      params.$response_body = (response_body && typeof response_body === 'string' ? response_body : JSON.stringify(response_body));
    }
    if (error_message !== undefined) { fields.push('error_message=$error_message'); params.$error_message = error_message || null; }
    if (retry_count !== undefined) { fields.push('retry_count=$retry_count'); params.$retry_count = retry_count; }
    if (next_retry_at !== undefined) { fields.push('next_retry_at=$next_retry_at'); params.$next_retry_at = next_retry_at || null; }
    if (fields.length === 0) return;
    execRun(`UPDATE push_logs SET ${fields.join(',')} WHERE id=$id`, params);
    saveDatabase();
  }

  static listPendingRetry(limit = 50) {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
    return queryAll(`
      SELECT l.*, c.target_url, c.auth_headers, c.payload_template, c.retry_times as max_retry_times, c.retry_interval_seconds
      FROM push_logs l JOIN push_channels c ON l.channel_id = c.id
      WHERE l.status IN ('failed','pending')
        AND (l.next_retry_at IS NULL OR l.next_retry_at <= $now)
        AND l.retry_count < c.retry_times
      ORDER BY l.id ASC LIMIT $limit
    `, { $now: now, $limit: limit }).map(r => {
      try { r.auth_headers = r.auth_headers ? JSON.parse(r.auth_headers) : {}; } catch (e) { r.auth_headers = {}; }
      try { r.payload_template = r.payload_template ? JSON.parse(r.payload_template) : null; } catch (e) { r.payload_template = null; }
      try { r.request_payload = r.request_payload ? JSON.parse(r.request_payload) : null; } catch (e) { r.request_payload = null; }
      return r;
    });
  }
}

module.exports = { PushChannelModel, PushLogModel, VALID_TYPES, VALID_LEVELS };
