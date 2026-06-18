const express = require('express');
const router = express.Router();
const AlertModel = require('../models/alertModel');
const RuleModel = require('../models/ruleModel');

const STATUS_OPTIONS = [
  { value: 'contacted', label: '已联系', target_alert_status: 'processing', description: '值班员已与相关部门或当事人取得联系', avoid_duplicate_push: true },
  { value: 'onsite', label: '已到场', target_alert_status: 'processing', description: '处置人员已抵达现场开展核实工作', avoid_duplicate_push: true },
  { value: 'normal', label: '现场正常', target_alert_status: 'verified_normal', description: '核实完毕，现场无异常或已恢复正常', avoid_duplicate_push: true, set_suppress: true },
  { value: 'plan', label: '启动预案', target_alert_status: 'plan_activated', description: '正式启动应急预案开展处置', avoid_duplicate_push: true, set_suppress: true },
  { value: 'escalated', label: '已升级', target_alert_status: 'processing', description: '已向上级报告请求支援', avoid_duplicate_push: true },
  { value: 'false_alarm', label: '误报', target_alert_status: 'false_alarm', description: '经核实为误报，不存在真实风险', avoid_duplicate_push: true, set_suppress: true },
  { value: 'closed', label: '已办结', target_alert_status: 'closed', description: '事件已妥善处置完毕', avoid_duplicate_push: true, set_suppress: true }
];

const ALERT_STATUS_OPTIONS = [
  { value: 'pending', label: '待处理', color: 'gray' },
  { value: 'notified', label: '已通知', color: 'blue' },
  { value: 'processing', label: '处理中', color: 'yellow' },
  { value: 'verified_normal', label: '核实正常', color: 'green' },
  { value: 'plan_activated', label: '已启动预案', color: 'orange' },
  { value: 'false_alarm', label: '误报', color: 'gray' },
  { value: 'closed', label: '已办结', color: 'green' }
];

router.get('/status-options', (req, res) => {
  res.json({
    code: 0,
    data: {
      callback_statuses: STATUS_OPTIONS,
      alert_statuses: ALERT_STATUS_OPTIONS
    }
  });
});

router.post('/', (req, res) => {
  try {
    const { alert_id, alert_uuid, callback_status, callback_remark, operator } = req.body;

    if (!callback_status) return res.status(400).json({ code: 400, message: 'callback_status 必填' });
    const statusConfig = STATUS_OPTIONS.find(s => s.value === callback_status);
    if (!statusConfig) return res.status(400).json({ code: 400, message: 'callback_status 无效' });

    if (!alert_id && !alert_uuid) return res.status(400).json({ code: 400, message: 'alert_id 或 alert_uuid 必填其一' });

    let alert = null;
    if (alert_id) {
      alert = AlertModel.getById(parseInt(alert_id, 10));
    } else if (alert_uuid) {
      alert = AlertModel.getByUuid(alert_uuid);
    }
    if (!alert) return res.status(404).json({ code: 404, message: '告警不存在' });

    const callbackId = AlertModel.addCallback({
      alert_id: alert.id,
      alert_uuid: alert.alert_uuid,
      callback_status,
      callback_remark,
      operator
    });

    AlertModel.touchNotified(alert.id);

    if (statusConfig.target_alert_status && statusConfig.target_alert_status !== alert.status) {
      const updated = AlertModel.updateStatus(alert.id, statusConfig.target_alert_status, callback_remark);
      if (updated) {
        alert.status = statusConfig.target_alert_status;
      }
    }

    if (statusConfig.set_suppress) {
      let minutes = 60;
      try {
        const rule = alert.rule_id ? RuleModel.getById(alert.rule_id) : null;
        if (rule && rule.suppress_minutes) minutes = rule.suppress_minutes;
      } catch (e) {}
      AlertModel.setSuppressUntil(alert.id, minutes);
    }

    res.json({
      code: 0,
      message: '回填成功',
      data: {
        callback_id: callbackId,
        alert_id: alert.id,
        alert_uuid: alert.alert_uuid,
        previous_alert_status: ALERT_STATUS_OPTIONS.find(s => s.value === alert.status)?.label,
        new_alert_status: ALERT_STATUS_OPTIONS.find(s => s.value === statusConfig.target_alert_status)?.value,
        avoid_duplicate_push: !!statusConfig.avoid_duplicate_push,
        suppress_minutes: statusConfig.set_suppress ? (alert.rule_id && RuleModel.getById(alert.rule_id)?.suppress_minutes) || 60 : null,
        message: statusConfig.avoid_duplicate_push ? '已标记避免重复催办' : '已记录，后续仍可能继续推送提醒'
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/alert/:id(\\d+)', (req, res) => {
  try {
    const alert = AlertModel.getById(parseInt(req.params.id, 10));
    if (!alert) return res.status(404).json({ code: 404, message: '告警不存在' });
    res.json({
      code: 0,
      data: {
        alert_id: alert.id,
        alert_uuid: alert.alert_uuid,
        callbacks: (alert.callbacks || []).map(c => ({
          ...c,
          status_label: STATUS_OPTIONS.find(s => s.value === c.callback_status)?.label || c.callback_status
        }))
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/alert-uuid/:uuid', (req, res) => {
  try {
    const alert = AlertModel.getByUuid(req.params.uuid);
    if (!alert) return res.status(404).json({ code: 404, message: '告警不存在' });
    res.json({
      code: 0,
      data: {
        alert_id: alert.id,
        alert_uuid: alert.alert_uuid,
        callbacks: (alert.callbacks || []).map(c => ({
          ...c,
          status_label: STATUS_OPTIONS.find(s => s.value === c.callback_status)?.label || c.callback_status
        }))
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const rows = require('../config/database').queryAll(`
      SELECT c.*, r.rule_name, a.alert_level, a.department, a.content_summary
      FROM callbacks c
      LEFT JOIN alerts a ON c.alert_id = a.id
      LEFT JOIN rules r ON a.rule_id = r.id
      ORDER BY c.callback_time DESC
      LIMIT $limit
    `, { $limit: limit });
    res.json({
      code: 0,
      data: rows.map(c => ({
        ...c,
        status_label: STATUS_OPTIONS.find(s => s.value === c.callback_status)?.label || c.callback_status,
        alert_level_label: ({ notice: '一般关注', verify: '需核实', emergency: '紧急处置' })[c.alert_level] || c.alert_level
      }))
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
