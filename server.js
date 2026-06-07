const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = path.join(__dirname, 'data.db');
let db;

// ===== 数据库初始化 =====
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

  // 管理员表
  db.run(`
    CREATE TABLE IF NOT EXISTS admins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_admins_role ON admins(role)');

  // 创建默认主管理员（用户名：admin，密码：admin123）
  try {
    const defaultPassword = crypto.createHash('md5').update('admin123').digest('hex');
    db.run(
      'INSERT OR IGNORE INTO admins (username, password, role) VALUES (?, ?, ?)',
      ['admin', defaultPassword, 'master']
    );
    console.log('✅ 默认管理员已创建（用户名：admin，密码：admin123）');
  } catch(e) {
    // 如果已存在则忽略
  }

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

function updateHotActivity(id, activity) {
  try {
    db.run(
      'UPDATE hot_activities SET title = ?, url = ?, icon = ?, description = ?, sort_order = ? WHERE id = ?',
      [activity.title, activity.url, activity.icon || '🎯', activity.description || '', activity.sort_order || 0, id]
    );
    saveDB();
    return true;
  } catch(e) {
    console.error('更新热门活动失败:', e.message);
    return false;
  }
}

function deleteHotActivity(id) {
  try {
    db.run('DELETE FROM hot_activities WHERE id = ?', [id]);
    saveDB();
    return true;
  } catch(e) {
    console.error('删除热门活动失败:', e.message);
    return false;
  }
}

// ===== 管理员认证 =====
function hashPassword(password) {
  return crypto.createHash('md5').update(password).digest('hex');
}

function verifyAdmin(req, res, next) {
  const sessionId = req.headers['x-admin-session'] || req.query.admin_session;
  
  if (!sessionId) {
    return res.status(401).json({ error: '未登录' });
  }
  
  try {
    const stmt = db.prepare('SELECT * FROM admins WHERE id = ?');
    stmt.bind([sessionId]);
    let admin = null;
    if (stmt.step()) {
      admin = stmt.getAsObject();
    }
    stmt.free();
    
    if (!admin) {
      return res.status(401).json({ error: '登录已过期' });
    }
    
    req.admin = admin;
    next();
  } catch(e) {
    res.status(500).json({ error: '服务器错误' });
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

// ===== 管理员接口 =====
// 管理员登录
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  
  const passwordHash = hashPassword(password);
  
  try {
    const stmt = db.prepare('SELECT * FROM admins WHERE username = ? AND password = ?');
    stmt.bind([username, passwordHash]);
    let admin = null;
    if (stmt.step()) {
      admin = stmt.getAsObject();
    }
    stmt.free();
    
    if (!admin) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    
    // 生成会话 ID
    const sessionId = crypto.randomBytes(32).toString('hex');
    
    // 将会话存储到数据库
    db.run(
      'INSERT INTO csrf_tokens (token, expires_at) VALUES (?, datetime("now", "+1 year"))',
      [sessionId]
    );
    saveDB();
    
    res.json({
      success: true,
      session_id: sessionId,
      admin: {
        id: admin.id,
        username: admin.username,
        role: admin.role
      }
    });
  } catch(e) {
    console.error('登录失败:', e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// 获取管理员信息
app.get('/api/admin/info', verifyAdmin, (req, res) => {
  res.json({
    success: true,
    admin: {
      id: req.admin.id,
      username: req.admin.username,
      role: req.admin.role
    }
  });
});

// 获取所有管理员列表
app.get('/api/admins', verifyAdmin, (req, res) => {
  try {
    const results = [];
    const stmt = db.prepare('SELECT id, username, role, created_at FROM admins ORDER BY id');
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    res.json(results);
  } catch(e) {
    res.status(500).json({ error: '查询失败' });
  }
});

// 添加管理员（仅主管理员可操作）
app.post('/api/admins', verifyAdmin, (req, res) => {
  if (req.admin.role !== 'master') {
    return res.status(403).json({ error: '只有主管理员可以添加管理员' });
  }
  
  const { username, password, role } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: '请输入用户名和密码' });
  }
  
  if (!['admin', 'sub_admin'].includes(role)) {
    return res.status(400).json({ error: '角色无效' });
  }
  
  const passwordHash = hashPassword(password);
  
  try {
    db.run(
      'INSERT INTO admins (username, password, role) VALUES (?, ?, ?)',
      [username, passwordHash, role]
    );
    saveDB();
    res.json({ success: true });
  } catch(e) {
    if (e.message.includes('UNIQUE')) {
      res.status(400).json({ error: '用户名已存在' });
    } else {
      res.status(500).json({ error: '添加失败' });
    }
  }
});

// 删除管理员（仅主管理员可操作）
app.delete('/api/admins/:id', verifyAdmin, (req, res) => {
  if (req.admin.role !== 'master') {
    return res.status(403).json({ error: '只有主管理员可以删除管理员' });
  }
  
  const adminId = req.params.id;
  
  // 不能删除自己
  if (parseInt(adminId) === req.admin.id) {
    return res.status(400).json({ error: '不能删除自己的账号' });
  }
  
  try {
    db.run('DELETE FROM admins WHERE id = ?', [adminId]);
    saveDB();
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: '删除失败' });
  }
});

// 管理员：添加热门活动
app.post('/api/admin/hot', verifyAdmin, (req, res) => {
  const { title, url, icon, description, sort_order } = req.body;
  const success = addHotActivity({ title, url, icon, description, sort_order });
  if (success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: '添加失败' });
  }
});

// 管理员：更新热门活动
app.put('/api/admin/hot/:id', verifyAdmin, (req, res) => {
  const { id } = req.params;
  const { title, url, icon, description, sort_order } = req.body;
  const success = updateHotActivity(id, { title, url, icon, description, sort_order });
  if (success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: '更新失败' });
  }
});

// 管理员：删除热门活动
app.delete('/api/admin/hot/:id', verifyAdmin, (req, res) => {
  const { id } = req.params;
  const success = deleteHotActivity(id);
  if (success) {
    res.json({ success: true });
  } else {
    res.status(500).json({ error: '删除失败' });
  }
});

// 管理员：添加 PDD 助力码
app.post('/api/admin/pdd', verifyAdmin, (req, res) => {
  const { code } = req.body;
  
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
  res.json({ success: true });
});

// 管理员：删除 PDD 助力码
app.delete('/api/admin/pdd/:id', verifyAdmin, (req, res) => {
  const { id } = req.params;
  try {
    db.run('DELETE FROM pdd_codes WHERE id = ?', [id]);
    saveDB();
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: '删除失败' });
  }
});

// 管理员：添加京东链接
app.post('/api/admin/jd', verifyAdmin, (req, res) => {
  const { link, title } = req.body;
  
  if (!link) {
    return res.status(400).json({ error: '请输入链接' });
  }
  
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
  res.json({ success: true });
});

// 管理员：删除京东链接
app.delete('/api/admin/jd/:id', verifyAdmin, (req, res) => {
  const { id } = req.params;
  try {
    db.run('DELETE FROM jd_links WHERE id = ?', [id]);
    saveDB();
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: '删除失败' });
  }
});

// 管理员：退出登录
app.post('/api/admin/logout', verifyAdmin, (req, res) => {
  // 这里可以清理事件会话，简化处理不删除
  res.json({ success: true });
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
    console.log('   - 管理后台: http://' + localIP + ':' + PORT + '/admin.html\n');
    console.log('   📱 请确保手机和电脑连接同一个WiFi/网络\n');
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
