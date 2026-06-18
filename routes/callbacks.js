const express = require('express');
const router = express.Router();
const AlertModel = require('../models/alertModel');

const CALLBACK_STATUS = {
  contacted: {
    label: '已联系',
    target_alert_status: 'processing',
    description: '已与责任部门或相关人员取得联系'
  },
  onsite: {
    label: '已到场',
    target_alert_status: 'processing',
    description: '工作人员已抵达现场'
  },
  verified_normal: {
    label: '现场正常',
    target_alert_status: 'verified_normal',
    description: '经现场核实，无异常情况，可关闭'
  },
  plan_activated: {
    label: '启动预案',
    target_alert_status: 'plan_activated',
    description: '已按应急预案开展处置工作'
  },
  escalated: {
    label: '已升级上报',
    target_alert_status: 'processing',
    description: '已上报至更高层级领导或部门'
  },
  false_alarm: {
    label: '误报',
    target_alert_status: 'closed',
    description: '经核实为误报，无需进一步处置'
  },
  resolved: {
    label: '已办结',
    target_alert_status: 'closed',
    description: '事件已处置完毕，流程闭环结束'
  }
};

const ALERT_STATUS_LABELS = {
  pending: '待推送',
  notified: '已推送待响应',
  processing: '处理中',
  verified_normal: '核实正常',
  plan_activated: '预案启动中',
  closed: '已关闭'
};

function isValidCallbackStatus(status) {
  return Object.prototype.hasOwnProperty.call(CALLBACK_STATUS, status);
}

router.get('/status-options', (req, res) => {
  const options = Object.entries(CALLBACK_STATUS).map(([key, val]) => ({
    value: key,
    label: val.label,
    description: val.description,
    target_alert_status: val.target_alert_status,
    target_alert_status_label: ALERT_STATUS_LABELS[val.target_alert_status]
  }));

  const alertStatusOptions = Object.entries(ALERT_STATUS_LABELS).map(([key, label]) => ({
    value: key,
    label
  }));

  res.json({
    code: 0,
    message: 'success',
    data: {
      callback_options: options,
      alert_status_options: alertStatusOptions
    }
  });
});

router.post('/', (req, res) => {
  try {
    const { alert_id, alert_uuid, callback_status, callback_remark, operator } = req.body;

    if (!alert_id && !alert_uuid) {
      return res.status(400).json({ code: 400, message: 'alert_id 和 alert_uuid 至少填写一项' });
    }

    if (!callback_status || !isValidCallbackStatus(callback_status)) {
      return res.status(400).json({
        code: 400,
        message: `callback_status 无效，可选值: ${Object.keys(CALLBACK_STATUS).join(', ')}`
      });
    }

    let alert;
    if (alert_id) {
      alert = AlertModel.getById(parseInt(alert_id, 10));
    } else {
      alert = AlertModel.getByUuid(alert_uuid);
    }

    if (!alert) {
      return res.status(404).json({ code: 404, message: '告警记录不存在' });
    }

    const targetStatus = CALLBACK_STATUS[callback_status].target_alert_status;
    AlertModel.updateStatus(alert.id, targetStatus);

    AlertModel.addCallback({
      alert_id: alert.id,
      alert_uuid: alert.alert_uuid,
      callback_status,
      callback_remark: callback_remark && typeof callback_remark === 'string' ? callback_remark.trim() : null,
      operator: operator && typeof operator === 'string' ? operator.trim() : null
    });

    const updatedAlert = AlertModel.getById(alert.id);
    const latestCallback = updatedAlert.callbacks && updatedAlert.callbacks.length > 0 ? updatedAlert.callbacks[0] : null;

    res.json({
      code: 0,
      message: `回填成功：${CALLBACK_STATUS[callback_status].label}`,
      data: {
        alert_uuid: alert.alert_uuid,
        alert_id: alert.id,
        callback_status,
        callback_label: CALLBACK_STATUS[callback_status].label,
        alert_updated_status: targetStatus,
        alert_updated_status_label: ALERT_STATUS_LABELS[targetStatus],
        latest_callback: latestCallback,
        avoid_duplicate_push: targetStatus === 'closed' || targetStatus === 'verified_normal'
      }
    });
  } catch (err) {
    console.error('[POST /callbacks] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/alert/:alertId(\\d+)', (req, res) => {
  try {
    const alert = AlertModel.getById(parseInt(req.params.alertId, 10));
    if (!alert) {
      return res.status(404).json({ code: 404, message: '告警不存在' });
    }
    const callbacksWithLabels = (alert.callbacks || []).map(cb => ({
      ...cb,
      callback_label: CALLBACK_STATUS[cb.callback_status] ? CALLBACK_STATUS[cb.callback_status].label : cb.callback_status
    }));

    res.json({
      code: 0,
      message: 'success',
      data: {
        alert_id: alert.id,
        alert_uuid: alert.alert_uuid,
        current_status: alert.status,
        current_status_label: ALERT_STATUS_LABELS[alert.status] || alert.status,
        callback_history: callbacksWithLabels
      }
    });
  } catch (err) {
    console.error('[GET /callbacks/alert/:alertId] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/alert-uuid/:uuid', (req, res) => {
  try {
    const alert = AlertModel.getByUuid(req.params.uuid);
    if (!alert) {
      return res.status(404).json({ code: 404, message: '告警不存在' });
    }
    const callbacksWithLabels = (alert.callbacks || []).map(cb => ({
      ...cb,
      callback_label: CALLBACK_STATUS[cb.callback_status] ? CALLBACK_STATUS[cb.callback_status].label : cb.callback_status
    }));

    res.json({
      code: 0,
      message: 'success',
      data: {
        alert_id: alert.id,
        alert_uuid: alert.alert_uuid,
        current_status: alert.status,
        current_status_label: ALERT_STATUS_LABELS[alert.status] || alert.status,
        callback_history: callbacksWithLabels
      }
    });
  } catch (err) {
    console.error('[GET /callbacks/alert-uuid/:uuid] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/recent', (req, res) => {
  try {
    const { queryAll } = require('../config/database');
    const limit = parseInt(req.query.limit, 10) || 50;

    const rows = queryAll(`
      SELECT c.*, a.department, a.alert_level, a.content_summary,
             r.rule_name
      FROM callbacks c
      JOIN alerts a ON c.alert_id = a.id
      LEFT JOIN rules r ON a.rule_id = r.id
      ORDER BY c.callback_time DESC
      LIMIT $limit
    `, { $limit: limit });

    const result = rows.map(cb => ({
      ...cb,
      callback_label: CALLBACK_STATUS[cb.callback_status] ? CALLBACK_STATUS[cb.callback_status].label : cb.callback_status,
      alert_level_name: (cb.alert_level === 'notice') ? '一般关注' : (cb.alert_level === 'verify' ? '需核实' : '紧急处置')
    }));

    res.json({ code: 0, message: 'success', data: result });
  } catch (err) {
    console.error('[GET /callbacks/recent] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
module.exports.CALLBACK_STATUS = CALLBACK_STATUS;
module.exports.ALERT_STATUS_LABELS = ALERT_STATUS_LABELS;
