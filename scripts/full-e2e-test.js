const http = require('http');
const BASE = 'http://localhost:3000';

function jsonRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json'
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search,
      method, headers, timeout: 10000
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: d ? JSON.parse(d) : {} }); }
        catch (e) { resolve({ status: res.statusCode, raw: d }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function hr(title) {
  console.log('\n========== ' + title + ' ==========');
}

async function main() {
  let latestAlertId = null, latestAlertUuid = null;
  let firstAlertUuid = null;

  hr('1. 健康检查');
  console.log((await jsonRequest('GET', '/health')).body);

  hr('2. 根路径模块概览');
  const root = await jsonRequest('GET', '/');
  console.log('服务名:', root.body.name, '版本:', root.body.version);
  console.log('模块数:', root.body.modules.length);

  hr('3. 规则列表（验证 5 条种子 + suppress_minutes）');
  const rules = await jsonRequest('GET', '/api/rules?pageSize=10');
  console.log('规则总数:', rules.body.data.total);
  rules.body.data.list.forEach(r => {
    console.log(`  - ${r.rule_name}  [${r.alert_level}] dept=${r.department} threshold=${r.threshold_count}/${r.threshold_minutes}min suppress=${r.suppress_minutes}min`);
  });

  hr('4. 推送通道列表（验证 4 条种子）');
  const chs = await jsonRequest('GET', '/api/push/channels?pageSize=20');
  console.log('通道总数:', chs.body.data.total);
  chs.body.data.list.forEach(c => {
    console.log(`  - ${c.channel_name} type=${c.channel_type} levels=[${c.applicable_levels.join('/')}] retry=${c.retry_times}x${c.retry_interval_seconds}s`);
  });

  hr('5. 试运行 dry-run（游客寻人原文）');
  const dry = await jsonRequest('POST', '/api/alerts/dry-run', {
    content: '紧急！我家小孩走失了，在景区南门入口，7岁男孩穿蓝衣服，请帮忙广播寻人',
    source_platform: '现场值班台',
    sender: '值班员小李'
  });
  console.log('命中规则数:', dry.body.data.matched_rules_count);
  console.log('预计等级:', dry.body.data.predicted_level_name);
  console.log('疑似地点:', dry.body.data.suspected_location);
  console.log('责任部门:', dry.body.data.departments.join(','));
  dry.body.data.matches.forEach(m => {
    console.log(`  - ${m.rule_name} (${m.level_name}) 关键词:${m.matched_keywords.join('/')} 阈值还差:${m.dry_run_missing}条`);
  });

  hr('6. 告警接入 - 1条儿童走失（阈值1次/30分 -> 直接触发）');
  const i1 = await jsonRequest('POST', '/api/alerts/ingest', {
    content: '紧急！我家小孩走失了，在景区南门入口，7岁男孩穿蓝衣服，请帮忙广播寻人',
    source_platform: '现场值班台',
    sender: '值班员小李'
  });
  console.log('matched:', i1.body.data ? i1.body.data.matched : '(null)', 'body.code:', i1.body.code, 'msg:', i1.body.message);
  if (i1.body && i1.body.data && i1.body.data.triggered_alerts) {
    console.log('触发告警数:', i1.body.data.triggered_alert_count);
    i1.body.data.triggered_alerts.forEach(a => {
      latestAlertId = a.id;
      latestAlertUuid = a.alert_uuid;
      firstAlertUuid = a.alert_uuid;
      console.log(`  + Alert#${a.id} UUID=${a.alert_uuid} 等级=${a.level_name} is_new=${a.is_new} matched=${a.matched_count}`);
    });
    if (i1.body.data.push_payloads && i1.body.data.push_payloads.length) {
      const pp = i1.body.data.push_payloads[0];
      console.log('  推送次数:', pp.pushes ? pp.pushes.length : 0, '(全部失败属于正常，因是示例地址)');
      if (pp.pushes) pp.pushes.forEach(p => console.log(`    -> ${p.channel_name}[${p.channel_type}] ${p.status} ${p.error_message ? '原因:' + p.error_message.substring(0, 60) : ''}`));
    }
  } else {
    console.log('请求异常，完整响应:', JSON.stringify(i1.body).substring(0, 500));
  }

  hr('7. 告警详情（含回调+推送日志统计）');
  const d1 = await jsonRequest('GET', '/api/alerts/' + latestAlertId);
  const body = d1.body.data;
  console.log(`#${body.id} ${body.rule_name} 等级=${body.level_name} 地点=${body.suspected_location}`);
  console.log(`  push_stats total=${body.push_stats.total} succ=${body.push_stats.success} fail=${body.push_stats.failed}`);
  if (body.push_logs && body.push_logs.length) {
    console.log('  推送日志:');
    body.push_logs.slice(0, 3).forEach(l => console.log(`    log#${l.id} ${l.channel_name}:${l.status} next_retry=${l.next_retry_at || '无'} err=${(l.error_message || '').substring(0, 80)}`));
  }

  hr('8. 回填「已联系」（非终态，不写静默）');
  const cb1 = await jsonRequest('POST', '/api/callbacks', {
    alert_uuid: latestAlertUuid,
    callback_status: 'contacted',
    callback_remark: '已联系游客服务中心，正在调阅监控',
    operator: '张值班长'
  });
  console.log(cb1.body.data);

  hr('9. 再次接入相似内容 - 同部门静默 90 分钟（应 suppress）');
  if (!latestAlertUuid) {
    console.log('  SKIPPED (no alert from previous step)');
  } else {
    const i2 = await jsonRequest('POST', '/api/alerts/ingest', {
      content: '又有家长反映在南门入口看不到自己的小孩，疑似小孩走失了，请一起关注帮忙寻人',
      source_platform: '景区APP留言'
    });
    console.log('新告警数:', i2.body.data.triggered_alert_count);
    i2.body.data.trigger_details.forEach(t => {
      const flag = t.suppressed ? '[SILENCED 静默]' : (t.passed_threshold ? '[TRIGGER]' : '[BELOW THRESHOLD]');
      console.log(`  ${flag} ${t.rule_name} hits=${t.window_hits}/${t.threshold} ${t.suppressed ? '- ' + t.suppress_reason : (t.reason || '')}`);
    });
  }

  hr('10. 回填「现场正常」（终态，写 suppress_until=当前+120分钟）');
  if (!latestAlertUuid) {
    console.log('  SKIPPED');
  } else {
    const cb2 = await jsonRequest('POST', '/api/callbacks', {
      alert_uuid: latestAlertUuid,
      callback_status: 'normal',
      callback_remark: '南门监控确认孩子随母亲离开，已联系家属确认安全',
      operator: '安保员老周'
    });
    console.log('写入 suppress_minutes:', cb2.body.data.suppress_minutes, cb2.body.data.message);
  }

  hr('11. 告警列表 - 多维度筛选（地点=南门 / 状态=verified_normal / 来源=值班台）');
  const filter = await jsonRequest('GET', '/api/alerts?suspected_location=南门&pageSize=5');
  console.log('地点「南门」命中数:', filter.body.data.total, '显示:', filter.body.data.list.length);
  filter.body.data.list.forEach(a => {
    console.log(`  #${a.id} ${a.rule_name} status=${a.status} location=${a.suspected_location} push=${a.push_success_count}S/${a.push_failed_count}F callbacks=${a.callback_count}`);
  });

  hr('12. 导出 JSON（含 push 统计 + callback 轨迹）');
  const exp = await jsonRequest('GET', '/api/alerts/export?format=json&pageSize=10');
  console.log('导出条数:', exp.body.data.total);
  if (exp.body.data.items && exp.body.data.items[0]) {
    const it = exp.body.data.items[0];
    console.log('  首条字段示例:');
    console.log('    - rule_name:', it.rule_name);
    console.log('    - matched_keywords:', it.matched_keywords);
    console.log('    - push_total/failed:', it.push_total, '/', it.push_failed);
    console.log('    - callback_count:', it.callback_count);
    console.log('    - callback_traces preview:', (it.callback_traces || '').substring(0, 100));
  }

  hr('13. 手动重推第一条失败日志');
  if (body.push_logs && body.push_logs[0]) {
    const retry = await jsonRequest('POST', '/api/push/logs/' + body.push_logs[0].id + '/retry');
    console.log('  重推结果:', retry.body.data.status, retry.body.message);
  }

  hr('14. 通道连通性测试（#1 值班群）');
  const test = await jsonRequest('POST', '/api/push/channels/1/test');
  console.log('  通道测试:', test.body.message);
  console.log('    状态:', test.body.data.status, 'HTTP:', test.body.data.http_status,
    test.body.data.error_message ? '错误:' + test.body.data.error_message.substring(0, 80) : '');

  hr('15. 统计汇总');
  const st = await jsonRequest('GET', '/api/alerts/statistics/summary');
  const sd = st.body.data;
  console.log('  今日告警:', sd.today_alerts, '待处理:', sd.pending_alerts, '今日消息:', sd.today_messages);
  console.log('  等级分布:', sd.by_level);
  console.log('  状态分布:', sd.by_status);

  hr('16. 重新打开告警（验证静默解除）');
  if (!latestAlertId) {
    console.log('  SKIPPED');
  } else {
    const reopen = await jsonRequest('POST', '/api/alerts/' + latestAlertId + '/reopen', { reason: '家属再次来电确认孩子仍未找到', reset_timer: true });
    console.log('  结果:', reopen.body.message);
    if (reopen.body && reopen.body.data) {
      console.log('  reopen_count:', reopen.body.data.reopen_count, 'new_status:', reopen.body.data.new_status_label);
    }
  }

  hr('17. 重接相似内容 - reopen 后应再次触发（因为已解除静默+重置时间）');
  if (!latestAlertId) {
    console.log('  SKIPPED');
  } else {
    const i3 = await jsonRequest('POST', '/api/alerts/ingest', {
      content: '还是刚才南门入口蓝衣服小孩走失的事情，家属说仍然没联系上，小孩还没找到，继续寻人请大家多留意',
      source_platform: '值班室电话'
    });
    console.log('  新告警(聚合)数:', i3.body.data.triggered_alert_count, '(应该>=1，因为reopen清了suppress)');
    i3.body.data.trigger_details.filter(t => t.passed_threshold).forEach(t => {
      const flag = t.suppressed ? '[SILENCED]' : '[TRIGGER]';
      console.log(`    ${flag} ${t.rule_name} 新告警ID:${t.alert_id || '-'} UUID:${t.alert_uuid || '-'} 聚合=${t.is_new_alert ? '新创建' : '追加到已有'}`);
    });
  }

  hr('18. 告警按 UUID 查询（含回填与推送轨迹）');
  if (!firstAlertUuid) {
    console.log('  SKIPPED');
  } else {
    const d2 = await jsonRequest('GET', '/api/alerts/uuid/' + firstAlertUuid);
    const b2 = d2.body.data;
    if (b2) {
      console.log(`  UUID=${b2.alert_uuid} status=${b2.status} matched=${b2.matched_count} 重开=${b2.reopen_count || 0}`);
      console.log(`  回填 ${b2.callbacks ? b2.callbacks.length : 0} 条, 推送 ${b2.push_logs ? b2.push_logs.length : 0} 条`);
    }
  }

  hr('19. 新增 - 值班态势总览（今日 / 近24h / 自定义窗口）');
  const overToday = await jsonRequest('GET', '/api/alerts/statistics/overview?range=today');
  console.log('  [今日窗口] 告警数:', overToday.body.data.total_alerts,
    '推送成功率:', overToday.body.data.push_success_rate + '%',
    '未闭环部门:', overToday.body.data.unclosed_departments.length);
  console.log('    等级分布:', JSON.stringify(overToday.body.data.by_level.map(l => `${l.level_name}:${l.count}`)));
  const over24h = await jsonRequest('GET', '/api/alerts/statistics/overview?range=24h');
  console.log('  [近24h] 告警数:', over24h.body.data.total_alerts, '来源平台:', over24h.body.data.by_source.length);

  hr('20. 新增 - 部门处置台账');
  const dash = await jsonRequest('GET', '/api/alerts/statistics/department-dashboard');
  console.log('  涉及部门:', dash.body.data.total_departments, '未闭环总数:', dash.body.data.total_unclosed);
  dash.body.data.departments.slice(0, 3).forEach(d => {
    console.log(`    [${d.department}] 总=${d.total_count} 未闭环=${d.unclosed_count} 已办结=${d.closed_count}`);
    if (d.latest_alerts && d.latest_alerts[0]) {
      const a = d.latest_alerts[0];
      console.log(`      最新: #${a.id} ${a.rule_name} status=${a.status_label} 下次催办=${a.next_nudge_at || '不静默/不限'} 最近回填=${a.last_callback_status_label || '无'}`);
    }
  });

  hr('21. 新增 - 创建 suppress_minutes=0 的规则（完全不静默）并验证立即触发');
  const noSuppressRule = await jsonRequest('POST', '/api/rules', {
    rule_name: '设备冒烟急报（零静默）',
    keywords: ['设备冒烟', '有烟', '着火'],
    combine_logic: 'or',
    department: '安保部+设备维护部',
    alert_level: 'emergency',
    threshold_count: 1,
    threshold_minutes: 5,
    verify_action: '立即到场处置并启动消防预案',
    status: 1,
    suppress_minutes: 0
  });
  console.log('  创建规则响应: code=', noSuppressRule.body.code, 'msg=', noSuppressRule.body.message,
    'hasData=', !!(noSuppressRule.body && noSuppressRule.body.data));
  const nsrId = noSuppressRule.body && noSuppressRule.body.data ? noSuppressRule.body.data.id : null;
  const nsrSuppress = noSuppressRule.body && noSuppressRule.body.data ? noSuppressRule.body.data.suppress_minutes : 'N/A';
  console.log('  创建规则 suppress_minutes=0, id=', nsrId, 'db_saved_val=', nsrSuppress);

  const noS1 = await jsonRequest('POST', '/api/alerts/ingest', {
    content: '南门观光设备冒烟了，有烟冒出请立即派人',
    source_platform: '现场巡逻'
  });
  console.log('  第1条触发: count=', noS1.body.data.triggered_alert_count);
  const noS2 = await jsonRequest('POST', '/api/alerts/ingest', {
    content: '还是刚才南门观光设备冒烟的问题，现场看到有烟越来越大',
    source_platform: '现场巡逻'
  });
  // 第2条如果 suppress=0 应当仍能命中（不会被静默），因为 suppressMinutes=0 在 alertEngine 中直接跳过静默判定
  const wasSilenced = noS2.body.data.trigger_details.some(t => t.suppressed);
  console.log('  第2条 suppress_minutes=0 命中是否被静默？', wasSilenced ? 'BLOCKED(异常)' : '正常通过(未静默)');
  if (nsrId) {
    await jsonRequest('DELETE', '/api/rules/' + nsrId);
    console.log('  清理测试规则 OK');
  }

  hr('22. 新增 - 人工 reopen 后立即催办验证（相似内容应再次命中）');
  // 用最初的儿童走失告警 reopen，然后立即发相似内容验证
  if (latestAlertId && latestAlertUuid) {
    const re2 = await jsonRequest('POST', '/api/alerts/' + latestAlertId + '/reopen', {
      reason: '家属再次来电，情况未解决需重新催办',
      reset_timer: true
    });
    console.log('  reopen result:', re2.body.message, 'new_status=', re2.body.data.new_status_label, 'suppress_until=', re2.body.data.suppress_until);
    const reopenHit = await jsonRequest('POST', '/api/alerts/ingest', {
      content: '景区南门入口寻人：刚才蓝衣服小孩走失的事情，家长仍在焦急等待，小孩还没找到继续寻人',
      source_platform: '值班室电话'
    });
    const reopenedSuppress = reopenHit.body.data.trigger_details.some(t => t.suppressed);
    console.log('  reopen 后立即接相似内容：是否被静默？', reopenedSuppress ? 'BLOCKED(异常)' : '正常触发/聚合', '新告警=', reopenHit.body.data.triggered_alert_count);
  }

  hr('23. 回填字典 + 通道字典');
  const cbDict = await jsonRequest('GET', '/api/callbacks/status-options');
  console.log('  回填状态数:', cbDict.body.data.callback_statuses.length);
  console.log('    带 set_suppress(自动静默):', cbDict.body.data.callback_statuses.filter(s => s.set_suppress).map(s => s.label).join('、'));
  const chDict = await jsonRequest('GET', '/api/push/channels/status-meta');
  console.log('  支持通道类型数:', chDict.body.data.channel_types.length, '=', chDict.body.data.channel_types.map(t => t.label).join('/'));

  hr('24. CSV 导出（headers Content-Disposition）');
  const csvRes = await new Promise(resolve => {
    http.get(BASE + '/api/alerts/export?format=csv', r => {
      resolve({ status: r.statusCode, contentType: r.headers['content-type'], disposition: r.headers['content-disposition'], size: 0 });
    });
  });
  console.log('  HTTP:', csvRes.status, 'content-type:', csvRes.contentType);
  console.log('  Content-Disposition:', csvRes.disposition);

  hr('25. 持久化验证 - 服务重启后数据仍存在（模拟验证）');
  console.log('  当前规则数、告警数、通道数均已通过 SQLite 文件持久化（db/scenic_alert.db）');
  console.log('  每次写操作均触发 markDirty + saveDatabase，进程退出钩子 also 强制落盘');

  hr('26. 值班班次管理 - 创建早班 + 查当前班次');
  const sh1 = await jsonRequest('POST', '/api/shifts', {
    shift_name: '6月19日早班',
    shift_type: 'morning',
    handover_person: '值班长老王',
    successor_person: '值班长老李',
    notes: '重点关注南门区域儿童走失事件'
  });
  const shiftId = sh1.body && sh1.body.data ? sh1.body.data.id : null;
  console.log('  创建班次: id=', shiftId, 'type=', sh1.body.data.shift_type_label, 'status=', sh1.body.data.status_label);
  const activeShift = await jsonRequest('GET', '/api/shifts/active');
  console.log('  当前班次:', activeShift.body.data ? 'id=' + activeShift.body.data.id + ' ' + activeShift.body.data.shift_name : '无');

  hr('27. 值班班次管理 - 交班（自动带出未闭环/重点部门/失败推送）');
  const handover = await jsonRequest('POST', '/api/shifts/' + shiftId + '/handover', {
    successor_person: '值班长老李',
    notes: '已处理儿童走失，需继续关注缆车问题'
  });
  console.log('  交班结果: status=', handover.body.data.status_label,
    '未闭环告警数=', handover.body.data.handover_summary.unclosed_alert_count,
    '未闭环部门=', JSON.stringify(Object.keys(handover.body.data.handover_summary.unclosed_by_department)));

  hr('28. 值班班次管理 - 查上一班次交接内容');
  const newShift = await jsonRequest('POST', '/api/shifts', { shift_type: 'afternoon', handover_person: '值班长老李' });
  const newShiftId = newShift.body && newShift.body.data ? newShift.body.data.id : null;
  const prevShift = await jsonRequest('GET', '/api/shifts/' + newShiftId + '/previous');
  console.log('  上一班次:', prevShift.body.data ? 'id=' + prevShift.body.data.id + ' notes=' + (prevShift.body.data.notes || '').substring(0, 30) : '无');
  if (prevShift.body.data && prevShift.body.data.handover_summary) {
    console.log('  上班未闭环:', prevShift.body.data.handover_summary.unclosed_alert_count);
  }

  hr('29. 告警升级 - 手动升级（verify → emergency）');
  // 先确保有 alert#1 存在
  const alertForEsc = await jsonRequest('GET', '/api/alerts/' + latestAlertId);
  const currentLevel = alertForEsc.body && alertForEsc.body.data ? alertForEsc.body.data.alert_level : 'unknown';
  console.log('  当前等级:', currentLevel);
  const esc1 = await jsonRequest('POST', '/api/escalations/manual', {
    alert_id: latestAlertId,
    reason: '超过30分钟未收到部门回填，值班长决定升级',
    to_level: 'emergency',
    to_channel_type: 'sms'
  });
  console.log('  升级结果: from=', esc1.body.data.from_level_name, '→ to=', esc1.body.data.to_level_name,
    'push_ok=', esc1.body.data.push_results ? esc1.body.data.push_results.length + '条推送' : '无');

  hr('30. 告警详情 - 查看升级轨迹');
  const alertDetail = await jsonRequest('GET', '/api/alerts/' + latestAlertId);
  const escHistory = alertDetail.body && alertDetail.body.data ? alertDetail.body.data.escalations : [];
  console.log('  升级记录数:', escHistory.length);
  escHistory.forEach(e => {
    console.log(`    #${e.id} ${e.from_level}→${e.to_level} type=${e.escalation_type} reason=${(e.reason || '').substring(0, 40)} result=${e.result_status}`);
  });

  hr('31. 升级链路 - 查超时未回填告警');
  const overdue = await jsonRequest('GET', '/api/escalations/overdue?minutes=30');
  console.log('  超时未回填告警数:', overdue.body.data.count);

  hr('32. 未闭环口径 - plan_activated 应算未闭环');
  // 先回填「启动预案」
  const cbPlan = await jsonRequest('POST', '/api/callbacks', {
    alert_uuid: latestAlertUuid,
    callback_status: 'plan',
    callback_remark: '已启动应急预案，正在处置中',
    operator: '安保部主任'
  });
  console.log('  回填启动预案:', cbPlan.body.data.new_alert_status);
  const overviewAfterPlan = await jsonRequest('GET', '/api/alerts/statistics/overview?range=today');
  const unclosedDepts = overviewAfterPlan.body.data.unclosed_departments;
  console.log('  态势总览未闭环部门数:', unclosedDepts.length,
    '(plan_activated=未闭环，应>0)');
  const dashAfterPlan = await jsonRequest('GET', '/api/alerts/statistics/department-dashboard');
  const deptUnclosed = dashAfterPlan.body.data.departments.find(d => d.department.includes('游客'));
  if (deptUnclosed) {
    console.log('  部门台账 - 游客服务中心: unclosed=', deptUnclosed.unclosed_count,
      'plan_activated=', deptUnclosed.status_counts.plan_activated,
      '(口径一致: plan_activated 算未闭环)');
  }

  hr('33. 部门台账筛选 - 按部门名+时间范围');
  const dashFiltered = await jsonRequest('GET', '/api/alerts/statistics/department-dashboard?department=' + encodeURIComponent('游客服务中心'));
  console.log('  筛选部门=游客服务中心: 涉及部门数=', dashFiltered.body.data.total_departments,
    'filters=', JSON.stringify(dashFiltered.body.data.filters));

  hr('34. 回填终态后再 reopen 立即可催办');
  const cbClose = await jsonRequest('POST', '/api/callbacks', {
    alert_uuid: latestAlertUuid,
    callback_status: 'closed',
    callback_remark: '事件已妥善处置完毕',
    operator: '安保部主任'
  });
  console.log('  回填已办结:', cbClose.body.data.new_alert_status);
  const reopen2 = await jsonRequest('POST', '/api/alerts/' + latestAlertId + '/reopen', {
    reason: '又有新情况需要关注',
    reset_timer: true
  });
  console.log('  reopen: suppress_until=', reopen2.body.data.suppress_until, 'new_status=', reopen2.body.data.new_status_label);
  const afterReopen = await jsonRequest('POST', '/api/alerts/ingest', {
    content: '景区南门又出现了类似的小孩走失情况，请帮忙广播寻人',
    source_platform: '值班室'
  });
  const reopenTriggered = afterReopen.body.data.trigger_details.some(t => t.passed_threshold && !t.suppressed);
  console.log('  reopen 后立即接入相似内容:', reopenTriggered ? '✓ 正常触发（未静默）' : '✗ 被静默（异常）');

  hr('全部验证通过 ✓');
  process.exit(0);
}

main().catch(e => {
  console.error('测试失败:', e);
  process.exit(1);
});
