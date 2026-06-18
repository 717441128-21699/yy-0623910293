const express = require('express');
const router = express.Router();
const RuleModel = require('../models/ruleModel');

const VALID_ALERT_LEVELS = ['notice', 'verify', 'emergency'];
const VALID_LOGICS = ['and', 'or'];

function parseRule(rule) {
  if (!rule) return rule;
  const parsed = { ...rule };
  try {
    parsed.keywords = JSON.parse(rule.keywords);
  } catch (e) {
    parsed.keywords = [];
  }
  return parsed;
}

function validateRuleBody(body, isUpdate = false) {
  const errors = [];
  const data = {};

  if (!isUpdate && (!body.rule_name || typeof body.rule_name !== 'string' || body.rule_name.trim().length === 0)) {
    errors.push('rule_name 为必填且不能为空');
  } else if (body.rule_name !== undefined) {
    data.rule_name = body.rule_name.trim();
  }

  if (!isUpdate && (!body.keywords || !Array.isArray(body.keywords) || body.keywords.length === 0)) {
    errors.push('keywords 为必填且不能为空数组');
  } else if (body.keywords !== undefined) {
    if (!Array.isArray(body.keywords)) {
      errors.push('keywords 必须为数组');
    } else {
      data.keywords = body.keywords.map(k => String(k).trim()).filter(k => k.length > 0);
      if (data.keywords.length === 0) errors.push('keywords 不能为空数组');
    }
  }

  if (body.combine_logic !== undefined) {
    if (!VALID_LOGICS.includes(body.combine_logic)) {
      errors.push(`combine_logic 必须为 ${VALID_LOGICS.join('/')}`);
    } else {
      data.combine_logic = body.combine_logic;
    }
  }

  if (!isUpdate && (!body.department || typeof body.department !== 'string' || body.department.trim().length === 0)) {
    errors.push('department 为必填且不能为空');
  } else if (body.department !== undefined) {
    data.department = body.department.trim();
  }

  if (body.alert_level !== undefined) {
    if (!VALID_ALERT_LEVELS.includes(body.alert_level)) {
      errors.push(`alert_level 必须为 ${VALID_ALERT_LEVELS.join('/')}`);
    } else {
      data.alert_level = body.alert_level;
    }
  }

  if (body.threshold_count !== undefined) {
    const n = parseInt(body.threshold_count, 10);
    if (isNaN(n) || n < 1) {
      errors.push('threshold_count 必须为正整数');
    } else {
      data.threshold_count = n;
    }
  }

  if (body.threshold_minutes !== undefined) {
    const n = parseInt(body.threshold_minutes, 10);
    if (isNaN(n) || n < 1) {
      errors.push('threshold_minutes 必须为正整数');
    } else {
      data.threshold_minutes = n;
    }
  }

  if (body.verify_action !== undefined) {
    data.verify_action = typeof body.verify_action === 'string' ? body.verify_action.trim() : null;
  }

  if (body.status !== undefined) {
    const s = parseInt(body.status, 10);
    if (s !== 0 && s !== 1) {
      errors.push('status 必须为 0 或 1');
    } else {
      data.status = s;
    }
  }

  return { errors, data };
}

router.get('/', (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const pageSize = parseInt(req.query.pageSize, 10) || 20;
    const status = req.query.status !== undefined ? parseInt(req.query.status, 10) : undefined;

    const result = RuleModel.getAll({ status, page, pageSize });
    result.list = result.list.map(parseRule);

    res.json({
      code: 0,
      message: 'success',
      data: result
    });
  } catch (err) {
    console.error('[GET /rules] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.get('/:id(\\d+)', (req, res) => {
  try {
    const rule = parseRule(RuleModel.getById(parseInt(req.params.id, 10)));
    if (!rule) {
      return res.status(404).json({ code: 404, message: '规则不存在' });
    }
    res.json({ code: 0, message: 'success', data: rule });
  } catch (err) {
    console.error('[GET /rules/:id] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { errors, data } = validateRuleBody(req.body, false);
    if (errors.length > 0) {
      return res.status(400).json({ code: 400, message: errors.join('; ') });
    }
    const created = parseRule(RuleModel.create(data));
    res.status(201).json({ code: 0, message: '创建成功', data: created });
  } catch (err) {
    console.error('[POST /rules] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.put('/:id(\\d+)', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = RuleModel.getById(id);
    if (!existing) {
      return res.status(404).json({ code: 404, message: '规则不存在' });
    }
    const { errors, data } = validateRuleBody(req.body, true);
    if (errors.length > 0) {
      return res.status(400).json({ code: 400, message: errors.join('; ') });
    }
    const updated = parseRule(RuleModel.update(id, data));
    res.json({ code: 0, message: '更新成功', data: updated });
  } catch (err) {
    console.error('[PUT /rules/:id] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.patch('/:id(\\d+)/status', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = RuleModel.getById(id);
    if (!existing) {
      return res.status(404).json({ code: 404, message: '规则不存在' });
    }
    const status = parseInt(req.body.status, 10);
    if (status !== 0 && status !== 1) {
      return res.status(400).json({ code: 400, message: 'status 必须为 0 或 1' });
    }
    const updated = parseRule(RuleModel.update(id, { status }));
    res.json({ code: 0, message: '状态更新成功', data: updated });
  } catch (err) {
    console.error('[PATCH /rules/:id/status] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.delete('/:id(\\d+)', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const deleted = RuleModel.delete(id);
    if (!deleted) {
      return res.status(404).json({ code: 404, message: '规则不存在' });
    }
    res.json({ code: 0, message: '删除成功' });
  } catch (err) {
    console.error('[DELETE /rules/:id] error:', err);
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
