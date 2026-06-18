const RuleModel = require('../models/ruleModel');
const AlertModel = require('../models/alertModel');
const RawMessageModel = require('../models/rawMessageModel');

const LEVEL_NAMES = {
  notice: '一般关注',
  verify: '需核实',
  emergency: '紧急处置'
};

const LEVEL_WEIGHT = {
  notice: 1,
  verify: 2,
  emergency: 3
};

function parseKeywords(rule) {
  try {
    return JSON.parse(rule.keywords);
  } catch (e) {
    return [];
  }
}

function matchRule(rule, content) {
  const keywords = parseKeywords(rule);
  const lowerContent = content.toLowerCase();
  const matched = [];

  for (const kw of keywords) {
    if (lowerContent.includes(kw.toLowerCase())) {
      matched.push(kw);
    }
  }

  if (rule.combine_logic === 'and') {
    return matched.length === keywords.length ? matched : null;
  }
  return matched.length > 0 ? matched : null;
}

function summarizeContent(content, maxLen = 150) {
  const clean = content.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.substring(0, maxLen) + '...';
}

function upgradeLevel(current, ruleLevel) {
  if (LEVEL_WEIGHT[ruleLevel] > LEVEL_WEIGHT[current]) {
    return ruleLevel;
  }
  return current;
}

async function processMessage(message, pushHook = null) {
  if (!message || !message.content || typeof message.content !== 'string') {
    return { matched: false, reason: '内容为空' };
  }

  const content = message.content;
  const source = message.source_platform || null;
  const location = message.suspected_location || null;

  RawMessageModel.create({
    content,
    source_platform: source,
    suspected_location: location
  });

  const activeRules = RuleModel.getActiveRules();
  const matchedResults = [];

  for (const rule of activeRules) {
    const matchedKeywords = matchRule(rule, content);
    if (!matchedKeywords) continue;

    const exactMatch = rule.combine_logic === 'and';
    const countInWindow = RawMessageModel.countByKeywords(parseKeywords(rule), rule.threshold_minutes, exactMatch);

    if (countInWindow < rule.threshold_count) {
      matchedResults.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        matched_keywords: matchedKeywords,
        reached_threshold: false,
        current_count: countInWindow,
        required_count: rule.threshold_count
      });
      continue;
    }

    let existingAlert = AlertModel.findActiveByRule(rule.id, rule.threshold_minutes);
    const summary = summarizeContent(content);
    let alertRecord;

    if (existingAlert && existingAlert.id) {
      alertRecord = AlertModel.incrementMatchCount(existingAlert.id, summary) || existingAlert;
      const newLevel = upgradeLevel(existingAlert.alert_level, rule.alert_level);
      if (newLevel !== existingAlert.alert_level) {
        const updated = AlertModel.updateStatus(existingAlert.id, newLevel === 'emergency' ? 'notified' : existingAlert.status, null);
        if (updated) {
          alertRecord = updated;
        }
        alertRecord.alert_level = newLevel;
      }
      alertRecord._is_new = false;
    } else {
      alertRecord = AlertModel.create({
        rule_id: rule.id,
        matched_keywords: matchedKeywords,
        content_summary: summary,
        source_platform: source,
        suspected_location: location,
        alert_level: rule.alert_level,
        matched_count: countInWindow,
        department: rule.department,
        verify_action: rule.verify_action,
        status: 'notified'
      });
      alertRecord._is_new = true;
    }

    alertRecord.level_name = LEVEL_NAMES[alertRecord.alert_level];
    try {
      alertRecord.matched_keywords = JSON.parse(alertRecord.matched_keywords);
    } catch (e) {}

    if (pushHook && typeof pushHook === 'function') {
      try {
        await pushHook(alertRecord, rule);
      } catch (err) {
        console.error('[AlertEngine] push hook failed:', err.message);
      }
    }

    matchedResults.push({
      rule_id: rule.id,
      rule_name: rule.rule_name,
      matched_keywords: matchedKeywords,
      reached_threshold: true,
      current_count: countInWindow,
      required_count: rule.threshold_count,
      alert: alertRecord
    });
  }

  const triggeredAlerts = matchedResults
    .filter(r => r.reached_threshold && r.alert)
    .map(r => r.alert);

  return {
    matched: matchedResults.length > 0,
    total_rules: activeRules.length,
    matched_rules: matchedResults.length,
    triggered_alerts: triggeredAlerts.length,
    details: matchedResults,
    alerts: triggeredAlerts
  };
}

function buildAlertPushPayload(alert) {
  return {
    alert_uuid: alert.alert_uuid,
    rule_name: alert.rule_name || '风险告警',
    alert_level: alert.alert_level,
    level_name: LEVEL_NAMES[alert.alert_level] || alert.alert_level,
    department: alert.department,
    matched_count: alert.matched_count,
    content_summary: alert.content_summary,
    source_platform: alert.source_platform || '未知来源',
    suspected_location: alert.suspected_location || '未识别',
    matched_keywords: typeof alert.matched_keywords === 'string' ? (() => {
      try { return JSON.parse(alert.matched_keywords); } catch (e) { return []; }
    })() : alert.matched_keywords,
    verify_action: alert.verify_action || '请相关部门尽快核实',
    created_at: alert.first_seen_at,
    is_new: alert._is_new !== false
  };
}

module.exports = {
  processMessage,
  buildAlertPushPayload,
  LEVEL_NAMES,
  LEVEL_WEIGHT,
  matchRule,
  parseKeywords
};
