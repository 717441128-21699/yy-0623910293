const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const { initDb, saveDatabase } = require('./config/database');

const rulesRouter = require('./routes/rules');
const alertsRouter = require('./routes/alerts');
const callbacksRouter = require('./routes/callbacks');

async function createApp() {
  const dbDir = path.join(__dirname, 'db');
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  await initDb();
  const { getDb, saveDatabase, queryOne } = require('./config/database');
  {
    const db = getDb();
    const tblCheck = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='rules'`);
    const rulesExists = tblCheck && tblCheck[0] && tblCheck[0].values && tblCheck[0].values.length > 0;

    if (!rulesExists) {
      console.log('[app] 检测到数据库为空，正在初始化表结构...');
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
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
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
          first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (rule_id) REFERENCES rules(id)
        );
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
        CREATE TABLE IF NOT EXISTS raw_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          source_platform TEXT,
          suspected_location TEXT,
          received_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      try {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);
          CREATE INDEX IF NOT EXISTS idx_alerts_level ON alerts(alert_level);
          CREATE INDEX IF NOT EXISTS idx_alerts_department ON alerts(department);
          CREATE INDEX IF NOT EXISTS idx_callbacks_alert_uuid ON callbacks(alert_uuid);
          CREATE INDEX IF NOT EXISTS idx_raw_messages_time ON raw_messages(received_at);
        `);
      } catch (e) { /* index skip */ }

      const seedRules = [
        { n:'踩踏风险预警', kw:JSON.stringify(['踩踏','拥挤','人太多','挤不动','排队过长']), dept:'安保部', lv:'emergency', tc:5, tm:5, va:'立即派员前往现场核实客流密度，必要时分流疏导' },
        { n:'缆车停运投诉', kw:JSON.stringify(['缆车停了','缆车坏了','索道故障','缆车不动','索道停运']), dept:'索道运营部', lv:'verify', tc:3, tm:15, va:'联系索道控制室确认运行状态，安抚滞留游客' },
        { n:'儿童走失求助', kw:JSON.stringify(['孩子丢了','小孩走失','找不到孩子','孩子不见了','寻人']), dept:'游客服务中心', lv:'verify', tc:1, tm:30, va:'通过广播播报寻人信息，调阅附近监控录像' },
        { n:'退票聚集舆情', kw:JSON.stringify(['退票','退款','不想玩了','没意思','不值','欺骗']), dept:'票务部+客服中心', lv:'notice', tc:8, tm:20, va:'核实售票窗口排队情况，准备客服话术预案' },
        { n:'设施安全投诉', kw:JSON.stringify(['坏了','故障','受伤','流血','摔倒','不安全']), dept:'设备维护部', lv:'verify', tc:2, tm:10, va:'停止相关设施运营，派安全员到场检查，联系医务室' }
      ];
      for (const r of seedRules) {
        const stmt = db.prepare(`INSERT INTO rules (rule_name,keywords,department,alert_level,threshold_count,threshold_minutes,verify_action) VALUES ($n,$kw,$dept,$lv,$tc,$tm,$va)`);
        stmt.run({ $n:r.n, $kw:r.kw, $dept:r.dept, $lv:r.lv, $tc:r.tc, $tm:r.tm, $va:r.va });
        stmt.free();
      }
      saveDatabase();
      console.log('[app] 表结构与5条初始规则初始化完成');
    }
  }

  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(cors());
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

  app.use((req, res, next) => {
    const t = new Date().toISOString();
    console.log(`[${t}] ${req.method} ${req.originalUrl} - ${req.ip || 'unknown'}`);
    next();
  });

  app.get('/', (req, res) => {
    res.json({
      name: '景区应急联动中心 - 后端告警服务',
      version: '1.0.0',
      status: 'running',
      modules: [
        { name: '规则管理', prefix: '/api/rules' },
        { name: '告警记录与分级推送', prefix: '/api/alerts' },
        { name: '告警闭环回填', prefix: '/api/callbacks' }
      ],
      docs: '/api/callbacks/status-options'
    });
  });

  app.get('/health', (req, res) => {
    res.json({ code: 0, status: 'ok', timestamp: new Date().toISOString() });
  });

  app.use('/api/rules', rulesRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/callbacks', callbacksRouter);

  app.use((err, req, res, next) => {
    console.error('[Unhandled Error]', err);
    res.status(500).json({ code: 500, message: err.message || '服务器内部错误' });
  });

  app.use((req, res) => {
    res.status(404).json({ code: 404, message: '接口不存在', path: req.originalUrl });
  });

  const server = app.listen(PORT, () => {
    console.log(`\n=============================================`);
    console.log(`  景区应急联动告警服务已启动`);
    console.log(`  服务地址: http://localhost:${PORT}`);
    console.log(`  健康检查: http://localhost:${PORT}/health`);
    console.log(`  规则管理: http://localhost:${PORT}/api/rules`);
    console.log(`  告警记录: http://localhost:${PORT}/api/alerts`);
    console.log(`  回填字典: http://localhost:${PORT}/api/callbacks/status-options`);
    console.log(`=============================================\n`);
  });

  const gracefulShutdown = (signal) => {
    console.log(`\n[${signal}] 正在关闭服务...`);
    saveDatabase();
    server.close(() => {
      console.log('服务已关闭');
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000);
  };

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  return { app, server, PORT };
}

if (require.main === module) {
  createApp().catch(err => {
    console.error('服务启动失败:', err);
    process.exit(1);
  });
}

module.exports = createApp;
