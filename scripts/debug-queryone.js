const { initDb, queryOne, getDb } = require('../config/database');

(async () => {
  await initDb();
  const db = getDb();
  console.log('--- 直接 db.exec ---');
  const r1 = db.exec('SELECT name, type FROM sqlite_master');
  console.log(JSON.stringify(r1, null, 2));

  console.log('\n--- 用 queryOne 查 rules 表 ---');
  try {
    const r = queryOne('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=$name', { $name: 'rules' });
    console.log('queryOne 返回:', r, 'typeof:', typeof r, '!!r:', !!r);
  } catch (e) { console.log('queryOne err:', e.message); }

  console.log('\n--- 用 queryAll 查所有表 ---');
  const all = db.exec('SELECT name, type, sql FROM sqlite_master ORDER BY name');
  console.log(JSON.stringify(all));

  // 建一个测试表
  console.log('\n--- 手动建一张 test_tbl ---');
  db.exec('CREATE TABLE test_tbl (id INTEGER PRIMARY KEY, foo TEXT)');
  console.log('建完后 db.exec sqlite_master:');
  const r2 = db.exec('SELECT name FROM sqlite_master WHERE type=\'table\'');
  console.log(JSON.stringify(r2));

  process.exit(0);
})();
