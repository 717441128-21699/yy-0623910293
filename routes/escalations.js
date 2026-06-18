const express = require('express');
const router = express.Router();
const EscalationModel = require('../models/escalationModel');
const AlertModel = require('../models/alertModel');
const RuleModel = require('../models/ruleModel');
const { PushChannelModel } = require('../models/pushModel');
const { dispatchAlertPushes } = require('../middleware/pushDispatcher');
const { LEVEL_NAMES, upgradeLevel } = require('../middleware/alertUtils');

const ESCALATION_LEVELS = {
  notice: 'verify',
  verify: 'emergency',
  emergency: null
};

const ESCALATION_REASON_LABEL = {
  auto_timeout: '超时未回填自动升级',
  manual: '值班长手动升级',
  manual_level_only: '值班长手动升级等级',
  manual_channel_only: '值班长手动定向推送'
};

router.get('/', (req, res) => {
  try {
    const { alert_id, escalation_type, result_status, page, pageSize } = req.query;
    const data = EscalationModel.getAll({ alert_id, escalation_type, result_status, page: parseInt(page) || 1, pageSize: parseInt(pageSize) || 20 });
    res.json({ code: 0, message: 'success', data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/overdue', (req, res) => {
  try {
    const minutes = parseInt(req.query.minutes) || 30;
    const overdue = EscalationModel.findOverdueAlerts(minutes);
    res.json({ code: 0, data: { escalation_minutes: minutes, count: overdue.length, alerts: overdue } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/target-options', (req, res) => {
  try {
    const channels = PushChannelModel.getAll({ enabled: 1 }).list || [];
    const byType = {};
    for (const ch of channels) {
      if (!byType[ch.channel_type]) byType[ch.channel_type] = [];
      byType[ch.channel_type].push({
        id: ch.id,
        name: ch.channel_name,
        priority: ch.priority || 0,
        applicable_levels: ch.applicable_levels
      });
    }
    res.json({
      code: 0,
      data: {
        level_options: [
          { value: 'notice', label: LEVEL_NAMES.notice, weight: 1 },
          { value: 'verify', label: LEVEL_NAMES.verify, weight: 2 },
          { value: 'emergency', label: LEVEL_NAMES.emergency, weight: 3 }
        ],
        channel_type_options: [
          { value: 'wecom', label: '企业微信群机器人' },
          { value: 'webhook', label: '通用Webhook/联动中心' },
          { value: 'sms', label: '短信接口/领导接口' },
          { value: 'broadcast', label: '景区广播系统' },
          { value: 'email', label: '邮件' },
          { value: 'dingtalk', label: '钉钉机器人' }
        ],
        channels: byType
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/manual', async (req, res) => {
  try {
    const {
      alert_id, alert_uuid, reason,
      to_level, channel_ids, channel_types,
      only_push_selected = false
    } = req.body;
    if (!alert_id && !alert_uuid) return res.status(400).json({ code: 400, message: 'alert_id 或 alert_uuid 必填' });

    const alert = alert_id
      ? AlertModel.getById(parseInt(alert_id, 10))
      : AlertModel.getByUuid(alert_uuid);
    if (!alert) return res.status(404).json({ code: 404, message: '告警不存在' });

    const fromLevel = alert.alert_level;
    let targetLevel = fromLevel;
    let levelUpgraded = false;

    if (to_level) {
      if (!LEVEL_NAMES[to_level]) return res.status(400).json({ code: 400, message: 'to_level 无效' });
      if (to_level !== fromLevel) {
        AlertModel.updateAlertLevel(alert.id, to_level);
        targetLevel = to_level;
        levelUpgraded = true;
      }
    }

    const hasChannelFilter = (channel_ids && channel_ids.length > 0) || (channel_types && channel_types.length > 0);
    if (!hasChannelFilter && !levelUpgraded) {
      return res.status(400).json({ code: 400, message: '请至少指定升级等级或目标推送通道' });
    }

    AlertModel.touchNotified(alert.id);

    const rule = alert.rule_id ? RuleModel.getById(alert.rule_id) : null;
    const freshAlert = AlertModel.getById(alert.id);
    if (freshAlert && rule) freshAlert.rule_name = rule.rule_name;

    const selectedChannelIds = channel_ids && Array.isArray(channel_ids) ? channel_ids.map(Number).filter(Boolean) : null;
    const selectedChannelTypes = channel_types && Array.isArray(channel_types) ? channel_types : null;

    const escalation = EscalationModel.create({
      alert_id: alert.id,
      alert_uuid: alert.alert_uuid,
      from_level: fromLevel,
      to_level: targetLevel,
      from_channel_type: 'original',
      to_channel_type: selectedChannelTypes ? selectedChannelTypes.join(',') : (selectedChannelIds ? 'custom_ids' : 'all'),
      reason: reason || (levelUpgraded ? `手动升级等级：${LEVEL_NAMES[fromLevel]} → ${LEVEL_NAMES[targetLevel]}` : '值班长手动升级'),
      escalation_type: 'manual',
      result_status: 'pending',
      result_message: null
    });

    let pushResults = [];
    try {
      if (freshAlert) {
        freshAlert._is_new = false;
        freshAlert._was_upgraded = levelUpgraded;
        const pushOpts = {};
        if (only_push_selected || hasChannelFilter) {
          if (selectedChannelIds) pushOpts.channel_ids = selectedChannelIds;
          if (selectedChannelTypes) pushOpts.channel_types = selectedChannelTypes;
        }
        pushResults = await dispatchAlertPushes(freshAlert, rule || null, pushOpts);
      }
    } catch (pe) {
      pushResults = [{ error: pe.message }];
    }

    EscalationModel.updateResult(escalation.id, {
      result_status: pushResults.length > 0
        ? (pushResults.some(r => r.status === 'success') ? 'sent' : (pushResults.some(r => r.status === 'failed') ? 'mixed' : 'pending'))
        : 'no_targets',
      result_message: pushResults.length > 0
        ? `已推送${pushResults.length}个通道，成功${pushResults.filter(r => r.status === 'success').length}，失败${pushResults.filter(r => r.status === 'failed').length}`
        : '未找到匹配的推送通道'
    });

    res.json({
      code: 0,
      message: '升级已执行',
      data: {
        escalation_id: escalation.id,
        alert_id: alert.id,
        alert_uuid: alert.alert_uuid,
        previous_level: fromLevel,
        previous_level_name: LEVEL_NAMES[fromLevel],
        current_level: targetLevel,
        current_level_name: LEVEL_NAMES[targetLevel],
        level_upgraded: levelUpgraded,
        status_unchanged: true,
        selected_channel_ids: selectedChannelIds,
        selected_channel_types: selectedChannelTypes,
        only_push_selected: only_push_selected || hasChannelFilter,
        push_count: pushResults.length,
        push_results: pushResults
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

async function runEscalationDaemon(escalationMinutes) {
  const minutes = escalationMinutes || 30;
  const overdue = EscalationModel.findOverdueAlerts(minutes);
  const results = [];

  for (const alert of overdue) {
    try {
      const fromLevel = alert.alert_level;
      const targetLevel = ESCALATION_LEVELS[fromLevel] || 'emergency';

      const nextChannelType = 'sms';

      const escalation = EscalationModel.create({
        alert_id: alert.id,
        alert_uuid: alert.alert_uuid,
        from_level: fromLevel,
        to_level: targetLevel,
        from_channel_type: 'wecom',
        to_channel_type: nextChannelType,
        reason: `超过 ${minutes} 分钟未回填，自动升级：${LEVEL_NAMES[fromLevel]} → ${LEVEL_NAMES[targetLevel]}`,
        escalation_type: 'auto_timeout',
        result_status: 'pending',
        result_message: null
      });

      if (targetLevel !== fromLevel) {
        AlertModel.updateAlertLevel(alert.id, targetLevel);
      }
      AlertModel.touchNotified(alert.id);

      let pushOk = false;
      try {
        const rule = alert.rule_id ? RuleModel.getById(alert.rule_id) : null;
        const freshAlert = AlertModel.getById(alert.id);
        if (freshAlert && rule) {
          freshAlert.rule_name = rule.rule_name;
          freshAlert._is_new = false;
          freshAlert._was_upgraded = true;
          await dispatchAlertPushes(freshAlert, rule, { channel_types: ['sms', 'broadcast'] });
          pushOk = true;
        }
      } catch (pe) {
        console.error('[escalation-daemon] push error:', pe.message);
      }

      EscalationModel.updateResult(escalation.id, {
        result_status: pushOk ? 'sent' : 'failed',
        result_message: pushOk ? '自动升级推送完成（短信+广播通道）' : '推送失败: see logs'
      });

      results.push({ alert_id: alert.id, from: fromLevel, to: targetLevel, push_ok: pushOk });
    } catch (e) {
      console.error('[escalation-daemon] error for alert', alert.id, e.message);
      results.push({ alert_id: alert.id, error: e.message });
    }
  }
  return results;
}

router.get('/shift-review/:shiftId', (req, res) => {
  try {
    const shiftId = parseInt(req.params.shiftId, 10);
    const ShiftModel = require('../models/shiftModel').ShiftModel;
    const shift = ShiftModel.getById(shiftId);
    if (!shift) return res.status(404).json({ code: 404, message: '班次不存在' });

    const startTime = shift.start_time;
    const endTime = shift.end_time || new Date().toISOString().replace('T', ' ').substring(0, 19);

    const { queryAll, queryOne } = require('../config/database');
    const params = { $start: startTime, $end: endTime };

    const newAlerts = queryOne(`
      SELECT COUNT(*) as count FROM alerts
      WHERE first_seen_at >= $start AND first_seen_at <= $end
    `, params) || { count: 0 };

    const alertsByLevel = queryAll(`
      SELECT alert_level, COUNT(*) as count FROM alerts
      WHERE first_seen_at >= $start AND first_seen_at <= $end
      GROUP BY alert_level
    `, params);

    const alertsByStatus = queryAll(`
      SELECT status, COUNT(*) as count FROM alerts
      WHERE first_seen_at >= $start AND first_seen_at <= $end
      GROUP BY status
    `, params);

    const escalations = queryAll(`
      SELECT ae.*, a.department
      FROM alert_escalations ae
      LEFT JOIN alerts a ON ae.alert_id = a.id
      WHERE ae.escalated_at >= $start AND ae.escalated_at <= $end
      ORDER BY ae.escalated_at DESC
    `, params);

    const slowestDepartments = queryAll(`
      SELECT
        a.department,
        COUNT(*) as alert_count,
        AVG(strftime('%s', c.callback_time) - strftime('%s', a.first_seen_at)) / 60.0 as avg_callback_minutes
      FROM alerts a
      JOIN callbacks c ON c.alert_id = a.id
      WHERE c.callback_time >= $start AND c.callback_time <= $end
        AND a.first_seen_at >= $start AND a.first_seen_at <= $end
      GROUP BY a.department
      ORDER BY avg_callback_minutes DESC
      LIMIT 10
    `, params);

    const failedPushes = queryAll(`
      SELECT
        pl.channel_name,
        pl.channel_type,
        COUNT(*) as failed_count,
        GROUP_CONCAT(DISTINCT pl.alert_uuid) as affected_uuids
      FROM push_logs pl
      WHERE pl.status = 'failed'
        AND pl.pushed_at >= $start AND pl.pushed_at <= $end
      GROUP BY pl.channel_name, pl.channel_type
      ORDER BY failed_count DESC
      LIMIT 10
    `, params);

    const unclosedByDept = queryAll(`
      SELECT department, COUNT(*) as unclosed_count
      FROM alerts
      WHERE status IN ('pending','notified','processing','plan_activated')
      GROUP BY department
      ORDER BY unclosed_count DESC
    `, {});

    const unclosedCount = unclosedByDept.reduce((s, d) => s + d.unclosed_count, 0);

    const statusLabelMap = {
      pending: '待处理', notified: '已通知', processing: '处理中',
      verified_normal: '核实正常', plan_activated: '已启动预案',
      false_alarm: '误报', closed: '已办结'
    };

    const levelLabeled = alertsByLevel.map(x => ({ level: x.alert_level, label: LEVEL_NAMES[x.alert_level] || x.alert_level, count: x.count }));
    const statusLabeled = alertsByStatus.map(x => ({ status: x.status, label: statusLabelMap[x.status] || x.status, count: x.count }));

    const slowestDeptForSummary = slowestDepartments.length > 0 ? slowestDepartments[0] : null;
    const mostFailedPush = failedPushes.length > 0 ? failedPushes[0] : null;

    const summaryText =
      `【${shift.shift_name || shift.shift_type_label || ('班次#' + shiftId)} 班后复盘】\n` +
      `时间：${startTime.substring(0, 16)} 至 ${endTime.substring(0, 16)}\n` +
      `值班：${shift.handover_person || '未登记'} → ${shift.successor_person || '未登记'}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `新增告警：${newAlerts.count} 条\n` +
      `  等级分布：${levelLabeled.length ? levelLabeled.map(x => x.label + '×' + x.count).join(' / ') : '无'}\n` +
      `  处置分布：${statusLabeled.length ? statusLabeled.map(x => x.label + '×' + x.count).join(' / ') : '无'}\n` +
      `升级次数：${escalations.length} 次（自动${escalations.filter(e => e.escalation_type === 'auto_timeout').length} / 手动${escalations.filter(e => e.escalation_type === 'manual').length}）\n` +
      `待闭环：${unclosedCount} 条${unclosedByDept.length ? '（' + unclosedByDept.map(d => d.department + '×' + d.unclosed_count).join(' / ') + '）' : ''}\n` +
      `${slowestDeptForSummary ? `最慢部门：${slowestDeptForSummary.department}，平均回填 ${Math.round(slowestDeptForSummary.avg_callback_minutes)} 分钟\n` : ''}` +
      `${mostFailedPush ? `推送失败最多：${mostFailedPush.channel_name}（${mostFailedPush.failed_count} 次）\n` : ''}` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `${shift.notes ? '值班备注：' + shift.notes + '\n' : ''}` +
      `${escalations.length ? '重点升级：' + escalations.slice(0, 3).map(e => `#${e.alert_id} ${LEVEL_NAMES[e.from_level]}→${LEVEL_NAMES[e.to_level]}`).join('；') : ''}`;

    res.json({
      code: 0,
      data: {
        shift: {
          id: shift.id,
          name: shift.shift_name,
          type: shift.shift_type,
          type_label: shift.shift_type_label,
          status: shift.status,
          status_label: shift.status_label,
          handover_person: shift.handover_person,
          successor_person: shift.successor_person,
          notes: shift.notes,
          start_time: startTime,
          end_time: endTime
        },
        time_window: { start: startTime, end: endTime },
        new_alerts: newAlerts.count,
        by_level: levelLabeled,
        by_status: statusLabeled,
        escalations: {
          total: escalations.length,
          auto_count: escalations.filter(e => e.escalation_type === 'auto_timeout').length,
          manual_count: escalations.filter(e => e.escalation_type === 'manual').length,
          list: escalations.slice(0, 50)
        },
        slowest_departments: slowestDepartments.map(d => ({
          department: d.department,
          alert_count: d.alert_count,
          avg_callback_minutes: Math.round(d.avg_callback_minutes * 10) / 10
        })),
        failed_pushes: failedPushes.map(f => ({
          channel_name: f.channel_name,
          channel_type: f.channel_type,
          failed_count: f.failed_count,
          affected_count: f.affected_uuids ? f.affected_uuids.split(',').length : 0
        })),
        unclosed: {
          total: unclosedCount,
          by_department: unclosedByDept
        },
        summary_text: summaryText
      }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = { router, runEscalationDaemon };
