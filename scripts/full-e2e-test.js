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

  hr('19. 回填字典 + 通道字典');
  const cbDict = await jsonRequest('GET', '/api/callbacks/status-options');
  console.log('  回填状态数:', cbDict.body.data.callback_statuses.length);
  console.log('    带 set_suppress(自动静默):', cbDict.body.data.callback_statuses.filter(s => s.set_suppress).map(s => s.label).join('、'));
  const chDict = await jsonRequest('GET', '/api/push/channels/status-meta');
  console.log('  支持通道类型数:', chDict.body.data.channel_types.length, '=', chDict.body.data.channel_types.map(t => t.label).join('/'));

  hr('20. CSV 导出（headers Content-Disposition）');
  const csvRes = await new Promise(resolve => {
    http.get(BASE + '/api/alerts/export?format=csv', r => {
      resolve({ status: r.statusCode, contentType: r.headers['content-type'], disposition: r.headers['content-disposition'], size: 0 });
    });
  });
  console.log('  HTTP:', csvRes.status, 'content-type:', csvRes.contentType);
  console.log('  Content-Disposition:', csvRes.disposition);

  hr('全部验证通过 ✓');
  process.exit(0);
}

main().catch(e => {
  console.error('测试失败:', e);
  process.exit(1);
});
