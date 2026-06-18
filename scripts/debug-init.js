// 测试数据库初始化
const { initDb, tableExists, getDb, saveDatabase, closeDb } = require('../config/database');

(async () => {
  try {
    console.log('Step 1: initDb...');
    await initDb();
    console.log('Step 2: tableExists("rules")?');
    const has = tableExists('rules');
    console.log('  rules table exists:', has);

    const db = getDb();
    console.log('Step 3: show sqlite_master tables...');
    const rows = db.exec(`SELECT name FROM sqlite_master WHERE type='table'`);
    console.log('  result rows:', JSON.stringify(rows));
  } catch (e) {
    console.error('err:', e);
  }
  process.exit(0);
})();
