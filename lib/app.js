import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getSettings, getSetting, setSetting, pickupSlots, DEFAULT_SETTINGS, envSetting } from './db.js';
import { hashPassword, verifyPassword, signToken, readToken, parseCookies, cookieHeader } from './auth.js';
import { verifyIdToken } from './line.js';
import * as svc from './service.js';
import { HttpError, assert, toInt, isDateStr, taipeiNow, addDays, randomToken, escapeHtml, money } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const STAFF_SESSION_SEC = 12 * 3600;
const CUSTOMER_SESSION_SEC = 180 * 24 * 3600;

/* ───────────── 小工具 ───────────── */

function send(res, status, body, headers = {}) {
  const isText = Buffer.isBuffer(body) || typeof body === 'string';
  res.writeHead(status, {
    'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

async function readJson(req, limit = 6 * 1024 * 1024) {
  // Vercel 可能已先解析好 body
  if (req.body !== undefined && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body ?? {};
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new HttpError(413, '資料太大');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '資料格式錯誤');
  }
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon',
};

function serveStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return false;
  let stat;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': stat.size, 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

/* ───────────── 應用程式 ───────────── */

/**
 * 建立 HTTP 請求處理函式。dbReady 為 openDb() 回傳的 Promise，或回傳該 Promise 的函式（失敗時下次請求會重試）。
 * 本機由 server.js 使用，雲端由 api/index.js 使用。
 */
export function createApp(dbReady) {
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, handler });
  };

  let db;
  const secret = () => getSetting(db, 'session_secret');

  async function baseUrl(req) {
    const configured = (await getSetting(db, 'public_base_url')).replace(/\/+$/, '');
    if (configured) return configured;
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  }

  async function currentUser(req) {
    const p = readToken(await secret(), parseCookies(req.headers.cookie).sid);
    if (!p?.uid) return null;
    const u = await db.one('SELECT id, username, name, role, active FROM users WHERE id = ?', [p.uid]);
    return u?.active ? u : null;
  }

  async function requireUser(req, role) {
    const u = await currentUser(req);
    assert(u, 401, '請先登入');
    if (role === 'owner') assert(u.role === 'owner', 403, '只有店主可以執行這個操作');
    return u;
  }

  async function requireCustomer(req) {
    const p = readToken(await secret(), parseCookies(req.headers.cookie).cid);
    const c = p?.cid ? await db.one('SELECT * FROM customers WHERE id = ?', [p.cid]) : null;
    assert(c, 401, '請重新從 LINE 開啟訂購頁');
    return c;
  }

  // 登入失敗次數限制（每個 IP 10 分鐘內 10 次；雲端為每台機器各自計算）
  const loginFails = new Map();
  function checkLoginRate(ip) {
    const rec = loginFails.get(ip);
    if (rec && Date.now() - rec.first > 10 * 60 * 1000) loginFails.delete(ip);
    assert((loginFails.get(ip)?.n || 0) < 10, 429, '登入失敗次數過多，請 10 分鐘後再試');
  }
  function noteLoginFail(ip) {
    const rec = loginFails.get(ip) || { n: 0, first: Date.now() };
    rec.n += 1;
    loginFails.set(ip, rec);
  }

  const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS).filter((k) => k !== 'last_reminder_date');
  async function maskedSettings() {
    const s = await getSettings(db);
    const out = {};
    for (const k of SETTING_KEYS) out[k] = s[k] ?? '';
    out.line_channel_token = s.line_channel_token ? `••••${s.line_channel_token.slice(-4)}` : '';
    out.last_reminder_date = s.last_reminder_date;
    out.env_locked = SETTING_KEYS.filter((k) => envSetting(k));
    out.cron_configured = !!process.env.CRON_SECRET;
    out.hosting = process.env.VERCEL ? 'vercel' : 'server';
    return out;
  }

  /* ── 登入 ── */
  route('POST', '/api/login', async (req, res) => {
    const ip = clientIp(req);
    checkLoginRate(ip);
    const { username, password } = await readJson(req);
    const u = await db.one('SELECT * FROM users WHERE username = ? AND active = 1', [String(username || '').trim()]);
    if (!u || !verifyPassword(password || '', u.pw_hash)) {
      noteLoginFail(ip);
      throw new HttpError(401, '帳號或密碼錯誤');
    }
    loginFails.delete(ip);
    const token = signToken(await secret(), { uid: u.id, exp: Date.now() + STAFF_SESSION_SEC * 1000 });
    send(res, 200, { id: u.id, name: u.name, role: u.role }, { 'Set-Cookie': cookieHeader('sid', token, STAFF_SESSION_SEC, req) });
  });
  route('POST', '/api/logout', async (req, res) => {
    send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('sid', '', 0, req) });
  });
  route('GET', '/api/me', async (req, res) => {
    const u = await requireUser(req);
    send(res, 200, { ...u, store_name: await getSetting(db, 'store_name') });
  });

  /* ── 商品與照片 ── */
  route('GET', '/api/products', async (req, res) => {
    await requireUser(req);
    send(res, 200, await svc.listProducts(db));
  });
  route('POST', '/api/products', async (req, res) => {
    await requireUser(req, 'owner');
    send(res, 201, await svc.createProduct(db, await readJson(req)));
  });
  route('PUT', '/api/products/:id', async (req, res, p) => {
    await requireUser(req, 'owner');
    send(res, 200, await svc.updateProduct(db, toInt(p.id), await readJson(req)));
  });
  route('DELETE', '/api/products/:id', async (req, res, p) => {
    await requireUser(req, 'owner');
    await svc.deleteProduct(db, toInt(p.id));
    send(res, 200, { ok: true });
  });
  route('POST', '/api/upload', async (req, res) => {
    await requireUser(req, 'owner');
    const { data } = await readJson(req);
    const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ''));
    assert(m, 400, '只接受 JPG、PNG、WebP 圖片');
    assert(m[2].length <= 2 * 1024 * 1024, 413, '圖片太大，請換一張');
    // 照片存進資料庫（images 資料表），雲端主機不需另外的檔案空間
    const id = `${randomToken(12)}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    await db.run('INSERT INTO images (id, mime, data, created_at) VALUES (?, ?, ?, ?)', [id, `image/${m[1]}`, m[2], taipeiNow().datetime]);
    send(res, 201, { path: `/uploads/${id}` });
  });

  /* ── 結帳與交易 ── */
  route('POST', '/api/transactions', async (req, res) => {
    const u = await requireUser(req);
    send(res, 201, await svc.checkout(db, u, await readJson(req), await baseUrl(req)));
  });
  route('GET', '/api/transactions/:id', async (req, res, p) => {
    await requireUser(req);
    const t = await svc.getTransaction(db, toInt(p.id));
    assert(t, 404, '找不到交易');
    send(res, 200, t);
  });
  route('POST', '/api/transactions/:id/void', async (req, res, p) => {
    const u = await requireUser(req, 'owner');
    const { reason } = await readJson(req);
    send(res, 200, await svc.voidTransaction(db, u, toInt(p.id), reason));
  });

  /* ── 訂單 ── */
  route('GET', '/api/orders', async (req, res, p, url) => {
    await requireUser(req);
    const date = url.searchParams.get('date') || taipeiNow().date;
    assert(isDateStr(date), 400, '日期格式不正確');
    const status = url.searchParams.get('status') || '';
    send(res, 200, { date, orders: await svc.listOrders(db, { date, status }), counts: await svc.orderCounts(db, date) });
  });
  route('GET', '/api/orders/counts', async (req, res, p, url) => {
    await requireUser(req);
    const date = url.searchParams.get('date') || taipeiNow().date;
    assert(isDateStr(date), 400, '日期格式不正確');
    send(res, 200, await svc.orderCounts(db, date));
  });
  route('GET', '/api/orders/:id', async (req, res, p) => {
    await requireUser(req);
    const o = await svc.getOrder(db, toInt(p.id));
    assert(o, 404, '找不到訂單');
    send(res, 200, o);
  });
  route('POST', '/api/orders/:id/confirm', async (req, res, p) => {
    await requireUser(req);
    send(res, 200, await svc.confirmOrder(db, toInt(p.id)));
  });
  route('POST', '/api/orders/:id/cancel', async (req, res, p) => {
    await requireUser(req);
    const { reason } = await readJson(req);
    send(res, 200, await svc.cancelOrder(db, toInt(p.id), reason));
  });
  route('PUT', '/api/orders/:id', async (req, res, p) => {
    await requireUser(req);
    send(res, 200, await svc.updateOrder(db, toInt(p.id), await readJson(req)));
  });

  /* ── 報表 ── */
  route('GET', '/api/reports/daily', async (req, res, p, url) => {
    await requireUser(req);
    send(res, 200, await svc.dailyReport(db, url.searchParams.get('date') || taipeiNow().date));
  });
  route('GET', '/api/reports/daily.csv', async (req, res, p, url) => {
    await requireUser(req);
    const report = await svc.dailyReport(db, url.searchParams.get('date') || taipeiNow().date);
    send(res, 200, svc.reportCsv(report), {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sales-${report.date}.csv"`,
    });
  });

  /* ── 設定與帳號（店主） ── */
  route('GET', '/api/settings', async (req, res) => {
    await requireUser(req, 'owner');
    send(res, 200, await maskedSettings());
  });
  route('PUT', '/api/settings', async (req, res) => {
    await requireUser(req, 'owner');
    const body = await readJson(req);
    for (const k of SETTING_KEYS) {
      if (body[k] === undefined || envSetting(k)) continue;
      const v = String(body[k]).trim();
      if (k === 'line_channel_token' && v.startsWith('••••')) continue;
      if (k === 'reminder_time') assert(/^([01]\d|2[0-3]):[0-5]\d$/.test(v), 400, '提醒時間格式需為 HH:MM');
      if (k === 'max_advance_days') assert(toInt(v) >= 0 && toInt(v) <= 60, 400, '可預訂天數需為 0–60');
      if (k === 'pickup_slots') assert(v.split('\n').some((x) => x.trim()), 400, '至少需要一個取貨時段');
      if (k === 'store_name') assert(v.length >= 1, 400, '請填寫店名');
      if (k === 'line_notify_received') assert(v === '0' || v === '1', 400, '設定值不正確');
      if (k === 'public_base_url') assert(!v || /^https?:\/\/[^\s]+$/.test(v), 400, '網址需以 http:// 或 https:// 開頭');
      if (k === 'reminder_time' && v !== await getSetting(db, 'reminder_time')) await setSetting(db, 'last_reminder_date', '');
      await setSetting(db, k, v);
    }
    send(res, 200, await maskedSettings());
  });
  route('GET', '/api/users', async (req, res) => {
    await requireUser(req, 'owner');
    send(res, 200, await db.all('SELECT id, username, name, role, active, created_at FROM users ORDER BY id'));
  });
  route('POST', '/api/users', async (req, res) => {
    await requireUser(req, 'owner');
    const b = await readJson(req);
    const username = String(b.username || '').trim();
    const name = String(b.name || '').trim();
    assert(/^[A-Za-z0-9_.-]{3,30}$/.test(username), 400, '帳號需為 3–30 個英數字');
    assert(name.length >= 1 && name.length <= 20, 400, '請填寫姓名');
    assert(['owner', 'staff'].includes(b.role), 400, '角色不正確');
    assert(String(b.password || '').length >= 6, 400, '密碼至少 6 碼');
    assert(!(await db.one('SELECT 1 AS x FROM users WHERE username = ?', [username])), 409, '帳號已存在');
    await db.run('INSERT INTO users (username, name, role, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)',
      [username, name, b.role, hashPassword(String(b.password)), taipeiNow().datetime]);
    send(res, 201, { ok: true });
  });
  route('PUT', '/api/users/:id', async (req, res, p) => {
    const me = await requireUser(req, 'owner');
    const id = toInt(p.id);
    assert(await db.one('SELECT id FROM users WHERE id = ?', [id]), 404, '找不到帳號');
    const b = await readJson(req);
    if (id === me.id) {
      assert(b.role === undefined || b.role === 'owner', 400, '不能移除自己的店主權限');
      assert(b.active === undefined || b.active, 400, '不能停用自己的帳號');
    }
    if (b.name !== undefined) {
      const name = String(b.name).trim();
      assert(name.length >= 1 && name.length <= 20, 400, '請填寫姓名');
      await db.run('UPDATE users SET name = ? WHERE id = ?', [name, id]);
    }
    if (b.role !== undefined) {
      assert(['owner', 'staff'].includes(b.role), 400, '角色不正確');
      await db.run('UPDATE users SET role = ? WHERE id = ?', [b.role, id]);
    }
    if (b.active !== undefined) await db.run('UPDATE users SET active = ? WHERE id = ?', [b.active ? 1 : 0, id]);
    if (b.password) {
      assert(String(b.password).length >= 6, 400, '密碼至少 6 碼');
      await db.run('UPDATE users SET pw_hash = ? WHERE id = ?', [hashPassword(String(b.password)), id]);
    }
    send(res, 200, { ok: true });
  });
  route('GET', '/api/line-messages', async (req, res) => {
    await requireUser(req, 'owner');
    send(res, 200, await db.all(`SELECT m.*, o.code AS order_code, c.name AS customer_name FROM line_messages m
                                 LEFT JOIN orders o ON o.id = m.order_id LEFT JOIN customers c ON c.id = m.customer_id
                                 ORDER BY m.id DESC LIMIT 200`));
  });
  route('POST', '/api/reminders/run', async (req, res) => {
    await requireUser(req, 'owner');
    send(res, 200, { results: await svc.runReminders(db, taipeiNow().date) });
  });

  /* ── 排程（Vercel Cron 或外部排程服務呼叫） ── */
  route('GET', '/api/cron/reminders', async (req, res) => {
    const expected = process.env.CRON_SECRET;
    assert(expected, 503, '尚未設定 CRON_SECRET');
    const got = String(req.headers.authorization || '');
    const want = `Bearer ${expected}`;
    assert(got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)), 401, '未授權');
    send(res, 200, await svc.reminderTick(db));
  });

  /* ── 客戶（LINE 訂購頁） ── */
  route('GET', '/api/public/config', async (req, res) => {
    const s = await getSettings(db);
    const today = taipeiNow().date;
    const maxDays = toInt(s.max_advance_days) || 7;
    send(res, 200, {
      store_name: s.store_name,
      store_phone: s.store_phone,
      store_address: s.store_address,
      pickup_slots: await pickupSlots(db),
      today,
      pickup_dates: Array.from({ length: maxDays + 1 }, (_, i) => addDays(today, i)),
      liff_id: s.liff_id,
      mock_line: !s.liff_id,
    });
  });
  route('POST', '/api/customer/session', async (req, res) => {
    const b = await readJson(req);
    let lineUserId;
    let lineName = '';
    if (b.idToken) {
      const v = await verifyIdToken(db, String(b.idToken)).catch((e) => { throw new HttpError(401, e.message); });
      lineUserId = v.userId;
      lineName = v.name;
    } else {
      assert(!(await getSetting(db, 'liff_id')), 400, '請從 LINE 開啟訂購頁');
      lineUserId = String(b.mockUserId || '').trim();
      assert(/^U-test[\w-]{0,30}$/.test(lineUserId), 400, '測試 LINE ID 需以 U-test 開頭');
    }
    const c = await svc.upsertCustomer(db, lineUserId);
    const token = signToken(await secret(), { cid: c.id, exp: Date.now() + CUSTOMER_SESSION_SEC * 1000 });
    send(res, 200, { name: c.name || lineName, phone: c.phone, line_user_id: lineUserId },
      { 'Set-Cookie': cookieHeader('cid', token, CUSTOMER_SESSION_SEC, req) });
  });
  route('GET', '/api/customer/me', async (req, res) => {
    const c = await requireCustomer(req);
    send(res, 200, { name: c.name, phone: c.phone, line_user_id: c.line_user_id });
  });
  route('GET', '/api/customer/products', async (req, res) => {
    await requireCustomer(req);
    send(res, 200, (await svc.listProducts(db)).filter((p) => !p.paused && p.preorderable)
      .map(({ id, name, price, image, description }) => ({ id, name, price, image, description })));
  });
  route('GET', '/api/customer/orders', async (req, res) => {
    const c = await requireCustomer(req);
    const out = [];
    for (const { id } of await db.all('SELECT id FROM orders WHERE customer_id = ? ORDER BY id DESC LIMIT 20', [c.id])) {
      const o = await svc.getOrder(db, id);
      out.push({ id: o.id, code: o.code, status: o.status, pickup_date: o.pickup_date, pickup_slot: o.pickup_slot, total: o.total, note: o.note, created_at: o.created_at, items: o.items.map(({ name, price, qty }) => ({ name, price, qty })) });
    }
    send(res, 200, out);
  });
  route('POST', '/api/customer/orders', async (req, res) => {
    const c = await requireCustomer(req);
    const o = await svc.createCustomerOrder(db, c.id, await readJson(req));
    send(res, 201, { id: o.id, code: o.code, status: o.status, total: o.total, pickup_date: o.pickup_date, pickup_slot: o.pickup_slot, items: o.items, notify: o.messages.at(-1)?.status });
  });
  route('POST', '/api/customer/orders/:id/cancel', async (req, res, p) => {
    const c = await requireCustomer(req);
    const o = await db.one('SELECT id FROM orders WHERE id = ? AND customer_id = ?', [toInt(p.id), c.id]);
    assert(o, 404, '找不到訂單');
    await svc.cancelOrder(db, o.id, '', { byCustomer: true });
    send(res, 200, { ok: true });
  });

  /* ── 電子收據頁 ── */
  async function receiptPage(t, autoPrint) {
    const s = await getSettings(db);
    const rows = t.items.map((i) => `<tr><td>${escapeHtml(i.name)}</td><td class="n">${i.qty}</td><td class="n">${money(i.price * i.qty)}</td></tr>`).join('');
    return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>電子收據 ${escapeHtml(t.code)}</title><link rel="stylesheet" href="/css/receipt.css"></head>
<body${autoPrint ? ' onload="window.print()"' : ''}><main class="receipt">
${t.voided ? '<div class="void">此交易已作廢</div>' : ''}
<h1>${escapeHtml(s.store_name)}</h1>
<p class="meta">${escapeHtml(s.store_address)}<br>${escapeHtml(s.store_phone)}${s.store_tax_id ? `<br>統一編號 ${escapeHtml(s.store_tax_id)}` : ''}</p>
<h2>電子收據</h2>
<dl><dt>交易編號</dt><dd>${escapeHtml(t.code)}</dd>
${t.order_code ? `<dt>訂單編號</dt><dd>${escapeHtml(t.order_code)}</dd>` : ''}
<dt>時間</dt><dd>${escapeHtml(t.created_at.slice(0, 16))}</dd>
<dt>狀態</dt><dd>${t.voided ? '已作廢' : t.order_id ? '已結帳．已取貨' : '已結帳'}</dd></dl>
<table><thead><tr><th>品項</th><th class="n">數量</th><th class="n">金額</th></tr></thead><tbody>${rows}</tbody></table>
<dl class="total"><dt>合計</dt><dd>${money(t.total)}</dd><dt>付款方式</dt><dd>現金</dd>
<dt>實收</dt><dd>${money(t.cash_received)}</dd><dt>找零</dt><dd>${money(t.change_due)}</dd></dl>
<p class="foot">${escapeHtml(s.receipt_footer)}</p>
</main></body></html>`;
  }

  /* ── 請求處理 ── */
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (!db) {
        try {
          db = await (typeof dbReady === 'function' ? dbReady() : dbReady);
        } catch (e) {
          console.error('[資料庫] 初始化失敗', e);
          return send(res, 503, { error: `系統尚未完成設定：${e.message}` });
        }
      }
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'GET') {
          // 簡易 CSRF 防護：寫入類請求必須是 JSON
          assert(String(req.headers['content-type'] || '').includes('application/json'), 415, '請以 JSON 送出');
        }
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.re.exec(pathname);
          if (!m) continue;
          await r.handler(req, res, Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])), url);
          return;
        }
        throw new HttpError(404, '找不到 API');
      }
      const rm = /^\/r\/([\w-]+)$/.exec(pathname);
      if (rm) {
        const row = await db.one('SELECT id FROM transactions WHERE receipt_token = ?', [rm[1]]);
        if (!row) return send(res, 404, '找不到收據');
        return send(res, 200, await receiptPage(await svc.getTransaction(db, row.id), url.searchParams.has('print')), { 'Content-Type': 'text/html; charset=utf-8' });
      }
      const um = /^\/uploads\/([\w.-]+)$/.exec(pathname);
      if (um) {
        const img = await db.one('SELECT mime, data FROM images WHERE id = ?', [um[1]]);
        if (!img) return send(res, 404, '找不到圖片');
        return send(res, 200, Buffer.from(img.data, 'base64'), { 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
      }
      if (pathname === '/') {
        res.writeHead(302, { Location: '/pos.html' });
        return res.end();
      }
      if (serveStatic(res, pathname)) return;
      send(res, 404, '找不到頁面');
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: '系統發生錯誤，請稍後再試' });
    }
  };
}
