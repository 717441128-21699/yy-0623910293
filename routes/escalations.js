const express = require('express');
const router = express.Router();
const EscalationModel = require('../models/escalationModel');
const AlertModel = require('../models/alertModel');
const { PushChannelModel } = require('../models/pushModel');
const { dispatchAlertPushes } = require('../middleware/pushDispatcher');
const { LEVEL_NAMES, upgradeLevel } = require('../middleware/alertUtils');

const ESCALATION_LEVELS = {
  notice: 'verify',
  verify: 'emergency',
  emergency: null
};

const ESCALATION_CHANNEL_ORDER = ['wecom', 'webhook', 'broadcast', 'sms', 'email', 'dingtalk'];

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

router.post('/manual', async (req, res) => {
  try {
    const { alert_id, alert_uuid, reason, to_level, to_channel_type } = req.body;
    if (!alert_id && !alert_uuid) return res.status(400).json({ code: 400, message: 'alert_id 或 alert_uuid 必填' });

    const alert = alert_id
      ? AlertModel.getById(parseInt(alert_id, 10))
      : AlertModel.getByUuid(alert_uuid);
    if (!alert) return res.status(404).json({ code: 404, message: '告警不存在' });

    const fromLevel = alert.alert_level;
    const targetLevel = to_level || ESCALATION_LEVELS[fromLevel] || 'emergency';

    if (fromLevel === targetLevel && targetLevel === 'emergency') {
      return res.json({ code: 0, message: '告警已是最高等级，无法继续升级', data: { alert_id: alert.id, current_level: fromLevel } });
    }

    const lastPushLog = EscalationModel.getByAlert(alert.id)
      .filter(e => e.result_status === 'sent')
      .sort((a, b) => (b.escalated_at || '').localeCompare(a.escalated_at || ''))[0];
    const fromChannelType = lastPushLog ? lastPushLog.to_channel_type : 'wecom';

    const escalation = EscalationModel.create({
      alert_id: alert.id,
      alert_uuid: alert.alert_uuid,
      from_level: fromLevel,
      to_level: targetLevel,
      from_channel_type: fromChannelType,
      to_channel_type: to_channel_type || 'sms',
      reason: reason || '人工手动升级',
      escalation_type: 'manual',
      result_status: 'pending',
      result_message: null
    });

    let upgradeResult = null;
    if (targetLevel !== fromLevel) {
      AlertModel.updateStatus(alert.id, targetLevel);
      AlertModel.touchNotified(alert.id);
      upgradeResult = { level_upgraded: true, from: fromLevel, to: targetLevel };
    }

    let pushResults = [];
    try {
      const rule = alert.rule_id ? require('../models/ruleModel').getById(alert.rule_id) : null;
      const freshAlert = AlertModel.getById(alert.id);
      if (freshAlert && rule) {
        freshAlert.rule_name = rule.rule_name;
        freshAlert._is_new = false;
        freshAlert._was_upgraded = true;
        pushResults = await dispatchAlertPushes(freshAlert, rule);
      }
    } catch (pe) {
      pushResults = [{ error: pe.message }];
    }

    EscalationModel.updateResult(escalation.id, {
      result_status: pushResults.length > 0 ? 'sent' : 'failed',
      result_message: pushResults.length > 0 ? '升级推送已发送' : '推送失败'
    });

    res.json({
      code: 0,
      message: '告警已升级',
      data: {
        escalation_id: escalation.id,
        alert_id: alert.id,
        alert_uuid: alert.alert_uuid,
        from_level: fromLevel,
        from_level_name: LEVEL_NAMES[fromLevel],
        to_level: targetLevel,
        to_level_name: LEVEL_NAMES[targetLevel],
        upgrade: upgradeResult,
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
      const lastCallback = (alert._callbacks && alert._callbacks.length > 0) ? alert._callbacks[0] : null;

      const nextChannelType = 'sms';

      const escalation = EscalationModel.create({
        alert_id: alert.id,
        alert_uuid: alert.alert_uuid,
        from_level: fromLevel,
        to_level: targetLevel,
        from_channel_type: 'wecom',
        to_channel_type: nextChannelType,
        reason: `超过 ${minutes} 分钟未回填，自动从 ${LEVEL_NAMES[fromLevel]} 升级至 ${LEVEL_NAMES[targetLevel]}`,
        escalation_type: 'auto',
        result_status: 'pending',
        result_message: null
      });

      if (targetLevel !== fromLevel) {
        AlertModel.updateStatus(alert.id, targetLevel);
      }
      AlertModel.touchNotified(alert.id);

      let pushOk = false;
      try {
        const RuleModel = require('../models/ruleModel');
        const rule = alert.rule_id ? RuleModel.getById(alert.rule_id) : null;
        const freshAlert = AlertModel.getById(alert.id);
        if (freshAlert && rule) {
          freshAlert.rule_name = rule.rule_name;
          freshAlert._is_new = false;
          freshAlert._was_upgraded = true;
          await dispatchAlertPushes(freshAlert, rule);
          pushOk = true;
        }
      } catch (pe) {
        console.error('[escalation-daemon] push error:', pe.message);
      }

      EscalationModel.updateResult(escalation.id, {
        result_status: pushOk ? 'sent' : 'failed',
        result_message: pushOk ? '自动升级推送完成' : '推送失败: ' + (pushOk === false ? 'see logs' : '')
      });

      results.push({ alert_id: alert.id, from: fromLevel, to: targetLevel, push_ok: pushOk });
    } catch (e) {
      console.error('[escalation-daemon] error for alert', alert.id, e.message);
      results.push({ alert_id: alert.id, error: e.message });
    }
  }
  return results;
}

module.exports = { router, runEscalationDaemon };
