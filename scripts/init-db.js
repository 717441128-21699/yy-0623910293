const { initDb, getDb, saveDatabase, closeDb, queryOne } = require('../config/database');

async function initDatabase() {
  await initDb();
  const db = getDb();

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
  } catch (e) {
    console.log('index create note:', e.message);
  }

  const row = queryOne('SELECT COUNT(*) as count FROM rules');
  const count = row ? row.count : 0;

  if (count === 0) {
    const seedRules = [
      {
        rule_name: '踩踏风险预警',
        keywords: JSON.stringify(['踩踏', '拥挤', '人太多', '挤不动', '排队过长']),
        combine_logic: 'or',
        department: '安保部',
        alert_level: 'emergency',
        threshold_count: 5,
        threshold_minutes: 5,
        verify_action: '立即派员前往现场核实客流密度，必要时分流疏导',
        status: 1
      },
      {
        rule_name: '缆车停运投诉',
        keywords: JSON.stringify(['缆车停了', '缆车坏了', '索道故障', '缆车不动', '索道停运']),
        combine_logic: 'or',
        department: '索道运营部',
        alert_level: 'verify',
        threshold_count: 3,
        threshold_minutes: 15,
        verify_action: '联系索道控制室确认运行状态，安抚滞留游客',
        status: 1
      },
      {
        rule_name: '儿童走失求助',
        keywords: JSON.stringify(['孩子丢了', '小孩走失', '找不到孩子', '孩子不见了', '寻人']),
        combine_logic: 'or',
        department: '游客服务中心',
        alert_level: 'verify',
        threshold_count: 1,
        threshold_minutes: 30,
        verify_action: '通过广播播报寻人信息，调阅附近监控录像',
        status: 1
      },
      {
        rule_name: '退票聚集舆情',
        keywords: JSON.stringify(['退票', '退款', '不想玩了', '没意思', '不值', '欺骗']),
        combine_logic: 'or',
        department: '票务部+客服中心',
        alert_level: 'notice',
        threshold_count: 8,
        threshold_minutes: 20,
        verify_action: '核实售票窗口排队情况，准备客服话术预案',
        status: 1
      },
      {
        rule_name: '设施安全投诉',
        keywords: JSON.stringify(['坏了', '故障', '受伤', '流血', '摔倒', '不安全']),
        combine_logic: 'or',
        department: '设备维护部',
        alert_level: 'verify',
        threshold_count: 2,
        threshold_minutes: 10,
        verify_action: '停止相关设施运营，派安全员到场检查，联系医务室',
        status: 1
      }
    ];

    for (const rule of seedRules) {
      const stmt = db.prepare(`
        INSERT INTO rules (rule_name, keywords, combine_logic, department, alert_level, threshold_count, threshold_minutes, verify_action, status)
        VALUES ($rule_name, $keywords, $combine_logic, $department, $alert_level, $threshold_count, $threshold_minutes, $verify_action, $status)
      `);
      stmt.run({
        $rule_name: rule.rule_name,
        $keywords: rule.keywords,
        $combine_logic: rule.combine_logic,
        $department: rule.department,
        $alert_level: rule.alert_level,
        $threshold_count: rule.threshold_count,
        $threshold_minutes: rule.threshold_minutes,
        $verify_action: rule.verify_action,
        $status: rule.status
      });
      stmt.free();
    }
    console.log(`已插入 ${seedRules.length} 条初始规则数据`);
    saveDatabase();
  }

  console.log('数据库初始化完成');
  closeDb();
}

initDatabase().catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
