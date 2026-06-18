const express = require('express');
const router = express.Router();
const AlertModel = require('../models/alertModel');
const RawMessageModel = require('../models/rawMessageModel');
const { processMessage, buildAlertPushPayload, LEVEL_NAMES } = require('../middleware/alertEngine');

const VALID_STATUSES = ['pending', 'notified', 'processing', 'verified_normal', 'plan_activated', 'closed', 'all'];
const VALID_LEVELS = ['notice', 'verify', 'emergency', 'all'];

function parseAlert(alert) {
  if (!alert) return alert;
  const parsed = { ...alert, level_name: LEVEL_NAMES[alert.alert_level] || alert.alert_level };
  try {
    parsed.matched_keywords = JSON.parse(alert.matched_keywords);
  } catch (e) {
    parsed.matched_keywords = [];
  }
  return parsed;
}

router.get('/', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const status = VALID_STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const alert_level = VALID_LEVELS.includes(req.query.alert_level) ? req.query.alert_level : undefined;
    const department = req.query.department || undefined;

    const result = AlertModel.getAll({ status, alert_level, department, page, pageSize });
    result.list = result.list.map(parseAlert);

    res.json({ code: 0, message: 'success', data: result });
  } catch (err) {
    console.error('[GET /alerts] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/:id(\\d+)', (req, res) => {
  try {
    const alert = parseAlert(AlertModel.getById(parseInt(req.params.id, 10)));
    if (!alert) {
      return res.status(404).json({ code: 404, message: '告警不存在' });
    }
    res.json({ code: 0, message: 'success', data: alert });
  } catch (err) {
    console.error('[GET /alerts/:id] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/uuid/:uuid', (req, res) => {
  try {
    const alert = parseAlert(AlertModel.getByUuid(req.params.uuid));
    if (!alert) {
      return res.status(404).json({ code: 404, message: '告警不存在' });
    }
    res.json({ code: 0, message: 'success', data: alert });
  } catch (err) {
    console.error('[GET /alerts/uuid/:uuid] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/ingest', async (req, res) => {
  try {
    const { content, source_platform, suspected_location } = req.body;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ code: 400, message: 'content 为必填且不能为空字符串' });
    }

    const result = await processMessage({
      content: content.trim(),
      source_platform,
      suspected_location
    });

    const pushPayloads = result.alerts.map(buildAlertPushPayload);

    res.json({
      code: 0,
      message: result.matched ? '匹配完成，部分规则已触发告警' : '消息已接收，未达到告警阈值',
      data: {
        matched: result.matched,
        matched_rules_count: result.matched_rules,
        triggered_alerts_count: result.triggered_alerts,
        trigger_details: result.details.map(d => ({
          rule_id: d.rule_id,
          rule_name: d.rule_name,
          matched_keywords: d.matched_keywords,
          reached_threshold: d.reached_threshold,
          current_count: d.current_count,
          required_count: d.required_count,
          alert_uuid: d.alert ? d.alert.alert_uuid : null
        })),
        push_payloads: pushPayloads
      }
    });
  } catch (err) {
    console.error('[POST /alerts/ingest] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/batch-ingest', async (req, res) => {
  try {
    const messages = req.body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ code: 400, message: 'messages 为必填且不能为空数组' });
    }

    const allPushPayloads = [];
    const results = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.content || typeof msg.content !== 'string' || msg.content.trim().length === 0) {
        results.push({ index: i, skipped: true, reason: 'content 为空' });
        continue;
      }
      const result = await processMessage({
        content: msg.content.trim(),
        source_platform: msg.source_platform,
        suspected_location: msg.suspected_location
      });
      result.alerts.forEach(a => {
        if (!allPushPayloads.find(p => p.alert_uuid === a.alert_uuid)) {
          allPushPayloads.push(buildAlertPushPayload(a));
        }
      });
      results.push({
        index: i,
        matched: result.matched,
        triggered_alerts_count: result.triggered_alerts
      });
    }

    res.json({
      code: 0,
      message: `批量处理完成，共处理 ${messages.length} 条消息`,
      data: {
        total: messages.length,
        triggered_unique_alerts: allPushPayloads.length,
        push_payloads: allPushPayloads,
        details: results
      }
    });
  } catch (err) {
    console.error('[POST /alerts/batch-ingest] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/statistics/summary', (req, res) => {
  try {
    const { queryAll, queryOne } = require('../config/database');

    const totalByLevel = queryAll(`
      SELECT alert_level, COUNT(*) as count
      FROM alerts
      GROUP BY alert_level
    `);

    const totalByStatus = queryAll(`
      SELECT status, COUNT(*) as count
      FROM alerts
      GROUP BY status
    `);

    const totalByDept = queryAll(`
      SELECT department, COUNT(*) as count
      FROM alerts
      GROUP BY department
      ORDER BY count DESC
      LIMIT 10
    `);

    const todayCount = queryOne(`
      SELECT COUNT(*) as count FROM alerts
      WHERE DATE(first_seen_at) = DATE('now', 'localtime')
    `).count;

    const pendingCount = queryOne(`
      SELECT COUNT(*) as count FROM alerts
      WHERE status IN ('pending', 'notified', 'processing')
    `).count;

    const rawTodayCount = queryOne(`
      SELECT COUNT(*) as count FROM raw_messages
      WHERE DATE(received_at) = DATE('now', 'localtime')
    `).count;

    res.json({
      code: 0,
      message: 'success',
      data: {
        overview: {
          today_alerts: todayCount,
          pending_alerts: pendingCount,
          today_messages: rawTodayCount
        },
        by_level: totalByLevel.map(r => ({ level: r.alert_level, level_name: LEVEL_NAMES[r.alert_level] || r.alert_level, count: r.count })),
        by_status: totalByStatus,
        by_department: totalByDept
      }
    });
  } catch (err) {
    console.error('[GET /alerts/statistics/summary] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
