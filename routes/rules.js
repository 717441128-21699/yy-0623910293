const express = require('express');
const router = express.Router();
const RuleModel = require('../models/ruleModel');

const VALID_LEVELS = ['notice', 'verify', 'emergency'];
const VALID_COMBINE = ['or', 'and'];

router.get('/', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const status = req.query.status !== undefined ? (req.query.status === '1' || req.query.status === 'true') ? 1 : 0 : undefined;
    const data = RuleModel.getAll({ status, page, pageSize });
    res.json({ code: 0, message: 'success', data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/:id(\\d+)', (req, res) => {
  try {
    const rule = RuleModel.getById(parseInt(req.params.id, 10));
    if (!rule) return res.status(404).json({ code: 404, message: '规则不存在' });
    res.json({ code: 0, data: rule });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { rule_name, keywords, combine_logic, department, alert_level, threshold_count, threshold_minutes, verify_action, status, suppress_minutes } = req.body;

    if (!rule_name || !rule_name.trim()) return res.status(400).json({ code: 400, message: 'rule_name 必填' });
    if (!Array.isArray(keywords) || keywords.length === 0) return res.status(400).json({ code: 400, message: 'keywords 必填且为数组' });
    if (!department || !department.trim()) return res.status(400).json({ code: 400, message: 'department 必填' });
    if (!VALID_LEVELS.includes(alert_level)) return res.status(400).json({ code: 400, message: 'alert_level 无效，可选: notice/verify/emergency' });
    if (combine_logic && !VALID_COMBINE.includes(combine_logic)) return res.status(400).json({ code: 400, message: 'combine_logic 无效，可选: or/and' });
    if (threshold_count !== undefined && (typeof threshold_count !== 'number' || threshold_count <= 0)) {
      return res.status(400).json({ code: 400, message: 'threshold_count 必须为正整数' });
    }
    if (threshold_minutes !== undefined && (typeof threshold_minutes !== 'number' || threshold_minutes <= 0)) {
      return res.status(400).json({ code: 400, message: 'threshold_minutes 必须为正整数' });
    }
    if (suppress_minutes !== undefined && (typeof suppress_minutes !== 'number' || suppress_minutes < 0)) {
      return res.status(400).json({ code: 400, message: 'suppress_minutes 必须为非负整数（0 表示不静默）' });
    }

    const created = RuleModel.create({
      rule_name,
      keywords,
      combine_logic: combine_logic || 'or',
      department,
      alert_level,
      threshold_count: threshold_count || 3,
      threshold_minutes: threshold_minutes || 10,
      verify_action: verify_action || null,
      status: status !== undefined ? status : 1,
      suppress_minutes: suppress_minutes || 60
    });
    res.status(201).json({ code: 0, message: '创建成功', data: created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.put('/:id(\\d+)', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rule_name, keywords, combine_logic, department, alert_level, threshold_count, threshold_minutes, verify_action, status, suppress_minutes } = req.body;

    if (alert_level !== undefined && !VALID_LEVELS.includes(alert_level)) {
      return res.status(400).json({ code: 400, message: 'alert_level 无效，可选: notice/verify/emergency' });
    }
    if (combine_logic !== undefined && !VALID_COMBINE.includes(combine_logic)) {
      return res.status(400).json({ code: 400, message: 'combine_logic 无效，可选: or/and' });
    }
    if (threshold_count !== undefined && (typeof threshold_count !== 'number' || threshold_count <= 0)) {
      return res.status(400).json({ code: 400, message: 'threshold_count 必须为正整数' });
    }
    if (threshold_minutes !== undefined && (typeof threshold_minutes !== 'number' || threshold_minutes <= 0)) {
      return res.status(400).json({ code: 400, message: 'threshold_minutes 必须为正整数' });
    }
    if (suppress_minutes !== undefined && (typeof suppress_minutes !== 'number' || suppress_minutes < 0)) {
      return res.status(400).json({ code: 400, message: 'suppress_minutes 必须为非负整数' });
    }
    if (keywords !== undefined && !Array.isArray(keywords)) {
      return res.status(400).json({ code: 400, message: 'keywords 必须为数组' });
    }

    const updated = RuleModel.update(id, {
      rule_name, keywords, combine_logic, department, alert_level,
      threshold_count, threshold_minutes, verify_action, status, suppress_minutes
    });
    if (!updated) return res.status(404).json({ code: 404, message: '规则不存在' });
    res.json({ code: 0, message: '更新成功', data: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.patch('/:id(\\d+)/status', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const status = req.body.status === 1 || req.body.status === true || req.body.status === '1' ? 1 : 0;
    const updated = RuleModel.update(id, { status });
    if (!updated) return res.status(404).json({ code: 404, message: '规则不存在' });
    res.json({ code: 0, message: `已${status === 1 ? '启用' : '停用'}`, data: { status: updated.status } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.delete('/:id(\\d+)', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const ok = RuleModel.delete(id);
    if (!ok) return res.status(404).json({ code: 404, message: '规则不存在' });
    res.json({ code: 0, message: '删除成功' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
