const express = require('express');
const router = express.Router();
const { PushChannelModel, PushLogModel, VALID_TYPES, VALID_LEVELS } = require('../models/pushModel');
const { buildAlertPushPayload } = require('../middleware/alertEngine');
const { sendPush, retryPushLog } = require('../middleware/pushDispatcher');

router.get('/channels/status-meta', (req, res) => {
  res.json({
    code: 0, data: {
      channel_types: VALID_TYPES.map(t => ({
        value: t,
        label: ({ webhook: '通用Webhook', sms: '短信接口', broadcast: '广播系统', email: '邮件', dingtalk: '钉钉机器人', wecom: '企业微信群机器人' })[t] || t
      })),
      alert_levels: VALID_LEVELS.map(l => ({
        value: l,
        label: ({ notice: '一般关注', verify: '需核实', emergency: '紧急处置' })[l]
      })),
      push_status: [
        { value: 'pending', label: '待推送' },
        { value: 'sending', label: '推送中' },
        { value: 'success', label: '推送成功' },
        { value: 'failed', label: '推送失败' }
      ]
    }
  });
});

router.get('/channels', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const enabled = req.query.enabled !== undefined ? (req.query.enabled === '1' || req.query.enabled === 'true') : undefined;
    const channel_type = req.query.channel_type || undefined;
    const data = PushChannelModel.getAll({ enabled, channel_type, page, pageSize });
    res.json({ code: 0, message: 'success', data });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/channels/:id(\\d+)', (req, res) => {
  try {
    const c = PushChannelModel.getById(parseInt(req.params.id, 10));
    if (!c) return res.status(404).json({ code: 404, message: '通道不存在' });
    res.json({ code: 0, data: c });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/channels', (req, res) => {
  try {
    const created = PushChannelModel.create(req.body);
    res.status(201).json({ code: 0, message: '创建成功', data: created });
  } catch (e) {
    res.status(400).json({ code: 400, message: e.message });
  }
});

router.put('/channels/:id(\\d+)', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!PushChannelModel.getById(id)) return res.status(404).json({ code: 404, message: '通道不存在' });
    const updated = PushChannelModel.update(id, req.body);
    res.json({ code: 0, message: '更新成功', data: updated });
  } catch (e) {
    res.status(400).json({ code: 400, message: e.message });
  }
});

router.patch('/channels/:id(\\d+)/enabled', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const enabled = req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === '1';
    const ok = PushChannelModel.setEnabled(id, enabled);
    if (!ok) return res.status(404).json({ code: 404, message: '通道不存在' });
    res.json({ code: 0, message: `已${enabled ? '启用' : '停用'}` });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.delete('/channels/:id(\\d+)', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ok = PushChannelModel.delete(id);
    if (!ok) return res.status(404).json({ code: 404, message: '通道不存在' });
    res.json({ code: 0, message: '删除成功' });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/channels/:id(\\d+)/test', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const channel = PushChannelModel.getById(id);
    if (!channel) return res.status(404).json({ code: 404, message: '通道不存在' });
    const testAlert = {
      alert_uuid: 'TEST-' + Date.now(),
      rule_name: '测试告警',
      alert_level: 'verify',
      department: '测试部门',
      matched_count: 1,
      content_summary: '这是一条通道连通性测试消息，请忽略。时间: ' + new Date().toLocaleString(),
      source_platform: '通道测试',
      suspected_location: '无',
      matched_keywords: ['测试'],
      verify_action: '收到消息说明通道配置正确，无需处置',
      created_at: new Date().toISOString(),
      _is_new: true,
      level_name: '需核实'
    };
    const result = await sendPush(channel, testAlert, null, true);
    res.json({ code: 0, message: '测试完成', data: result });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/logs', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const alert_id = req.query.alert_id ? parseInt(req.query.alert_id, 10) : undefined;
    const alert_uuid = req.query.alert_uuid || undefined;
    const channel_id = req.query.channel_id ? parseInt(req.query.channel_id, 10) : undefined;
    const status = req.query.status || undefined;
    const data = PushLogModel.getAll({ alert_id, alert_uuid, channel_id, status, page, pageSize });
    res.json({ code: 0, message: 'success', data });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/logs/:id(\\d+)', (req, res) => {
  try {
    const log = PushLogModel.getById(parseInt(req.params.id, 10));
    if (!log) return res.status(404).json({ code: 404, message: '日志不存在' });
    res.json({ code: 0, data: log });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/logs/:id(\\d+)/retry', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await retryPushLog(id);
    if (!result) return res.status(404).json({ code: 404, message: '日志不存在或不可重试' });
    res.json({ code: 0, message: result.status === 'success' ? '重推成功' : '重推失败', data: result });
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
