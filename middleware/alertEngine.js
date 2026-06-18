const RawMessageModel = require('../models/rawMessageModel');
const AlertModel = require('../models/alertModel');
const RuleModel = require('../models/ruleModel');
const { dispatchAlertPushes } = require('./pushDispatcher');
const {
  LEVEL_WEIGHT, LEVEL_NAMES,
  matchRule, summarizeContent, detectLocation, upgradeLevel,
  safeParse, buildAlertPushPayload
} = require('./alertUtils');

async function dryRunRules(message) {
  if (!message || typeof message.content !== 'string' || message.content.trim() === '') {
    return { matched: false, matched_rules_count: 0, matches: [], predicted_level: null, predicted_level_name: null, departments: [] };
  }
  var activeRules = RuleModel.getActiveRules();
  var matches = [];
  for (var i = 0; i < activeRules.length; i++) {
    var rule = activeRules[i];
    var kws = matchRule(rule, message.content);
    if (!kws) continue;
    var thresholdCount = rule.threshold_count || 1;
    var thresholdMinutes = rule.threshold_minutes || 10;
    matches.push({
      rule_id: rule.id,
      rule_name: rule.rule_name,
      keywords: rule.keywords,
      combine_logic: rule.combine_logic,
      matched_keywords: kws,
      department: rule.department,
      alert_level: rule.alert_level,
      level_name: LEVEL_NAMES[rule.alert_level] || rule.alert_level,
      threshold_count: thresholdCount,
      threshold_minutes: thresholdMinutes,
      dry_run_window_hits: 1,
      dry_run_missing: Math.max(0, thresholdCount - 1),
      would_trigger_now: thresholdCount <= 1,
      verify_action: rule.verify_action,
      suppress_minutes: rule.suppress_minutes === undefined || rule.suppress_minutes === null ? 60 : rule.suppress_minutes
    });
  }
  var predictedLevel = null;
  var departments = [];
  var deptSet = {};
  for (var j = 0; j < matches.length; j++) {
    predictedLevel = upgradeLevel(predictedLevel, matches[j].alert_level);
    if (!deptSet[matches[j].department]) { deptSet[matches[j].department] = 1; departments.push(matches[j].department); }
  }
  return {
    matched: matches.length > 0,
    matched_rules_count: matches.length,
    predicted_level: predictedLevel,
    predicted_level_name: predictedLevel ? LEVEL_NAMES[predictedLevel] : null,
    departments: departments,
    suspected_location: detectLocation(message.content),
    matches: matches
  };
}

async function processMessage(message, pushHook, options) {
  if (!options) options = {};
  var enablePush = options.enablePush !== false;

  if (!message || typeof message.content !== 'string' || message.content.trim() === '') {
    return { matched: false, raw_message_saved: false, triggered_alerts: [], trigger_details: [] };
  }

  var msgId = RawMessageModel.create({
    content: message.content,
    source_platform: message.source_platform || 'unknown',
    sender: message.sender || null,
    meta_json: message.meta_json || null
  });

  var contentSummary = summarizeContent(message.content, 200);
  var suspectedLoc = detectLocation(message.content);
  var activeRules = RuleModel.getActiveRules();
  var triggerDetails = [];
  var alerts = [];
  var pushPayloads = [];

  for (var i = 0; i < activeRules.length; i++) {
    var rule = activeRules[i];
    var kws = matchRule(rule, message.content);
    if (!kws) continue;

    var thresholdCount = rule.threshold_count || 1;
    var thresholdMinutes = rule.threshold_minutes || 10;
    var suppressMinutes = (rule.suppress_minutes === undefined || rule.suppress_minutes === null) ? 60 : rule.suppress_minutes;
    var exactMatch = rule.combine_logic === 'and';
    var actualCount = RawMessageModel.countByKeywords(rule.keywords, thresholdMinutes, exactMatch);

    if (actualCount < thresholdCount) {
      triggerDetails.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        matched_keywords: kws,
        alert_level: rule.alert_level,
        window_hits: actualCount,
        threshold: thresholdCount,
        threshold_minutes: thresholdMinutes,
        passed_threshold: false,
        suppressed: false,
        reason: '窗口内仅命中 ' + actualCount + ' 次，未达阈值 ' + thresholdCount
      });
      continue;
    }

    var suppressed = null;
    if (suppressMinutes > 0) {
      suppressed = AlertModel.findSuppressedByRuleDeptLocation(rule.id, rule.department, suspectedLoc, suppressMinutes);
    }
    if (suppressed) {
      triggerDetails.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        matched_keywords: kws,
        alert_level: rule.alert_level,
        window_hits: actualCount,
        threshold: thresholdCount,
        threshold_minutes: thresholdMinutes,
        passed_threshold: true,
        suppressed: true,
        suppressed_alert_uuid: suppressed.alert_uuid,
        suppress_reason: '同部门' + (suspectedLoc ? '相似地点' : '') + '已在 ' + suppressMinutes + ' 分钟静默窗口内，命中数 ' + (suppressed.matched_count || 1) + '，避免重复催办'
      });
      continue;
    }

    var alertRecord = AlertModel.findActiveByRule(rule.id, thresholdMinutes);
    var isNewAlert = !alertRecord || !alertRecord.id;
    var wasUpgraded = false;

    if (isNewAlert) {
      alertRecord = AlertModel.create({
        rule_id: rule.id,
        matched_keywords: kws,
        content_summary: contentSummary,
        source_platform: message.source_platform || 'unknown',
        suspected_location: suspectedLoc,
        alert_level: rule.alert_level,
        matched_count: actualCount,
        department: rule.department,
        verify_action: rule.verify_action,
        status: 'notified'
      });
    } else {
      var prevLevel = alertRecord.alert_level;
      alertRecord = AlertModel.incrementMatchCount(alertRecord.id, contentSummary);
      if (alertRecord) {
        var newLevel = upgradeLevel(prevLevel, rule.alert_level);
        if (newLevel !== prevLevel) {
          alertRecord = AlertModel.updateStatus(alertRecord.id, newLevel);
          alertRecord.alert_level = newLevel;
          wasUpgraded = true;
        }
        AlertModel.touchNotified(alertRecord.id);
      }
    }

    if (alertRecord && alertRecord.id) {
      alertRecord.rule_name = rule.rule_name;
      alertRecord._is_new = isNewAlert;
      alertRecord._was_upgraded = wasUpgraded;
      alerts.push(alertRecord);

      triggerDetails.push({
        rule_id: rule.id,
        rule_name: rule.rule_name,
        matched_keywords: kws,
        alert_level: alertRecord.alert_level,
        window_hits: actualCount,
        threshold: thresholdCount,
        threshold_minutes: thresholdMinutes,
        passed_threshold: true,
        suppressed: false,
        is_new_alert: isNewAlert,
        was_upgraded: wasUpgraded,
        alert_id: alertRecord.id,
        alert_uuid: alertRecord.alert_uuid
      });

      if (enablePush) {
        if (typeof pushHook === 'function') {
          try {
            var h = await pushHook(alertRecord, rule);
            if (h) pushPayloads.push(h);
          } catch (he) {
            pushPayloads.push({ error: he.message });
          }
        } else {
          try {
            var results = await dispatchAlertPushes(alertRecord, rule);
            pushPayloads.push({ alert_uuid: alertRecord.alert_uuid, pushes: results });
          } catch (de) {
            pushPayloads.push({ alert_uuid: alertRecord.alert_uuid, error: de.message });
          }
        }
      }
    }
  }

  return {
    matched: alerts.length > 0,
    raw_message_saved: true,
    raw_message_id: msgId,
    matched_rules_count: triggerDetails.filter(function (t) { return t.passed_threshold; }).length,
    triggered_alert_count: alerts.length,
    triggered_alerts: alerts.map(function (a) {
      return {
        id: a.id,
        alert_uuid: a.alert_uuid,
        rule_id: a.rule_id,
        rule_name: a.rule_name,
        alert_level: a.alert_level,
        level_name: LEVEL_NAMES[a.alert_level],
        department: a.department,
        matched_count: a.matched_count,
        is_new: a._is_new,
        was_upgraded: a._was_upgraded
      };
    }),
    push_payloads: pushPayloads,
    trigger_details: triggerDetails
  };
}

module.exports = {
  matchRule: matchRule,
  summarizeContent: summarizeContent,
  detectLocation: detectLocation,
  upgradeLevel: upgradeLevel,
  buildAlertPushPayload: buildAlertPushPayload,
  processMessage: processMessage,
  dryRunRules: dryRunRules,
  LEVEL_WEIGHT: LEVEL_WEIGHT,
  LEVEL_NAMES: LEVEL_NAMES
};
