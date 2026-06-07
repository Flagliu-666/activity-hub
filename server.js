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

  // 商品表（关联用户）
  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      category TEXT NOT NULL DEFAULT '百货',
      price REAL NOT NULL DEFAULT 0,
      images TEXT DEFAULT '[]',
      contact TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'available',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_products_user ON products(user_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)');
  db.run('CREATE INDEX IF NOT EXISTS idx_products_status ON products(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_products_created ON products(created_at DESC)');

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

  // 管理员会话表
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      admin_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      FOREIGN KEY (admin_id) REFERENCES admins(id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_admin_sessions_session ON admin_sessions(session_id)');

  // 用户表（学号+密码登录）
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id TEXT NOT NULL UNIQUE,
      name TEXT DEFAULT '',
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_users_student_id ON users(student_id)');

  // 广告位表
  db.run(`
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      link_url TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status)');
  db.run('CREATE INDEX IF NOT EXISTS idx_ads_sort ON ads(sort_order DESC)');

  // 创建默认主管理员
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

// ===== 管理员认证 =====
function hashPassword(password) {
  return crypto.createHash('md5').update(password).digest('hex');
}

// 用户认证中间件
function verifyUser(req, res, next) {
  const userId = req.headers['x-user-id'];
  
  if (!userId) {
    return res.status(401).json({ error: '请先登录' });
  }
  
  try {
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    stmt.bind([parseInt(userId)]);
    let user = null;
    if (stmt.step()) {
      user = stmt.getAsObject();
    }
    stmt.free();
    
    if (!user) {
      return res.status(401).json({ error: '用户不存在' });
    }
    
    req.user = user;
    next();
  } catch(e) {
    res.status(500).json({ error: '服务器错误' });
  }
}

// 用户或管理员认证
function verifyUserOrAdmin(req, res, next) {
  // 先检查是否是管理员
  const sessionId = req.headers['x-admin-session'];
  if (sessionId) {
    return verifyAdmin(req, res, function(adminNextReq) {
      adminNextReq.isAdmin = true;
      return next(adminNextReq);
    });
  }
  
  // 再检查是否是用户
  return verifyUser(req, res, next);
}

function verifyAdmin(req, res, next) {
  const sessionId = req.headers['x-admin-session'] || req.query.admin_session;
  
  if (!sessionId) {
    return res.status(401).json({ error: '未登录' });
  }
  
  try {
    const sessionStmt = db.prepare('SELECT admin_id FROM admin_sessions WHERE session_id = ? AND expires_at > datetime("now")');
    sessionStmt.bind([sessionId]);
    let session = null;
    if (sessionStmt.step()) {
      session = sessionStmt.getAsObject();
    }
    sessionStmt.free();
    
    if (!session) {
      return res.status(401).json({ error: '登录已过期' });
    }
    
    const adminStmt = db.prepare('SELECT * FROM admins WHERE id = ?');
    adminStmt.bind([session.admin_id]);
    let admin = null;
    if (adminStmt.step()) {
      admin = adminStmt.getAsObject();
    }
    adminStmt.free();
    
    if (!admin) {
      return res.status(401).json({ error: '管理员不存在' });
    }
    
    req.admin = admin;
    next();
  } catch(e) {
    res.status(500).json({ error: '服务器错误' });
  }
}

// ===== 商品接口 =====
// 获取所有商品
app.get('/api/products', (req, res) => {
  const { category, status } = req.query;
  let sql = 'SELECT p.*, u.student_id as publisher_student_id FROM products p LEFT JOIN users u ON p.user_id = u.id WHERE 1=1';
  let params = [];
  
  if (category && category !== 'all') {
    sql += ' AND p.category = ?';
    params.push(category);
  }
  
  if (status) {
    sql += ' AND p.status = ?';
    params.push(status);
  }
  
  sql += ' ORDER BY p.created_at DESC';
  
  const results = [];
  try {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
  } catch(e) {
    console.error('查询商品失败:', e.message);
  }
  
  res.json(results);
});

// 添加商品（需要登录）
app.post('/api/products', (req, res) => {
  const { user_id, title, description, category, price, images, contact } = req.body;
  
  if (!user_id) {
    return res.status(401).json({ error: '请先登录' });
  }
  
  if (!title || !contact) {
    return res.status(400).json({ error: '请填写标题和联系方式' });
  }
  
  try {
    const imagesJson = JSON.stringify(images || []);
    db.run(
      'INSERT INTO products (user_id, title, description, category, price, images, contact) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [user_id, title, description || '', category || '百货', price || 0, imagesJson, contact]
    );
    saveDB();
    res.json({ success: true });
  } catch(e) {
    console.error('添加商品失败:', e.message);
    res.status(500).json({ error: '添加失败' });
  }
});

// 更新商品状态（仅创建者可操作，管理员除外）
app.put('/api/products/:id/status', verifyUserOrAdmin, (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  
  if (!['available', 'sold'].includes(status)) {
    return res.status(400).json({ error: '无效的状态' });
  }
  
  try {
    // 检查是否是创建者或管理员
    const stmt = db.prepare('SELECT user_id FROM products WHERE id = ?');
    stmt.bind([id]);
    let product = null;
    if (stmt.step()) {
      product = stmt.getAsObject();
    }
    stmt.free();
    
    if (!product) {
      return res.status(404).json({ error: '商品不存在' });
    }
    
    // 如果是管理员，允许修改
    if (req.isAdmin) {
      db.run('UPDATE products SET status = ? WHERE id = ?', [status, id]);
      saveDB();
      return res.json({ success: true });
    }
    
    // 只有创建者可以修改
    if (product.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权修改此商品' });
    }
    
    db.run('UPDATE products SET status = ? WHERE id = ?', [status, id]);
    saveDB();
    res.json({ success: true });
  } catch(e) {
    console.error('更新状态失败:', e.message);
    res.status(500).json({ error: '更新失败' });
  }
});

// 更新商品（仅创建者或管理员）
app.put('/api/products/:id', verifyUserOrAdmin, (req, res) => {
  const { id } = req.params;
  const { title, description, category, price, images, contact } = req.body;
  
  try {
    const stmt = db.prepare('SELECT user_id FROM products WHERE id = ?');
    stmt.bind([id]);
    let product = null;
    if (stmt.step()) {
      product = stmt.getAsObject();
    }
    stmt.free();
    
    if (!product) {
      return res.status(404).json({ error: '商品不存在' });
    }
    
    if (!req.isAdmin && product.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权修改此商品' });
    }
    
    const imagesJson = JSON.stringify(images || []);
    db.run(
      'UPDATE products SET title = ?, description = ?, category = ?, price = ?, images = ?, contact = ? WHERE id = ?',
      [title, description || '', category || '百货', price || 0, imagesJson, contact, id]
    );
    saveDB();
    res.json({ success: true });
  } catch(e) {
    console.error('更新商品失败:', e.message);
    res.status(500).json({ error: '更新失败' });
  }
});

// 删除商品（仅创建者或管理员）
app.delete('/api/products/:id', verifyUserOrAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    const stmt = db.prepare('SELECT user_id FROM products WHERE id = ?');
    stmt.bind([id]);
    let product = null;
    if (stmt.step()) {
      product = stmt.getAsObject();
    }
    stmt.free();
    
    if (!product) {
      return res.status(404).json({ error: '商品不存在' });
    }
    
    if (!req.isAdmin && product.user_id !== req.user.id) {
      return res.status(403).json({ error: '无权删除此商品' });
    }
    
    db.run('DELETE FROM products WHERE id = ?', [id]);
    saveDB();
    res.json({ success: true });
  } catch(e) {
    console.error('删除商品失败:', e.message);
    res.status(500).json({ error: '删除失败' });
  }
});

// 获取我的商品（仅查看自己的）
app.get('/api/my-products', verifyUser, (req, res) => {
  const results = [];
  try {
    const stmt = db.prepare('SELECT * FROM products WHERE user_id = ? ORDER BY created_at DESC');
    stmt.bind([req.user.id]);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
  } catch(e) {
    console.error('查询我的商品失败:', e.message);
  }
  res.json(results);
});

// ===== 广告位接口 =====
// 获取所有广告
app.get('/api/ads', (req, res) => {
  const results = [];
  try {
    const stmt = db.prepare('SELECT * FROM ads WHERE status = ? ORDER BY sort_order DESC');
    stmt.bind(['active']);
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
  } catch(e) {
    console.error('查询广告失败:', e.message);
  }
  res.json(results);
});

// 添加广告（仅管理员）
app.post('/api/admin/ads', verifyAdmin, (req, res) => {
  const { title, description, image_url, link_url, sort_order } = req.body;
  
  try {
    db.run(
      'INSERT INTO ads (title, description, image_url, link_url, sort_order) VALUES (?, ?, ?, ?, ?)',
      [title, description || '', image_url || '', link_url || '', sort_order || 0]
    );
    saveDB();
    res.json({ success: true });
  } catch(e) {
    console.error('添加广告失败:', e.message);
    res.status(500).json({ error: '添加失败' });
  }
});

// 删除广告（仅管理员）
app.delete('/api/admin/ads/:id', verifyAdmin, (req, res) => {
  const { id } = req.params;
  
  try {
    db.run('DELETE FROM ads WHERE id = ?', [id]);
    saveDB();
    res.json({ success: true });
  } catch(e) {
    console.error('删除广告失败:', e.message);
    res.status(500).json({ error: '删除失败' });
  }
});

// ===== 用户接口（学号+密码登录）=====
// 用户注册
app.post('/api/user/register', (req, res) => {
  const { student_id, name, password } = req.body;
  
  if (!student_id || !password) {
    return res.status(400).json({ error: '请输入学号和密码' });
  }
  
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少需要 6 位' });
  }
  
  const passwordHash = hashPassword(password);
  
  try {
    db.run(
      'INSERT INTO users (student_id, name, password) VALUES (?, ?, ?)',
      [student_id, name || '', passwordHash]
    );
    saveDB();
    res.json({ success: true });
  } catch(e) {
    if (e.message.includes('UNIQUE')) {
      res.status(400).json({ error: '该学号已注册' });
    } else {
      res.status(500).json({ error: '注册失败' });
    }
  }
});

// 用户登录
app.post('/api/user/login', (req, res) => {
  const { student_id, password } = req.body;
  
  if (!student_id || !password) {
    return res.status(400).json({ error: '请输入学号和密码' });
  }
  
  const passwordHash = hashPassword(password);
  
  try {
    const stmt = db.prepare('SELECT * FROM users WHERE student_id = ? AND password = ?');
    stmt.bind([student_id, passwordHash]);
    let user = null;
    if (stmt.step()) {
      user = stmt.getAsObject();
    }
    stmt.free();
    
    if (!user) {
      return res.status(401).json({ error: '学号或密码错误' });
    }
    
    res.json({
      success: true,
      user: {
        id: user.id,
        student_id: user.student_id,
        name: user.name
      }
    });
  } catch(e) {
    console.error('登录失败:', e);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ===== 管理员接口 =====
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
    
    const sessionId = crypto.randomBytes(32).toString('hex');
    db.run(
      'INSERT INTO admin_sessions (session_id, admin_id, expires_at) VALUES (?, ?, datetime("now", "+1 year"))',
      [sessionId, admin.id]
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

app.post('/api/admin/change-password', verifyAdmin, (req, res) => {
  const { current_password, new_password } = req.body;
  
  if (!current_password || !new_password) {
    return res.status(400).json({ error: '请填写当前密码和新密码' });
  }
  
  if (new_password.length < 6) {
    return res.status(400).json({ error: '新密码至少需要 6 位' });
  }
  
  const passwordHash = hashPassword(current_password);
  try {
    const stmt = db.prepare('SELECT id FROM admins WHERE id = ? AND password = ?');
    stmt.bind([req.admin.id, passwordHash]);
    let exists = false;
    if (stmt.step()) {
      exists = true;
    }
    stmt.free();
    
    if (!exists) {
      return res.status(401).json({ error: '当前密码错误' });
    }
    
    const newHash = hashPassword(new_password);
    db.run('UPDATE admins SET password = ? WHERE id = ?', [newHash, req.admin.id]);
    saveDB();
    
    res.json({ success: true });
  } catch(e) {
    console.error('修改密码失败:', e);
    res.status(500).json({ error: '修改失败' });
  }
});

app.post('/api/admin/logout', verifyAdmin, (req, res) => {
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
    console.log('\n✅ 二手闲置平台已启动');
    console.log('   - 本机访问: http://localhost:' + PORT);
    console.log('   - 手机访问: http://' + localIP + ':' + PORT);
    console.log('   - 管理后台: http://' + localIP + ':' + PORT + '/admin.html\n');
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
