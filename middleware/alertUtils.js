var LEVEL_WEIGHT = { notice: 1, verify: 2, emergency: 3 };
var LEVEL_NAMES = { notice: '一般关注', verify: '需核实', emergency: '紧急处置' };

function matchRule(rule, content) {
  if (!rule || !rule.keywords || !Array.isArray(rule.keywords) || rule.keywords.length === 0) return null;
  var contentLower = String(content || '').toLowerCase();
  var kwsClean = rule.keywords
    .filter(function (k) { return typeof k === 'string' && k.trim() !== ''; })
    .map(function (k) { return k.trim(); });
  var matched = kwsClean.filter(function (k) {
    return contentLower.indexOf(k.toLowerCase()) !== -1;
  });

  if (rule.combine_logic === 'and') {
    var uniqueKws = Array.from(new Set(kwsClean.map(function (k) { return k.toLowerCase(); })));
    var uniqueMatched = Array.from(new Set(matched.map(function (k) { return k.toLowerCase(); })));
    return uniqueMatched.length >= uniqueKws.length ? matched : null;
  }
  return matched.length > 0 ? matched : null;
}

function summarizeContent(content, maxLen) {
  if (maxLen === undefined) maxLen = 150;
  if (!content) return '';
  var s = String(content).replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.substring(0, maxLen) + '...' : s;
}

function detectLocation(content) {
  if (!content) return null;
  var locRegex = /(?:在|位于|地点|位置|来到|去|到|从)([\u4e00-\u9fa5]{2,20}?(?:景区|大门|入口|出口|索道|缆车|停车场|餐厅|洗手间|商店|广场|酒店|码头|检票|站台|车站|景点|区域|门口|中心|乐园|园区|观景|游船|观光车|馆|塔|殿|山|湖|桥))/;
  var m = content.match(locRegex);
  if (m) return m[1];
  var simRegex = /([\u4e00-\u9fa5]{2,15}(?:景区|大门|入口|出口|索道|缆车|停车场|餐厅|洗手间|广场|酒店|码头|检票|站台|车站|乐园|园区|游船|观光车))/;
  var m2 = content.match(simRegex);
  return m2 ? m2[1] : null;
}

function upgradeLevel(currentLevel, newLevel) {
  var currentWeight = LEVEL_WEIGHT[currentLevel] || 0;
  var newWeight = LEVEL_WEIGHT[newLevel] || 0;
  return newWeight > currentWeight ? newLevel : currentLevel;
}

function safeParse(str, def) {
  try { return JSON.parse(str); } catch (e) { return def; }
}

function buildAlertPushPayload(alert) {
  if (!alert) return alert;
  return {
    alert_uuid: alert.alert_uuid,
    rule_name: alert.rule_name,
    rule_id: alert.rule_id,
    alert_level: alert.alert_level,
    level_name: LEVEL_NAMES[alert.alert_level] || alert.alert_level,
    department: alert.department,
    matched_count: alert.matched_count || 1,
    content_summary: alert.content_summary,
    source_platform: alert.source_platform,
    suspected_location: alert.suspected_location,
    matched_keywords: typeof alert.matched_keywords === 'string' ? safeParse(alert.matched_keywords, []) : (alert.matched_keywords || []),
    verify_action: alert.verify_action,
    created_at: alert.first_seen_at || alert.created_at,
    severity:
      alert.alert_level === 'emergency' ? 'critical' :
      alert.alert_level === 'verify' ? 'warning' : 'info',
    _is_new: alert._is_new,
    _was_upgraded: alert._was_upgraded
  };
}

module.exports = {
  LEVEL_WEIGHT,
  LEVEL_NAMES,
  matchRule,
  summarizeContent,
  detectLocation,
  upgradeLevel,
  safeParse,
  buildAlertPushPayload
};
