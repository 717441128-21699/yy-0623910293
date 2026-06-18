const express = require('express');
const router = express.Router();
const { ShiftModel, SHIFT_TYPES, SHIFT_TYPE_LABELS, SHIFT_STATUS_LABELS } = require('../models/shiftModel');

router.get('/types', (req, res) => {
  res.json({
    code: 0,
    data: {
      shift_types: SHIFT_TYPES.map(t => ({ value: t, label: SHIFT_TYPE_LABELS[t] })),
      shift_statuses: Object.keys(SHIFT_STATUS_LABELS).map(k => ({ value: k, label: SHIFT_STATUS_LABELS[k] }))
    }
  });
});

router.get('/', (req, res) => {
  try {
    const { status, shift_type, page, pageSize } = req.query;
    const data = ShiftModel.getAll({ status, shift_type, page: parseInt(page) || 1, pageSize: parseInt(pageSize) || 20 });
    res.json({ code: 0, message: 'success', data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/active', (req, res) => {
  try {
    const active = ShiftModel.getActive();
    if (!active) return res.json({ code: 0, data: null, message: '当前无值班班次' });
    if (typeof active.handover_summary === 'string') {
      try { active.handover_summary = JSON.parse(active.handover_summary); } catch (e) {}
    }
    active.shift_type_label = SHIFT_TYPE_LABELS[active.shift_type] || active.shift_type;
    active.status_label = SHIFT_STATUS_LABELS[active.status] || active.status;
    res.json({ code: 0, data: active });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/:id(\\d+)', (req, res) => {
  try {
    const shift = ShiftModel.getById(parseInt(req.params.id, 10));
    if (!shift) return res.status(404).json({ code: 404, message: '班次不存在' });
    if (typeof shift.handover_summary === 'string') {
      try { shift.handover_summary = JSON.parse(shift.handover_summary); } catch (e) {}
    }
    res.json({ code: 0, data: shift });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.get('/:id(\\d+)/previous', (req, res) => {
  try {
    const prev = ShiftModel.getPrevious(parseInt(req.params.id, 10));
    if (!prev) return res.json({ code: 0, data: null, message: '无上一班次记录' });
    if (typeof prev.handover_summary === 'string') {
      try { prev.handover_summary = JSON.parse(prev.handover_summary); } catch (e) {}
    }
    prev.shift_type_label = SHIFT_TYPE_LABELS[prev.shift_type] || prev.shift_type;
    prev.status_label = SHIFT_STATUS_LABELS[prev.status] || prev.status;
    res.json({ code: 0, data: prev });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { shift_name, shift_type, handover_person, successor_person, start_time, notes } = req.body;
    if (shift_type && !SHIFT_TYPES.includes(shift_type)) {
      return res.status(400).json({ code: 400, message: 'shift_type 无效，可选: ' + SHIFT_TYPES.join('/') });
    }
    const created = ShiftModel.create({
      shift_name, shift_type: shift_type || 'morning',
      handover_person, successor_person, start_time, notes
    });
    res.status(201).json({ code: 0, message: '班次创建成功', data: created });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.post('/:id(\\d+)/handover', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { successor_person, notes } = req.body;
    const result = ShiftModel.handover(id, { successor_person, notes });
    if (!result) return res.status(400).json({ code: 400, message: '交班失败，班次不存在或已交班' });
    res.json({ code: 0, message: '交班成功', data: result });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

router.patch('/:id(\\d+)/notes', (req, res) => {
  try {
    const { notes } = req.body;
    if (notes === undefined) return res.status(400).json({ code: 400, message: 'notes 必填' });
    const updated = ShiftModel.updateNotes(parseInt(req.params.id, 10), notes);
    if (!updated) return res.status(404).json({ code: 404, message: '班次不存在' });
    res.json({ code: 0, message: '备注更新成功', data: updated });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 500, message: e.message });
  }
});

module.exports = router;
