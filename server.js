const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'data.db');

// ===== 数据库初始化 =====
let db;

async function initDB() {
  const SQL = await initSqlJs();
  let buffer;
  if (fs.existsSync(DB_PATH)) {
    buffer = fs.readFileSync(DB_PATH);
  }
  db = new SQL.Database(buffer);

  db.run(`
    CREATE TABLE IF NOT EXISTS codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'available',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_codes_status ON codes(status)');

  // 种子数据
  const seedCodes = [
    '873512409', '216984735', '590327148', '448209651', '735126890',
    '129850376', '654389012', '982103467', '301974528', '567230194'
  ];
  const insert = db.prepare('INSERT OR IGNORE INTO codes (code) VALUES (?)');
  seedCodes.forEach(c => { insert.run([c]); insert.reset(); });
  insert.free();

  saveDB();
  console.log('📦 数据库已初始化，现有', getCount('available'), '个可用邀请码');
}

function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function getCount(status) {
  const stmt = db.prepare('SELECT COUNT(*) as cnt FROM codes WHERE status = ?');
  stmt.bind([status]);
  let cnt = 0;
  if (stmt.step()) {
    cnt = stmt.getAsObject().cnt;
  }
  stmt.free();
  return cnt;
}

function getAllCodes(status) {
  let sql = 'SELECT * FROM codes';
  let params = [];
  if (status === 'available') {
    sql += ' WHERE status = ? ORDER BY created_at DESC';
    params = ['available'];
  } else if (status === 'used') {
    sql += ' WHERE status = ? ORDER BY used_at DESC';
    params = ['used'];
  } else {
    sql += ' ORDER BY created_at DESC';
  }

  const results = [];
  try {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
  } catch(e) {
    console.error('查询失败:', e.message);
  }
  return results;
}

// ===== CSRF Token 管理 =====
let csrfToken = crypto.randomBytes(32).toString('hex');

// ===== API 路由 =====

// CSRF Token
app.get('/api/csrf', (req, res) => {
  csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ token: csrfToken });
});

// 统计
app.get('/api/stats', (req, res) => {
  res.json({
    available: getCount('available'),
    used: getCount('used')
  });
});

// 获取邀请码列表
app.get('/api/codes', (req, res) => {
  const { status } = req.query;
  const codes = getAllCodes(status || null);
  res.json(codes);
});

// 提交邀请码
app.post('/api/codes', (req, res) => {
  const { code } = req.body;
  const clientToken = req.headers['x-csrf-token'];

  if (!clientToken || clientToken !== csrfToken) {
    return res.status(403).json({ error: 'CSRF 验证失败，请刷新页面' });
  }

  if (!code || !/^\d{9}$/.test(code)) {
    return res.status(400).json({ error: '请输入9位数字邀请码' });
  }

  // 检查重复
  const check = db.prepare('SELECT id FROM codes WHERE code = ?');
  check.bind([code]);
  if (check.step()) {
    check.free();
    return res.status(400).json({ error: '该邀请码已存在' });
  }
  check.free();

  db.run('INSERT INTO codes (code) VALUES (?)', [code]);
  saveDB();

  csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ success: true, token: csrfToken });
});

// 标记已使用
app.post('/api/codes/:id/use', (req, res) => {
  const { id } = req.params;
  db.run(
    "UPDATE codes SET status = 'used', used_at = datetime('now', 'localtime') WHERE id = ? AND status = 'available'",
    [id]
  );
  saveDB();

  // 检查是否更新成功
  const check = db.prepare("SELECT status FROM codes WHERE id = ?");
  check.bind([id]);
  if (check.step() && check.getAsObject().status === 'used') {
    check.free();
    res.json({ success: true });
  } else {
    check.free();
    res.status(404).json({ error: '邀请码不存在或已使用' });
  }
});

// ===== 启动 =====
const PORT = process.env.PORT || 3000;

initDB().then(() => {
  const os = require('os');
  const getLocalIP = () => {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) return net.address;
      }
    }
    return 'localhost';
  };
  const localIP = getLocalIP();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅ 活动互助站已启动`);
    console.log('   - 本机访问: http://localhost:' + PORT);
    console.log('   - 手机访问: http://' + localIP + ':' + PORT);
    console.log('   - 首页: http://' + localIP + ':' + PORT + '/');
    console.log('   - PDD互助: http://' + localIP + ':' + PORT + '/pdd.html\n');
    console.log('   📱 请确保手机和电脑连接同一个WiFi/网络\n');
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
