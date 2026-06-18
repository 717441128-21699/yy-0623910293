const http = require('http');
const https = require('https');
const { URL } = require('url');
const { PushChannelModel, PushLogModel } = require('../models/pushModel');
const { buildAlertPushPayload, LEVEL_NAMES } = require('./alertUtils');

function httpRequest(targetUrl, { method = 'POST', headers = {}, body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(targetUrl);
      const lib = urlObj.protocol === 'https:' ? https : http;
      const requestBody = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;

      const mergedHeaders = {
        'Content-Type': 'application/json; charset=utf-8',
        ...headers
      };
      if (requestBody && !mergedHeaders['Content-Length']) {
        mergedHeaders['Content-Length'] = Buffer.byteLength(requestBody, 'utf8');
      }

      const req = lib.request({
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method,
        headers: mergedHeaders,
        timeout: timeoutMs
      }, (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => data += c);
        res.on('end', () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body: data
          });
        });
      });
      req.on('timeout', () => {
        req.destroy(new Error('请求超时 (' + timeoutMs + 'ms)'));
      });
      req.on('error', (err) => {
        resolve({ ok: false, status: 0, body: '', error: err.message });
      });
      if (requestBody) req.write(requestBody);
      req.end();
    } catch (err) {
      resolve({ ok: false, status: 0, body: '', error: err.message });
    }
  });
}

function buildChannelPayload(channel, alertPayload, rule) {
  const customTpl = channel.payload_template;
  const levelName = alertPayload.level_name || LEVEL_NAMES[alertPayload.alert_level] || alertPayload.alert_level;

  const commonText =
    `【${levelName}告警】${alertPayload.rule_name || '景区风险告警'}\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `告警等级: ${levelName}\n` +
    `责任部门: ${alertPayload.department}\n` +
    `匹配次数: ${alertPayload.matched_count || 1}\n` +
    `来源平台: ${alertPayload.source_platform || '未知'}\n` +
    `疑似地点: ${alertPayload.suspected_location || '未识别'}\n` +
    `命中关键词: ${(alertPayload.matched_keywords || []).join('、')}\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `内容摘要:\n${alertPayload.content_summary}\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `建议动作: ${alertPayload.verify_action || '请尽快核实'}\n` +
    `告警编号: ${alertPayload.alert_uuid}\n` +
    `时间: ${alertPayload.created_at || new Date().toLocaleString()}`;

  switch (channel.channel_type) {
    case 'dingtalk': {
      const base = { msgtype: 'text', text: { content: commonText } };
      if (customTpl) return { ...base, ...customTpl };
      return base;
    }
    case 'wecom': {
      const base = { msgtype: 'markdown', markdown: { content: commonText.replace(/\n/g, '\n> ').replace(/^/, '> ') } };
      if (customTpl) return { ...base, ...customTpl };
      return base;
    }
    case 'sms': {
      const smsText =
        `[${levelName}]${alertPayload.rule_name || '景区告警'}` +
        `${alertPayload.suspected_location ? '@' + alertPayload.suspected_location : ''}: ` +
        `${(alertPayload.content_summary || '').substring(0, 80)}` +
        ` 建议:${(alertPayload.verify_action || '核实').substring(0, 40)}`;
      if (customTpl && typeof customTpl === 'object' && customTpl.template) {
        const t = customTpl.template
          .replace('{level}', levelName)
          .replace('{dept}', alertPayload.department || '')
          .replace('{content}', (alertPayload.content_summary || '').substring(0, 80))
          .replace('{location}', alertPayload.suspected_location || '')
          .replace('{action}', (alertPayload.verify_action || '').substring(0, 40));
        return customTpl.data ? { ...customTpl.data, content: t } : t;
      }
      return { content: smsText };
    }
    case 'broadcast': {
      const broadcastText =
        `各位${alertPayload.department || '值班'}同事请注意：` +
        `接收到${levelName}告警，${alertPayload.rule_name || '景区风险'}。` +
        `地点：${alertPayload.suspected_location || '待确认'}。` +
        `${alertPayload.content_summary ? '情况：' + alertPayload.content_summary.substring(0, 80) + '。' : ''}` +
        `请${alertPayload.verify_action || '立即核实'}。告警编号${alertPayload.alert_uuid}。`;
      if (customTpl && typeof customTpl === 'object' && customTpl.field) {
        const payload = { ...customTpl };
        payload[customTpl.field] = broadcastText;
        return payload;
      }
      return { content: broadcastText };
    }
    case 'email':
    case 'webhook':
    default: {
      const base = {
        alert_uuid: alertPayload.alert_uuid,
        rule_name: alertPayload.rule_name,
        alert_level: alertPayload.alert_level,
        level_name: levelName,
        department: alertPayload.department,
        matched_count: alertPayload.matched_count || 1,
        content_summary: alertPayload.content_summary,
        source_platform: alertPayload.source_platform,
        suspected_location: alertPayload.suspected_location,
        matched_keywords: alertPayload.matched_keywords || [],
        verify_action: alertPayload.verify_action,
        created_at: alertPayload.created_at,
        severity:
          alertPayload.alert_level === 'emergency' ? 'critical' :
          alertPayload.alert_level === 'verify' ? 'warning' : 'info',
        full_text: commonText
      };
      if (customTpl && typeof customTpl === 'object') return { ...base, ...customTpl };
      return base;
    }
  }
}

async function sendPush(channel, alertRecord, rule = null, isTest = false) {
  const alertPayload = typeof alertRecord.level_name === 'string' && alertRecord.alert_uuid
    ? alertRecord
    : buildAlertPushPayload(alertRecord);

  const payload = buildChannelPayload(channel, alertPayload, rule);
  const headers = channel.auth_headers || {};

  const logId = PushLogModel.create({
    alert_id: alertRecord.id || null,
    alert_uuid: alertPayload.alert_uuid,
    channel_id: channel.id,
    channel_name: channel.channel_name,
    channel_type: channel.channel_type,
    request_payload: payload,
    status: isTest ? 'sending' : 'pending',
    retry_count: 0
  });

  const resp = await httpRequest(channel.target_url, { headers, body: payload });

  const finalStatus = resp.ok ? 'success' : 'failed';
  const errMsg = resp.error
    || (!resp.ok && resp.status ? `HTTP ${resp.status}: ${(resp.body || '').substring(0, 300)}` : null)
    || null;

  let retryCount = 1;
  let nextRetry = null;

  if (finalStatus === 'failed' && !isTest) {
    retryCount = 1;
    if (retryCount <= (channel.retry_times || 3)) {
      const interval = (channel.retry_interval_seconds || 60) * 1000;
      nextRetry = new Date(Date.now() + interval).toISOString().replace('T', ' ').substring(0, 19);
    }
  }

  PushLogModel.markResult(logId, {
    status: finalStatus,
    http_status: resp.status || null,
    response_body: resp.body ? resp.body.substring(0, 2000) : null,
    error_message: errMsg,
    retry_count: retryCount,
    next_retry_at: nextRetry
  });

  return {
    log_id: logId,
    channel_id: channel.id,
    channel_name: channel.channel_name,
    channel_type: channel.channel_type,
    status: finalStatus,
    http_status: resp.status,
    error_message: errMsg,
    is_test: isTest,
    next_retry_at: nextRetry
  };
}

async function dispatchAlertPushes(alertRecord, rule = null, { channel_ids = null, channel_types = null } = {}) {
  const level = alertRecord.alert_level;
  let channels = PushChannelModel.listActive(level);
  if (channel_ids && Array.isArray(channel_ids) && channel_ids.length > 0) {
    channels = channels.filter(c => channel_ids.includes(c.id));
  }
  if (channel_types && Array.isArray(channel_types) && channel_types.length > 0) {
    channels = channels.filter(c => channel_types.includes(c.channel_type));
  }
  if (channels.length === 0) return [];

  const results = [];
  for (const ch of channels) {
    try {
      const r = await sendPush(ch, alertRecord, rule, false);
      results.push(r);
    } catch (e) {
      results.push({ channel_id: ch.id, channel_name: ch.channel_name, channel_type: ch.channel_type, status: 'failed', error_message: e.message });
    }
  }
  return results;
}

async function retryPushLog(logId) {
  const log = PushLogModel.getById(logId);
  if (!log) return null;
  if (!log.channel_id) return null;

  const channel = PushChannelModel.getById(log.channel_id);
  if (!channel) return null;

  if (log.retry_count >= (channel.retry_times || 3)) {
    return { status: 'failed', reason: '已达最大重试次数', log_id: logId };
  }

  let payload;
  try { payload = log.request_payload ? JSON.parse(log.request_payload) : null; } catch (e) { payload = null; }
  const headers = channel.auth_headers || {};

  const resp = await httpRequest(channel.target_url, { headers, body: payload });
  const finalStatus = resp.ok ? 'success' : 'failed';
  const errMsg = resp.error
    || (!resp.ok && resp.status ? `HTTP ${resp.status}: ${(resp.body || '').substring(0, 300)}` : null)
    || null;

  const nextCount = (log.retry_count || 0) + 1;
  let nextRetry = null;
  if (finalStatus === 'failed' && nextCount < (channel.retry_times || 3)) {
    const interval = (channel.retry_interval_seconds || 60) * 1000;
    nextRetry = new Date(Date.now() + interval).toISOString().replace('T', ' ').substring(0, 19);
  }

  PushLogModel.markResult(logId, {
    status: finalStatus,
    http_status: resp.status || null,
    response_body: resp.body ? resp.body.substring(0, 2000) : null,
    error_message: errMsg,
    retry_count: nextCount,
    next_retry_at: nextRetry
  });

  return {
    log_id: logId,
    status: finalStatus,
    http_status: resp.status,
    error_message: errMsg,
    retry_count: nextCount,
    next_retry_at: nextRetry
  };
}

async function runRetryDaemon() {
  const list = PushLogModel.listPendingRetry(20);
  const results = [];
  for (const log of list) {
    try {
      const headers = log.auth_headers || {};
      const resp = await httpRequest(log.target_url, { headers, body: log.request_payload });
      const finalStatus = resp.ok ? 'success' : 'failed';
      const errMsg = resp.error
        || (!resp.ok && resp.status ? `HTTP ${resp.status}: ${(resp.body || '').substring(0, 300)}` : null)
        || null;

      const nextCount = (log.retry_count || 0) + 1;
      let nextRetry = null;
      if (finalStatus === 'failed' && nextCount < (log.max_retry_times || 3)) {
        const interval = (log.retry_interval_seconds || 60) * 1000;
        nextRetry = new Date(Date.now() + interval).toISOString().replace('T', ' ').substring(0, 19);
      }
      PushLogModel.markResult(log.id, {
        status: finalStatus,
        http_status: resp.status || null,
        response_body: resp.body ? resp.body.substring(0, 2000) : null,
        error_message: errMsg,
        retry_count: nextCount,
        next_retry_at: nextRetry
      });
      results.push({ log_id: log.id, status: finalStatus });
    } catch (e) {
      results.push({ log_id: log.id, status: 'failed', error_message: e.message });
    }
  }
  return results;
}

module.exports = {
  sendPush,
  dispatchAlertPushes,
  retryPushLog,
  runRetryDaemon,
  httpRequest,
  buildChannelPayload
};
