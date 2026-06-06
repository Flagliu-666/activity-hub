export default {
  fetch: async (request, env) => {
    const url = new URL(request.url);
    
    // CORS
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // 路由
    if (url.pathname === '/api/csrf' && request.method === 'GET') {
      const token = crypto.randomUUID();
      await env.DB.run('INSERT INTO csrf_tokens (token, expires_at) VALUES (?, datetime("now", "+1 hour"))', [token]);
      return new Response(JSON.stringify({ token }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/stats' && request.method === 'GET') {
      const available = await env.DB.prepare('SELECT COUNT(*) as count FROM codes WHERE status = "available"').first();
      const used = await env.DB.prepare('SELECT COUNT(*) as count FROM codes WHERE status = "used"').first();
      return new Response(JSON.stringify({ available: available.count, used: used.count }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/codes' && request.method === 'GET') {
      const status = url.searchParams.get('status');
      let query;
      if (status === 'available') {
        query = await env.DB.prepare('SELECT * FROM codes WHERE status = "available" ORDER BY created_at DESC');
      } else if (status === 'used') {
        query = await env.DB.prepare('SELECT * FROM codes WHERE status = "used" ORDER BY used_at DESC');
      } else {
        query = await env.DB.prepare('SELECT * FROM codes ORDER BY created_at DESC');
      }
      const codes = await query.all();
      return new Response(JSON.stringify(codes.rows), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/api/codes' && request.method === 'POST') {
      const clientToken = request.headers.get('X-CSRF-Token');
      const validToken = await env.DB.prepare('SELECT token FROM csrf_tokens WHERE token = ? AND expires_at > datetime("now")').first();
      
      if (!clientToken || !validToken) {
        return new Response(JSON.stringify({ error: 'CSRF 验证失败' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      }

      const body = await request.json();
      const { code } = body;
      
      if (!code || !/^\d{9}$/.test(code)) {
        return new Response(JSON.stringify({ error: '请输入9位数字邀请码' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      const existing = await env.DB.prepare('SELECT id FROM codes WHERE code = ?').first(code);
      if (existing) {
        return new Response(JSON.stringify({ error: '该邀请码已存在' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      }

      await env.DB.run('INSERT INTO codes (code) VALUES (?)', [code]);
      const newToken = crypto.randomUUID();
      await env.DB.run('INSERT INTO csrf_tokens (token, expires_at) VALUES (?, datetime("now", "+1 hour"))', [newToken]);
      
      return new Response(JSON.stringify({ success: true, token: newToken }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname.match(/^\/api\/codes\/\d+\/use$/) && request.method === 'POST') {
      const id = url.pathname.split('/')[3];
      await env.DB.run('UPDATE codes SET status = "used", used_at = datetime("now") WHERE id = ? AND status = "available"', [id]);
      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('API Not Found', { status: 404 });
  },
};
