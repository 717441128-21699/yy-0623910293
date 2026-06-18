const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const rulesRouter = require('./routes/rules');
const alertsRouter = require('./routes/alerts');
const callbacksRouter = require('./routes/callbacks');
const pushRouter = require('./routes/push');

async function createApp() {
  const dbDir = path.join(__dirname, 'db');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  const { initDb, saveDatabase, getDb, queryOne, execRun, addColumnIfMissing, tableExists } = require('./config/database');
  await initDb();

  const db = getDb();
  const rulesExists = tableExists('rules');

  if (!rulesExists) {
    console.log('[app] 数据库为空，初始化表结构...');
    db.exec(`
      CREATE TABLE IF NOT EXISTS rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_name TEXT NOT NULL,
        keywords TEXT NOT NULL,
        combine_logic TEXT DEFAULT 'or',
        department TEXT NOT NULL,
        alert_level TEXT NOT NULL DEFAULT 'notice',
        threshold_count INTEGER DEFAULT 3,
        threshold_minutes INTEGER DEFAULT 10,
        verify_action TEXT,
        status INTEGER DEFAULT 1,
        suppress_minutes INTEGER DEFAULT 60,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_uuid TEXT UNIQUE NOT NULL,
        rule_id INTEGER,
        matched_keywords TEXT,
        content_summary TEXT NOT NULL,
        source_platform TEXT,
        suspected_location TEXT,
        alert_level TEXT NOT NULL,
        matched_count INTEGER DEFAULT 1,
        department TEXT NOT NULL,
        verify_action TEXT,
        status TEXT DEFAULT 'pending',
        suppress_until DATETIME,
        reopen_count INTEGER DEFAULT 0,
        last_notified_at DATETIME,
        first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (rule_id) REFERENCES rules(id)
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS callbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id INTEGER NOT NULL,
        alert_uuid TEXT NOT NULL,
        callback_status TEXT NOT NULL,
        callback_remark TEXT,
        operator TEXT,
        callback_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (alert_id) REFERENCES alerts(id)
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS raw_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        content TEXT NOT NULL,
        source_platform TEXT,
        sender TEXT,
        meta_json TEXT,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel_name TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        applicable_levels TEXT,
        target_url TEXT NOT NULL,
        auth_headers TEXT,
        payload_template TEXT,
        enabled INTEGER DEFAULT 1,
        priority INTEGER DEFAULT 0,
        retry_times INTEGER DEFAULT 3,
        retry_interval_seconds INTEGER DEFAULT 60,
        remark TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS push_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_id INTEGER,
        alert_uuid TEXT,
        channel_id INTEGER NOT NULL,
        channel_name TEXT,
        channel_type TEXT,
        request_payload TEXT,
        response_body TEXT,
        http_status INTEGER,
        status TEXT DEFAULT 'pending',
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        next_retry_at DATETIME,
        pushed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (alert_id) REFERENCES alerts(id),
        FOREIGN KEY (channel_id) REFERENCES push_channels(id)
      );
    `);
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
        CREATE INDEX IF NOT EXISTS idx_alerts_level ON alerts(alert_level);
        CREATE INDEX IF NOT EXISTS idx_alerts_department ON alerts(department);
        CREATE INDEX IF NOT EXISTS idx_alerts_suppress ON alerts(suppress_until);
        CREATE INDEX IF NOT EXISTS idx_callbacks_alert_uuid ON callbacks(alert_uuid);
        CREATE INDEX IF NOT EXISTS idx_raw_messages_time ON raw_messages(received_at);
        CREATE INDEX IF NOT EXISTS idx_push_logs_alert ON push_logs(alert_id);
        CREATE INDEX IF NOT EXISTS idx_push_logs_status ON push_logs(status, next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_push_channels_enabled ON push_channels(enabled);
      `);
    } catch (e) { /* idx skip */ }

    const seedRules = [
      { n:'踩踏风险预警', kw:JSON.stringify(['踩踏','拥挤','人太多','挤不动','排队过长']), cl:'or', dept:'安保部', lv:'emergency', tc:5, tm:5, va:'立即派员前往现场核实客流密度，必要时分流疏导', sm:30 },
      { n:'缆车停运投诉', kw:JSON.stringify(['缆车停了','缆车坏了','索道故障','缆车不动','索道停运']), cl:'or', dept:'索道运营部', lv:'verify', tc:3, tm:15, va:'联系索道控制室确认运行状态，安抚滞留游客', sm:120 },
      { n:'儿童走失求助', kw:JSON.stringify(['孩子丢了','小孩走失','找不到孩子','孩子不见了','寻人']), cl:'or', dept:'游客服务中心', lv:'verify', tc:1, tm:30, va:'通过广播播报寻人信息，调阅附近监控录像', sm:90 },
      { n:'退票聚集舆情', kw:JSON.stringify(['退票','退款','不想玩了','没意思','不值','欺骗']), cl:'or', dept:'票务部+客服中心', lv:'notice', tc:8, tm:20, va:'核实售票窗口排队情况，准备客服话术预案', sm:60 },
      { n:'设施安全投诉', kw:JSON.stringify(['坏了','故障','受伤','流血','摔倒','不安全']), cl:'or', dept:'设备维护部', lv:'verify', tc:2, tm:10, va:'停止相关设施运营，派安全员到场检查，联系医务室', sm:120 }
    ];
    for (const r of seedRules) {
      execRun(`INSERT INTO rules (rule_name,keywords,combine_logic,department,alert_level,threshold_count,threshold_minutes,verify_action,suppress_minutes)
        VALUES ($n,$kw,$cl,$dept,$lv,$tc,$tm,$va,$sm)`,
        { $n:r.n, $kw:r.kw, $cl:r.cl, $dept:r.dept, $lv:r.lv, $tc:r.tc, $tm:r.tm, $va:r.va, $sm:r.sm });
    }

    const seedChannels = [
      {
        name: '值班群-值班班长群', type: 'wecom',
        levels: JSON.stringify(['notice','verify','emergency']),
        url: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=REPLACE_WITH_WORK_WECHAT_KEY',
        headers: null, tpl: null,
        priority: 10, retry: 3, retry_sec: 60,
        remark: '默认值班群，接收全部等级告警，生产环境请修改 webhook key'
      },
      {
        name: '紧急处置-分管领导短信', type: 'sms',
        levels: JSON.stringify(['emergency']),
        url: 'https://sms-api.example.com/send?auth=REPLACE_WITH_SMS_TOKEN',
        headers: null,
        tpl: JSON.stringify({ template: '{level}告警-{rule_name}-{location}-{content}-建议{action}' }),
        priority: 50, retry: 5, retry_sec: 120,
        remark: '仅紧急处置告警触发，需替换为真实短信服务商 API'
      },
      {
        name: '景区广播系统', type: 'broadcast',
        levels: JSON.stringify(['verify','emergency']),
        url: 'http://broadcast.local.intra/notice/push',
        headers: JSON.stringify({ Authorization: 'Bearer REPLACE_BROADCAST_TOKEN' }),
        tpl: JSON.stringify({ field: 'text', zone: 'whole_park' }),
        priority: 30, retry: 3, retry_sec: 30,
        remark: '内部广播系统，默认推送全园区，生产环境改内网地址+令牌'
      },
      {
        name: '对接联动中心平台', type: 'webhook',
        levels: JSON.stringify(['notice','verify','emergency']),
        url: 'https://linkage-center.example.com/webhook/alerts',
        headers: JSON.stringify({ 'X-Client-Id': 'scenic-alerts', 'X-Client-Secret': 'REPLACE_SECRET' }),
        tpl: null,
        priority: 0, retry: 2, retry_sec: 180,
        remark: '联动中心总平台对接，POST JSON 结构化 payload'
      }
    ];
    for (const ch of seedChannels) {
      execRun(`INSERT INTO push_channels (channel_name,channel_type,applicable_levels,target_url,auth_headers,payload_template,enabled,priority,retry_times,retry_interval_seconds,remark)
        VALUES ($name,$type,$levels,$url,$headers,$tpl,1,$priority,$retry,$retry_sec,$remark)`,
        {
          $name: ch.name, $type: ch.type, $levels: ch.levels,
          $url: ch.url, $headers: ch.headers, $tpl: ch.tpl,
          $priority: ch.priority, $retry: ch.retry, $retry_sec: ch.retry_sec, $remark: ch.remark
        });
    }

    saveDatabase();
    console.log('[app] 初始化完成：5 表 + 5 规则 + 4 示例推送通道');
  } else {
    addColumnIfMissing('rules', 'suppress_minutes', 'INTEGER DEFAULT 60');
    addColumnIfMissing('alerts', 'suppress_until', 'DATETIME');
    addColumnIfMissing('alerts', 'reopen_count', 'INTEGER DEFAULT 0');
    addColumnIfMissing('alerts', 'last_notified_at', 'DATETIME');
    addColumnIfMissing('raw_messages', 'sender', 'TEXT');
    addColumnIfMissing('raw_messages', 'meta_json', 'TEXT');
    if (!tableExists('push_channels')) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS push_channels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          channel_name TEXT NOT NULL,
          channel_type TEXT NOT NULL,
          applicable_levels TEXT,
          target_url TEXT NOT NULL,
          auth_headers TEXT,
          payload_template TEXT,
          enabled INTEGER DEFAULT 1,
          priority INTEGER DEFAULT 0,
          retry_times INTEGER DEFAULT 3,
          retry_interval_seconds INTEGER DEFAULT 60,
          remark TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS push_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          alert_id INTEGER,
          alert_uuid TEXT,
          channel_id INTEGER NOT NULL,
          channel_name TEXT,
          channel_type TEXT,
          request_payload TEXT,
          response_body TEXT,
          http_status INTEGER,
          status TEXT DEFAULT 'pending',
          error_message TEXT,
          retry_count INTEGER DEFAULT 0,
          next_retry_at DATETIME,
          pushed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (alert_id) REFERENCES alerts(id),
          FOREIGN KEY (channel_id) REFERENCES push_channels(id)
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_push_logs_alert ON push_logs(alert_id);
        CREATE INDEX IF NOT EXISTS idx_push_logs_status ON push_logs(status, next_retry_at);
        CREATE INDEX IF NOT EXISTS idx_push_channels_enabled ON push_channels(enabled);
      `);
      console.log('[app] 已为旧数据库补齐 push_channels / push_logs 表');
    }
  }

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

  app.use((req, res, next) => {
    const t = new Date().toLocaleString();
    const qs = Object.keys(req.query || {}).length > 0 ? '?' + new URLSearchParams(req.query).toString() : '';
    console.log(`[${t}] ${req.method} ${req.originalUrl || (req.path + qs)}`);
    next();
  });

  app.get('/', (req, res) => {
    res.json({
      name: '景区应急联动中心 - 后端告警服务',
      version: '1.1.0',
      status: 'running',
      modules: [
        { name: '风险规则管理', prefix: '/api/rules', desc: '含静默窗口 suppress_minutes 配置' },
        { name: '告警记录与接入', prefix: '/api/alerts', desc: '支持试运行 dry-run + 多维筛选/导出 + 重新打开' },
        { name: '告警闭环回填', prefix: '/api/callbacks', desc: '7 种回填状态，自动写静默避免重复催办' },
        { name: '推送通道管理', prefix: '/api/push', desc: '6 类通道 + 推送日志 + 失败手动重推 + 通道连通性测试' }
      ],
      docs: [
        '状态字典: GET /api/callbacks/status-options',
        '通道字典: GET /api/push/channels/status-meta',
        '试运行: POST /api/alerts/dry-run { content }',
        '告警导出 JSON: GET /api/alerts/export?format=json',
        '告警导出 CSV:  GET /api/alerts/export?format=csv'
      ]
    });
  });

  app.get('/health', (req, res) => {
    res.json({ code: 0, status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/rules', rulesRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/callbacks', callbacksRouter);
  app.use('/api/push', pushRouter);

  app.use((err, req, res, next) => {
    console.error('[Unhandled Error]', err && err.stack ? err.stack : err);
    res.status(500).json({ code: 500, message: err.message || '服务器内部错误' });
  });

  app.use((req, res) => {
    res.status(404).json({ code: 404, message: '接口不存在', path: req.originalUrl });
  });

  const { runRetryDaemon } = require('./middleware/pushDispatcher');
  const retryTimer = setInterval(async () => {
    try {
      const r = await runRetryDaemon();
      if (r.length > 0) {
        console.log('[retry-daemon] 自动重试推送结果:', r);
      }
    } catch (e) {
      console.error('[retry-daemon] 异常:', e.message);
    }
  }, 30 * 1000);

  const server = app.listen(PORT, () => {
    console.log(`\n===============================================`);
    console.log(`  景区应急联动告警服务 v1.1.0 已启动`);
    console.log(`  服务地址: http://localhost:${PORT}`);
    console.log(`  健康检查: http://localhost:${PORT}/health`);
    console.log(`  规则管理: http://localhost:${PORT}/api/rules`);
    console.log(`  告警记录: http://localhost:${PORT}/api/alerts`);
    console.log(`  试运行 : POST http://localhost:${PORT}/api/alerts/dry-run`);
    console.log(`  告警导出: GET  http://localhost:${PORT}/api/alerts/export?format=csv`);
    console.log(`  通道管理: http://localhost:${PORT}/api/push/channels`);
    console.log(`  回填字典: http://localhost:${PORT}/api/callbacks/status-options`);
    console.log(`  重试守护: 每 30 秒扫描推送失败日志自动重推`);
    console.log(`===============================================\n`);
  });

  const gracefulShutdown = (signal) => {
    console.log(`\n[${signal}] 正在关闭服务...`);
    clearInterval(retryTimer);
    try { saveDatabase(); } catch (e) {}
    server.close(() => {
      console.log('服务已关闭');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('beforeExit', () => { try { saveDatabase(); } catch(e){} });

  return { app, server, PORT };
}

if (require.main === module) {
  createApp().catch(err => {
    console.error('服务启动失败:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = createApp;
