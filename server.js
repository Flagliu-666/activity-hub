const express = require('express');
const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');
const querystring = require('querystring');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ===== 支付配置（请替换为你的真实配置）=====
const WECHAT_PAY_CONFIG = {
  appid: process.env.WECHAT_APPID || 'YOUR_WECHAT_APPID',
  mch_id: process.env.WECHAT_MCH_ID || 'YOUR_MCH_ID',
  api_key: process.env.WECHAT_API_KEY || 'YOUR_API_KEY',
  notify_url: process.env.WECHAT_NOTIFY_URL || 'https://your-domain.com/api/pay/wechat-notify'
};

const ALIPAY_CONFIG = {
  app_id: process.env.ALIPAY_APPID || 'YOUR_ALIPAY_APPID',
  private_key: process.env.ALIPAY_PRIVATE_KEY || 'YOUR_PRIVATE_KEY',
  alipay_public_key: process.env.ALIPAY_PUBLIC_KEY || 'YOUR_ALIPAY_PUBLIC_KEY',
  notify_url: process.env.ALIPAY_NOTIFY_URL || 'https://your-domain.com/api/pay/alipay-notify'
};

const DB_PATH = path.join(__dirname, 'data.db');
let db;

// ===== 工具函数 =====
function generateOrderId() {
  return 'ORD' + Date.now() + Math.random().toString(36).substr(2, 6);
}

function generateNonceStr() {
  return Math.random().toString(36).substr(2, 32);
}

function sign(params, key) {
  const sorted = Object.keys(params).sort();
  const str = sorted.map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHash('md5').update(str + '&key=' + key).digest('hex').toUpperCase();
}

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

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

  // 用户表（会员系统）
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT UNIQUE,
      session_id TEXT,
      is_vip INTEGER DEFAULT 0,
      vip_expire_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_users_openid ON users(openid)');
  db.run('CREATE INDEX IF NOT EXISTS idx_users_vip ON users(is_vip)');

  // 订单表
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL UNIQUE,
      user_id INTEGER,
      amount INTEGER NOT NULL,
      pay_type TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      pay_time DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_order_id ON orders(order_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');

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

// ===== 用户管理 =====
function getUserBySession(sessionId) {
  try {
    const stmt = db.prepare('SELECT * FROM users WHERE session_id = ?');
    stmt.bind([sessionId]);
    let user = null;
    if (stmt.step()) {
      user = stmt.getAsObject();
    }
    stmt.free();
    return user;
  } catch(e) {
    console.error('查询用户失败:', e.message);
    return null;
  }
}

function getUserByOpenid(openid) {
  try {
    const stmt = db.prepare('SELECT * FROM users WHERE openid = ?');
    stmt.bind([openid]);
    let user = null;
    if (stmt.step()) {
      user = stmt.getAsObject();
    }
    stmt.free();
    return user;
  } catch(e) {
    console.error('查询用户失败:', e.message);
    return null;
  }
}

function createUser(openid, sessionId) {
  try {
    db.run(
      'INSERT INTO users (openid, session_id) VALUES (?, ?)',
      [openid, sessionId]
    );
    saveDB();
    return getUserByOpenid(openid);
  } catch(e) {
    console.error('创建用户失败:', e.message);
    return null;
  }
}

function updateUserVip(userId, isVip, vipExpireAt) {
  try {
    db.run(
      'UPDATE users SET is_vip = ?, vip_expire_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [isVip ? 1 : 0, vipExpireAt, userId]
    );
    saveDB();
    return true;
  } catch(e) {
    console.error('更新用户会员失败:', e.message);
    return false;
  }
}

function isUserVip(user) {
  if (!user) return false;
  if (user.is_vip !== 1) return false;
  if (user.vip_expire_at) {
    const expireDate = new Date(user.vip_expire_at.replace(' ', 'T'));
    if (expireDate < new Date()) {
      return false;
    }
  }
  return true;
}

// ===== 获取或创建用户 =====
function getOrCreateUser(req, res) {
  const sessionId = req.headers['x-session-id'] || crypto.randomBytes(16).toString('hex');
  let user = getUserBySession(sessionId);
  
  if (!user) {
    const openid = sessionId; // 使用 session_id 作为 openid
    user = createUser(openid, sessionId);
  }
  
  return user;
}

let csrfToken = crypto.randomBytes(32).toString('hex');

// CSRF Token
app.get('/api/csrf', (req, res) => {
  csrfToken = crypto.randomBytes(32).toString('hex');
  res.json({ token: csrfToken });
});

// 获取用户信息
app.get('/api/user/info', (req, res) => {
  const sessionId = req.headers['x-session-id'] || req.query.session_id;
  if (!sessionId) {
    return res.status(401).json({ error: '未登录' });
  }
  
  let user = getUserBySession(sessionId);
  if (!user) {
    user = createUser(sessionId, sessionId);
  }
  
  res.json({
    id: user.id,
    is_vip: isUserVip(user),
    vip_expire_at: user.vip_expire_at
  });
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

// ===== 支付相关 =====
// 创建订单
app.post('/api/pay/create-order', (req, res) => {
  const { pay_type, description } = req.body; // pay_type: 'wechat' or 'alipay'
  
  if (!pay_type || !['wechat', 'alipay'].includes(pay_type)) {
    return res.status(400).json({ error: '不支持的支付方式' });
  }

  const sessionId = req.headers['x-session-id'] || req.query.session_id;
  const user = getUserBySession(sessionId);
  
  if (!user) {
    return res.status(401).json({ error: '请先登录' });
  }

  const amount = 100; // 1元 = 100分
  const order_id = generateOrderId();
  const nonce_str = generateNonceStr();
  const body = description || '会员充值';

  try {
    // 创建订单记录
    db.run(
      'INSERT INTO orders (order_id, user_id, amount, pay_type, status) VALUES (?, ?, ?, ?, ?)',
      [order_id, user.id, amount, pay_type, 'pending']
    );
    saveDB();

    if (pay_type === 'wechat') {
      // 微信支付
      const params = {
        appid: WECHAT_PAY_CONFIG.appid,
        mch_id: WECHAT_PAY_CONFIG.mch_id,
        nonce_str: nonce_str,
        body: body,
        out_trade_no: order_id,
        total_fee: amount,
        spbill_create_ip: '127.0.0.1',
        notify_url: WECHAT_PAY_CONFIG.notify_url,
        trade_type: 'NATIVE' // 扫码支付
      };
      
      const sign_str = sign(params, WECHAT_PAY_CONFIG.api_key);
      params.sign = sign_str;

      // 这里应该调用微信支付 API，简化版直接返回
      res.json({
        success: true,
        order_id: order_id,
        pay_url: `weixin://wxpay/bizpay.htm?sr=xxxxx`, // 实际应返回微信支付二维码链接
        config: WECHAT_PAY_CONFIG
      });
    } else if (pay_type === 'alipay') {
      // 支付宝支付
      const params = {
        app_id: ALIPAY_CONFIG.app_id,
        method: 'Alipay.Trade.Pre.Create',
        charset: 'utf-8',
        sign_type: 'RSA2',
        timestamp: new Date().toISOString(),
        version: '1.0',
        notify_url: ALIPAY_CONFIG.notify_url,
        biz_content: JSON.stringify({
          subject: body,
          out_trade_no: order_id,
          total_amount: (amount / 100).toFixed(2),
          product_code: 'FAST_INSTANT_TRADE_PAY'
        })
      };

      const sign = md5(JSON.stringify(params) + ALIPAY_CONFIG.private_key);
      params.sign = sign;

      res.json({
        success: true,
        order_id: order_id,
        pay_url: `https://openapi.alipay.com/gateway.do?${querystring.stringify(params)}`,
        config: ALIPAY_CONFIG
      });
    }
  } catch(e) {
    console.error('创建订单失败:', e);
    res.status(500).json({ error: '创建订单失败' });
  }
});

// 微信支付回调
app.post('/api/pay/wechat-notify', (req, res) => {
  const data = req.body;
  
  // 验证签名
  const sign = data.sign;
  delete data.sign;
  const verified_sign = sign(data, WECHAT_PAY_CONFIG.api_key);
  
  if (sign !== verified_sign) {
    return res.status(400).send('签名失败');
  }

  if (data.result_code === 'SUCCESS') {
    const order_id = data.out_trade_no;
    
    // 更新订单状态
    db.run(
      "UPDATE orders SET status = 'paid', pay_time = datetime('now', 'localtime') WHERE order_id = ? AND status = 'pending'",
      [order_id]
    );
    
    // 获取订单用户
    const stmt = db.prepare('SELECT user_id FROM orders WHERE order_id = ?');
    stmt.bind([order_id]);
    let order = null;
    if (stmt.step()) {
      order = stmt.getAsObject();
    }
    stmt.free();
    
    if (order) {
      // 开通会员（1年）
      const vip_expire_at = new Date();
      vip_expire_at.setFullYear(vip_expire_at.getFullYear() + 1);
      const vip_expire_str = vip_expire_at.toISOString().split('.')[0];
      
      updateUserVip(order.user_id, true, vip_expire_str);
      
      console.log(`用户 ${order.user_id} 支付成功，已开通会员`);
    }
    
    res.xml('<xml><return_code><![CDATA[SUCCESS]]></return_code><return_msg><![CDATA[成功]]></return_msg></xml>');
  }
});

// 支付宝支付回调
app.post('/api/pay/alipay-notify', (req, res) => {
  const data = req.body;
  
  // 验证签名
  const sign = data.sign;
  const verified_sign = md5(querystring.stringify(data) + ALIPAY_CONFIG.private_key);
  
  if (sign !== verified_sign) {
    return res.status(400).send('签名失败');
  }

  if (data.trade_status === 'TRADE_SUCCESS') {
    const order_id = data.out_trade_no;
    
    // 更新订单状态
    db.run(
      "UPDATE orders SET status = 'paid', pay_time = datetime('now', 'localtime') WHERE order_id = ? AND status = 'pending'",
      [order_id]
    );
    
    // 获取订单用户
    const stmt = db.prepare('SELECT user_id FROM orders WHERE order_id = ?');
    stmt.bind([order_id]);
    let order = null;
    if (stmt.step()) {
      order = stmt.getAsObject();
    }
    stmt.free();
    
    if (order) {
      // 开通会员（1年）
      const vip_expire_at = new Date();
      vip_expire_at.setFullYear(vip_expire_at.getFullYear() + 1);
      const vip_expire_str = vip_expire_at.toISOString().split('.')[0];
      
      updateUserVip(order.user_id, true, vip_expire_str);
      
      console.log(`用户 ${order.user_id} 支付成功，已开通会员`);
    }
    
    res.send('success');
  }
});

// 查询订单状态
app.get('/api/pay/order/:order_id', (req, res) => {
  const { order_id } = req.params;
  
  try {
    const stmt = db.prepare('SELECT * FROM orders WHERE order_id = ?');
    stmt.bind([order_id]);
    let order = null;
    if (stmt.step()) {
      order = stmt.getAsObject();
    }
    stmt.free();
    
    if (order) {
      res.json({
        success: true,
        order: {
          order_id: order.order_id,
          amount: order.amount,
          pay_type: order.pay_type,
          status: order.status,
          pay_time: order.pay_time
        }
      });
    } else {
      res.status(404).json({ error: '订单不存在' });
    }
  } catch(e) {
    res.status(500).json({ error: '查询失败' });
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
    console.log('   - 会员页面: http://' + localIP + ':' + PORT + '/vip.html\n');
    console.log('   📱 请确保手机和电脑连接同一个WiFi/网络\n');
  });
}).catch(err => {
  console.error('数据库初始化失败:', err);
  process.exit(1);
});
