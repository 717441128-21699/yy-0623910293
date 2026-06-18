const express = require('express');
const router = express.Router();
const { processMessage, dryRunRules, LEVEL_NAMES, buildAlertPushPayload } = require('../middleware/alertEngine');
const AlertModel = require('../models/alertModel');
const { queryAll, queryOne } = require('../config/database');

router.post('/ingest', async (req, res) => {
  try {
    const { content, source_platform, sender, meta_json } = req.body;
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ code: 400, message: 'content 必填' });
    }
    const result = await processMessage({ content, source_platform, sender, meta_json });
    res.json({ code: 0, message: result.matched ? '匹配成功，已生成或更新告警' : '暂未命中告警规则', data: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/batch-ingest', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ code: 400, message: 'messages 必填且为数组' });
    }
    const allResults = [];
    const allPushPayloads = [];
    const seenAlerts = new Set();
    let matchedCount = 0;
    for (const msg of messages) {
      const result = await processMessage(msg);
      allResults.push({
        content: msg.content ? msg.content.substring(0, 50) : '',
        matched: result.matched,
        triggered_alert_count: result.triggered_alert_count,
        trigger_details: result.trigger_details
      });
      if (result.matched) matchedCount++;
      for (const pa of result.push_payloads || []) {
        if (pa.alert_uuid && !seenAlerts.has(pa.alert_uuid)) {
          seenAlerts.add(pa.alert_uuid);
          allPushPayloads.push(pa);
        }
      }
    }
    res.json({
      code: 0,
      data: {
        total: messages.length,
        matched: matchedCount,
        unmatched: messages.length - matchedCount,
        push_payloads: allPushPayloads,
        results: allResults
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/dry-run', async (req, res) => {
  try {
    const { content, source_platform, sender } = req.body;
    if (!content || typeof content !== 'string' || content.trim() === '') {
      return res.status(400).json({ code: 400, message: 'content 必填' });
    }
    const result = await dryRunRules({ content, source_platform, sender });
    res.json({
      code: 0,
      data: {
        mode: 'dry_run',
        will_create_alert: result.matched && result.matches.some(m => m.would_trigger_now),
        input_summary: (content || '').substring(0, 100),
        ...result
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/', (req, res) => {
  try {
    const { page = 1, pageSize = 20, status, alert_level, department,
      source_platform, suspected_location, start_time, end_time, with_suppressed } = req.query;
    const data = AlertModel.getAll({
      status, alert_level, department, source_platform, suspected_location,
      start_time, end_time, with_suppressed,
      page: parseInt(page, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 20
    });
    res.json({ code: 0, message: 'success', data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/meta', (req, res) => {
  try {
    const levels = [
      { value: 'notice', label: '一般关注', color: 'blue' },
      { value: 'verify', label: '需核实', color: 'yellow' },
      { value: 'emergency', label: '紧急处置', color: 'red' }
    ];
    const statuses = [
      { value: 'pending', label: '待处理' },
      { value: 'notified', label: '已通知' },
      { value: 'processing', label: '处理中' },
      { value: 'verified_normal', label: '核实正常' },
      { value: 'plan_activated', label: '已启动预案' },
      { value: 'false_alarm', label: '误报' },
      { value: 'closed', label: '已办结' }
    ];
    res.json({
      code: 0,
      data: {
        alert_levels: levels,
        alert_statuses: statuses,
        departments: AlertModel.listDistinctDepartments().map(r => r.department),
        source_platforms: AlertModel.listDistinctSources().map(r => r.source_platform)
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/export', (req, res) => {
  try {
    const { start_time, end_time, status, alert_level, department,
      source_platform, suspected_location, format = 'json' } = req.query;
    const data = AlertModel.getAll({
      start_time, end_time, status, alert_level, department,
      source_platform, suspected_location,
      page: 1, pageSize: 100000
    });

    const enriched = [];
    for (const a of data.list) {
      const detail = AlertModel.getById(a.id);
      if (!detail) continue;
      enriched.push({
        id: detail.id,
        alert_uuid: detail.alert_uuid,
        rule_id: detail.rule_id,
        rule_name: detail.rule_name,
        alert_level: detail.alert_level,
        alert_level_name: LEVEL_NAMES[detail.alert_level] || detail.alert_level,
        department: detail.department,
        status: detail.status,
        status_label: ({ pending: '待处理', notified: '已通知', processing: '处理中', verified_normal: '核实正常', plan_activated: '已启动预案', false_alarm: '误报', closed: '已办结' })[detail.status] || detail.status,
        matched_count: detail.matched_count,
        source_platform: detail.source_platform,
        suspected_location: detail.suspected_location,
        matched_keywords: typeof detail.matched_keywords === 'string'
          ? (() => { try { return JSON.parse(detail.matched_keywords).join('、'); } catch (e) { return detail.matched_keywords; } })()
          : (Array.isArray(detail.matched_keywords) ? detail.matched_keywords.join('、') : ''),
        content_summary: detail.content_summary,
        verify_action: detail.verify_action,
        first_seen_at: detail.first_seen_at,
        last_updated_at: detail.last_updated_at,
        last_notified_at: detail.last_notified_at,
        suppress_until: detail.suppress_until,
        reopen_count: detail.reopen_count || 0,
        push_total: detail.push_logs?.length || 0,
        push_success: (detail.push_logs || []).filter(p => p.status === 'success').length,
        push_failed: (detail.push_logs || []).filter(p => p.status === 'failed').length,
        push_logs: (detail.push_logs || []).map(p => `${p.channel_name}[${p.status}]${p.error_message ? '(' + p.error_message.substring(0, 50) + ')' : ''}`).join(' | '),
        callback_count: detail.callbacks?.length || 0,
        callback_traces: (detail.callbacks || []).map(c => {
          const lbl = ({ contacted: '已联系', onsite: '已到场', normal: '现场正常', plan: '启动预案', escalated: '已升级', false_alarm: '误报', closed: '已办结' })[c.callback_status] || c.callback_status;
          return `[${c.callback_time}] ${lbl}${c.operator ? ' - ' + c.operator : ''}${c.callback_remark ? '：' + c.callback_remark : ''}`;
        }).join('\n')
      });
    }

    if (format === 'csv') {
      const headers = Object.keys(enriched[0] || {});
      const esc = v => {
        if (v === null || v === undefined) return '';
        const s = String(v).replace(/"/g, '""');
        return `"${s}"`;
      };
      const csv = [
        headers.join(','),
        ...enriched.map(r => headers.map(h => esc(r[h])).join(','))
      ].join('\n');
      const bom = '\uFEFF';
      const filename = `alerts_${Date.now()}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(bom + csv);
    } else {
      res.json({ code: 0, data: { total: enriched.length, items: enriched } });
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/statistics/summary', (req, res) => {
  try {
    const byLevel = queryAll(`
      SELECT alert_level, COUNT(*) as count FROM alerts
      WHERE date(first_seen_at) = date('now','localtime')
      GROUP BY alert_level
    `);
    const byStatus = queryAll(`
      SELECT status, COUNT(*) as count FROM alerts GROUP BY status
    `);
    const byDept = queryAll(`
      SELECT department, COUNT(*) as count FROM alerts
      WHERE first_seen_at >= datetime('now','-7 days')
      GROUP BY department
    `);
    const todayAlerts = queryOne(`SELECT COUNT(*) as c FROM alerts WHERE date(first_seen_at) = date('now','localtime')`).c;
    const pendingAlerts = queryOne(`SELECT COUNT(*) as c FROM alerts WHERE status IN ('pending','notified','processing')`).c;
    const todayMessages = queryOne(`SELECT COUNT(*) as c FROM raw_messages WHERE date(received_at) = date('now','localtime')`).c;

    res.json({
      code: 0,
      data: {
        today_alerts: todayAlerts,
        pending_alerts: pendingAlerts,
        today_messages: todayMessages,
        by_level: byLevel.map(r => ({ ...r, level_name: LEVEL_NAMES[r.alert_level] || r.alert_level })),
        by_status: byStatus,
        by_department_last7d: byDept,
        updated_at: new Date().toISOString()
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/statistics/overview', (req, res) => {
  try {
    const { range = 'today', start_time, end_time } = req.query;
    const overview = AlertModel.getSituationOverview({ range, start_time, end_time });

    overview.by_level = overview.by_level.map(r => ({
      ...r,
      level_name: LEVEL_NAMES[r.alert_level] || r.alert_level
    }));
    const statusLabelMap = {
      pending: '待处理', notified: '已通知', processing: '处理中',
      verified_normal: '核实正常', plan_activated: '已启动预案',
      false_alarm: '误报', closed: '已办结'
    };
    overview.by_status = overview.by_status.map(r => ({
      ...r,
      status_label: statusLabelMap[r.status] || r.status
    }));
    res.json({ code: 0, message: 'success', data: overview });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/statistics/department-dashboard', (req, res) => {
  try {
    const dashboard = AlertModel.getDepartmentDashboard();
    const statusLabelMap = {
      pending: '待处理', notified: '已通知', processing: '处理中',
      verified_normal: '核实正常', plan_activated: '已启动预案',
      false_alarm: '误报', closed: '已办结'
    };
    const callbackLabelMap = {
      contacted: '已联系', onsite: '已到场', normal: '现场正常',
      plan: '启动预案', escalated: '已升级', false_alarm: '误报', closed: '已办结'
    };
    for (const d of dashboard.departments) {
      d.status_counts_labeled = {};
      for (const k of Object.keys(d.status_counts)) {
        d.status_counts_labeled[statusLabelMap[k] || k] = d.status_counts[k];
      }
      for (const a of d.latest_alerts) {
        a.status_label = statusLabelMap[a.status] || a.status;
        a.alert_level_name = LEVEL_NAMES[a.alert_level] || a.alert_level;
        if (a.last_callback_status) {
          a.last_callback_status_label = callbackLabelMap[a.last_callback_status] || a.last_callback_status;
        }
      }
    }
    res.json({ code: 0, message: 'success', data: dashboard });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/:id(\\d+)', (req, res) => {
  try {
    const alert = AlertModel.getById(parseInt(req.params.id, 10));
    if (!alert) return res.status(404).json({ code: 404, message: '告警不存在' });
    const pushStats = {
      total: alert.push_logs?.length || 0,
      success: (alert.push_logs || []).filter(p => p.status === 'success').length,
      failed: (alert.push_logs || []).filter(p => p.status === 'failed').length,
      pending: (alert.push_logs || []).filter(p => p.status === 'pending' || p.status === 'sending').length
    };
    res.json({
      code: 0,
      data: {
        ...alert,
        level_name: LEVEL_NAMES[alert.alert_level] || alert.alert_level,
        push_stats: pushStats,
        push_payload_template: buildAlertPushPayload(alert)
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/uuid/:uuid', (req, res) => {
  try {
    const alert = AlertModel.getByUuid(req.params.uuid);
    if (!alert) return res.status(404).json({ code: 404, message: '告警不存在' });
    const pushStats = {
      total: alert.push_logs?.length || 0,
      success: (alert.push_logs || []).filter(p => p.status === 'success').length,
      failed: (alert.push_logs || []).filter(p => p.status === 'failed').length,
      pending: (alert.push_logs || []).filter(p => p.status === 'pending' || p.status === 'sending').length
    };
    res.json({
      code: 0,
      data: {
        ...alert,
        level_name: LEVEL_NAMES[alert.alert_level] || alert.alert_level,
        push_stats: pushStats
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/:id(\\d+)/reopen', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const reason = req.body.reason || null;
    const reset_timer = req.body.reset_timer === true || req.body.reset_timer === 1 || req.body.reset_timer === '1';
    const current = AlertModel.getById(id);
    if (!current) return res.status(404).json({ code: 404, message: '告警不存在' });

    const updated = AlertModel.reopen(id, reason, reset_timer ? 0 : null);
    if (!updated) return res.status(500).json({ code: 500, message: '重新打开失败' });
    res.json({
      code: 0,
      message: '已重新打开告警，静默限制已解除，可重新推送',
      data: {
        id: updated.id,
        alert_uuid: updated.alert_uuid,
        new_status: updated.status,
        new_status_label: '已通知',
        reopen_count: updated.reopen_count || 0,
        suppress_until: updated.suppress_until,
        will_renotify: true
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
