const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'data.db');
let db;

async function initDB() {
  const SQL = await initSqlJs();
  let buffer;
  if (fs.existsSync(DB_PATH)) {
    buffer = fs.readFileSync(DB_PATH);
  }
  db = new SQL.Database(buffer);

  // PDD助力码表
  db.run(`
    CREATE TABLE IF NOT EXISTS pdd_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'available',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_pdd_status ON pdd_codes(status)');

  // 京东链接表
  db.run(`
    CREATE TABLE IF NOT EXISTS jd_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link TEXT NOT NULL UNIQUE,
      title TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'available',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      used_at DATETIME
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_jd_status ON jd_links(status)');

  // 今日热门活动表
  db.run(`
    CREATE TABLE IF NOT EXISTS hot_activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      icon TEXT DEFAULT '🎯',
      description TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // CSRF Token 表
  db.run(`
    CREATE TABLE IF NOT EXISTS csrf_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL
    )
  `);

  saveDB();
  console.log('📦 数据库已初始化');
}

function saveDB() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function getCount(table, status) {
  const stmt = db.prepare(`SELECT COUNT(*) as cnt FROM ${table} WHERE status = ?`);
  stmt.bind([status]);
  let cnt = 0;
  if (stmt.step()) {
    cnt = stmt.getAsObject().cnt;
  }
  stmt.free();
  return cnt;
}

function getAllCodes(table, status) {
  let sql = `SELECT * FROM ${table}`;
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

function getAllHotActivities() {
  const results = [];
  try {
    const stmt = db.prepare('SELECT * FROM hot_activities ORDER BY sort_order DESC, created_at DESC');
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
  } catch(e) {
    console.error('查询热门活动失败:', e.message);
  }
  return results;
}

function addHotActivity(activity) {
  try {
    db.run(
      'INSERT INTO hot_activities (title, url, icon, description, sort_order) VALUES (?, ?, ?, ?, ?)',
      [activity.title, activity.url, activity.icon || '🎯', activity.description || '', activity.sort_order || 0]
    );
    saveDB();
    return true;
  } catch(e) {
    console.error('添加热门活动失败:', e.message);
    return false;
  }
}

let csrfToken = crypto.randomBytes(32).toString('hex');

// CSRF Token
app.get('/api/csrf', (req, res) => {
  csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ token: csrfToken });
});

// 统计
app.get('/api/stats', (req, res) => {
  res.json({
    pdd_available: getCount('pdd_codes', 'available'),
    pdd_used: getCount('pdd_codes', 'used'),
    jd_available: getCount('jd_links', 'available'),
    jd_used: getCount('jd_links', 'used')
  });
});

// ===== PDD 助力码 =====
app.get('/api/pdd/codes', (req, res) => {
  const { status } = req.query;
  const codes = getAllCodes('pdd_codes', status || null);
  res.json(codes);
});

app.post('/api/pdd/codes', (req, res) => {
  const { code } = req.body;
  const clientToken = req.headers['x-csrf-token'];

  if (!clientToken || clientToken !== csrfToken) {
    return res.status(403).json({ error: 'CSRF 验证失败' });
  }

  // 自动识别9位以9开头的数字
  if (!code || !/^\d{9}$/.test(code) || !code.startsWith('9')) {
    return res.status(400).json({ error: '请输入9位数字助力码（以9开头）' });
  }

  const check = db.prepare('SELECT id FROM pdd_codes WHERE code = ?');
  check.bind([code]);
  if (check.step()) {
    check.free();
    return res.status(400).json({ error: '该助力码已存在' });
  }
  check.free();

  db.run('INSERT INTO pdd_codes (code) VALUES (?)', [code]);
  saveDB();
  csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ success: true, token: csrfToken });
});

app.post('/api/pdd/codes/:id/use', (req, res) => {
  const { id } = req.params;
  db.run(
    "UPDATE pdd_codes SET status = 'used', used_at = datetime('now', 'localtime') WHERE id = ? AND status = 'available'",
    [id]
  );
  saveDB();

  const check = db.prepare("SELECT status FROM pdd_codes WHERE id = ?");
  check.bind([id]);
  if (check.step() && check.getAsObject().status === 'used') {
    check.free();
    res.json({ success: true });
  } else {
    check.free();
    res.status(404).json({ error: '助力码不存在或已使用' });
  }
});

// ===== 京东链接 =====
app.get('/api/jd/links', (req, res) => {
  const { status } = req.query;
  const links = getAllCodes('jd_links', status || null);
  res.json(links);
});

app.post('/api/jd/links', (req, res) => {
  const { link, title } = req.body;
  const clientToken = req.headers['x-csrf-token'];

  if (!clientToken || clientToken !== csrfToken) {
    return res.status(403).json({ error: 'CSRF 验证失败' });
  }

  if (!link) {
    return res.status(400).json({ error: '请输入链接' });
  }

  // 支持京东链接和小程序链接
  const isJdLink = link.includes('jd.com') || link.includes('u.jd.com') || 
                   link.includes('#小程序://') || link.includes('openapp.jdmoble');
  
  if (!isJdLink) {
    return res.status(400).json({ error: '请输入京东链接（包含 jd.com 或小程序链接）' });
  }

  const check = db.prepare('SELECT id FROM jd_links WHERE link = ?');
  check.bind([link]);
  if (check.step()) {
    check.free();
    return res.status(400).json({ error: '该链接已存在' });
  }
  check.free();

  db.run('INSERT INTO jd_links (link, title) VALUES (?, ?)', [link, title || '']);
  saveDB();
  csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ success: true, token: csrfToken });
});

app.post('/api/jd/links/:id/use', (req, res) => {
  const { id } = req.params;
  db.run(
    "UPDATE jd_links SET status = 'used', used_at = datetime('now', 'localtime') WHERE id = ? AND status = 'available'",
    [id]
  );
  saveDB();

  const check = db.prepare("SELECT status FROM jd_links WHERE id = ?");
  check.bind([id]);
  if (check.step() && check.getAsObject().status === 'used') {
    check.free();
    res.json({ success: true });
  } else {
    check.free();
    res.status(404).json({ error: '链接不存在或已使用' });
  }
});

// ===== 今日热门活动 =====
app.get('/api/hot', (req, res) => {
  const activities = getAllHotActivities();
  res.json(activities);
});

app.post('/api/hot', (req, res) => {
  const { title, url, icon, description, sort_order } = req.body;
  const success = addHotActivity({ title, url, icon, description, sort_order });
  if (success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: '添加失败' });
  }
});

// 标记已使用
app.post('/api/codes/:id/use', (req, res) => {
  const { id } = req.params;
  db.run(
    "UPDATE codes SET status = 'used', used_at = datetime('now', 'localtime') WHERE id = ? AND status = 'available'",
    [id]
  );
  saveDB();

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
