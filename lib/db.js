import path from 'node:path';
import { hashPassword } from './auth.js';
import { randomToken, taipeiNow } from './util.js';

/*
 * 資料庫：PostgreSQL
 * - 雲端：設定 DATABASE_URL（Neon / Supabase / 任何 Postgres）
 * - 本機與測試：未設定時使用內嵌的 PGlite（同樣是 Postgres，資料存在 data/pgdata）
 *
 * 對外介面（db 與交易中的 t 相同）：
 *   await db.all(sql, params)  → rows
 *   await db.one(sql, params)  → row | null
 *   await db.run(sql, params)  → { rowCount, rows }
 *   await db.tx(async (t) => …)
 * SQL 參數一律寫 ?，由這裡轉成 $1, $2…
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','staff')), pw_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL, image TEXT,
  description TEXT NOT NULL DEFAULT '', preorderable INTEGER NOT NULL DEFAULT 1,
  paused INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY, line_user_id TEXT UNIQUE, name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, customer_id INTEGER NOT NULL REFERENCES customers(id),
  customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL,
  pickup_date TEXT NOT NULL, pickup_slot TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','confirmed','picked_up','cancelled')),
  total INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  confirmed_at TEXT, cancelled_at TEXT, cancel_reason TEXT, picked_up_at TEXT,
  reminded_at TEXT, transaction_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_pickup ON orders (pickup_date, status);
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER,
  name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_order_items ON order_items (order_id);
CREATE TABLE IF NOT EXISTS transactions (
  id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, biz_date TEXT NOT NULL, created_at TEXT NOT NULL,
  user_id INTEGER, user_name TEXT NOT NULL, total INTEGER NOT NULL,
  cash_received INTEGER NOT NULL, change_due INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'cash', order_id INTEGER, customer_id INTEGER,
  receipt_token TEXT UNIQUE NOT NULL, voided INTEGER NOT NULL DEFAULT 0,
  void_reason TEXT, voided_by TEXT, voided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions (biz_date);
CREATE TABLE IF NOT EXISTS transaction_items (
  id SERIAL PRIMARY KEY, transaction_id INTEGER NOT NULL REFERENCES transactions(id), product_id INTEGER,
  name TEXT NOT NULL, price INTEGER NOT NULL, qty INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_items ON transaction_items (transaction_id);
CREATE TABLE IF NOT EXISTS line_messages (
  id SERIAL PRIMARY KEY, created_at TEXT NOT NULL, kind TEXT NOT NULL, to_user TEXT,
  customer_id INTEGER, order_id INTEGER, transaction_id INTEGER,
  text TEXT NOT NULL, status TEXT NOT NULL, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_order ON line_messages (order_id);
`;

export const DEFAULT_SETTINGS = {
  store_name: '示範烘焙坊',
  store_address: '（請到設定頁填寫地址）',
  store_phone: '（請填寫電話）',
  store_tax_id: '',
  receipt_footer: '本收據非統一發票，僅供對帳使用。',
  pickup_slots: '上午 09:00–12:00\n下午 12:00–16:00\n傍晚 16:00–19:00',
  reminder_time: '16:30',
  max_advance_days: '7',
  public_base_url: '',
  line_channel_token: '',
  liff_id: '',
  line_login_channel_id: '',
  line_notify_received: '1',
  last_reminder_date: '',
};

export const SEED_PRODUCTS = [
  ['原味可頌', 45, '法國奶油層層酥脆'],
  ['巧克力可頌', 55, '可頌包入比利時巧克力'],
  ['紅豆麵包', 35, '自家熬煮蜜紅豆'],
  ['肉鬆麵包', 40, '台式經典，肉鬆與美乃滋'],
  ['菠蘿麵包', 35, '酥皮香甜'],
  ['全麥吐司', 90, '整條，適合早餐'],
  ['鄉村歐包', 120, '天然酵母長時間發酵'],
  ['肉桂捲', 65, '肉桂糖霜'],
];

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function wrap(exec) {
  const run = async (sql, params = []) => {
    const r = await exec(toPg(sql), params);
    return { rows: r.rows, rowCount: r.rowCount ?? r.affectedRows ?? 0 };
  };
  return {
    run,
    all: async (sql, params) => (await run(sql, params)).rows,
    one: async (sql, params) => (await run(sql, params)).rows[0] ?? null,
  };
}

async function pgDriver(url) {
  const { default: pg } = await import('pg');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX) || 3,
    ssl: local || /sslmode=disable/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  const db = wrap((sql, params) => pool.query(sql, params));
  db.exec = (sql) => pool.query(sql);
  db.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(wrap((sql, params) => client.query(sql, params)));
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  db.close = () => pool.end();
  db.kind = 'postgres';
  return db;
}

async function pgliteDriver(dir) {
  // 以變數名稱匯入，避免雲端打包時把 PGlite 一起包進去
  const mod = '@electric-sql/pglite';
  const { PGlite } = await import(mod);
  const lite = dir ? new PGlite(dir) : new PGlite();
  await lite.waitReady;
  const db = wrap((sql, params) => lite.query(sql, params));
  db.exec = (sql) => lite.exec(sql);
  db.tx = (fn) => lite.transaction((t) => fn(wrap((sql, params) => t.query(sql, params))));
  db.close = () => lite.close();
  db.kind = 'pglite';
  return db;
}

/**
 * 開啟資料庫、建立資料表、寫入初始資料。
 * options.url：Postgres 連線字串；options.dataDir：PGlite 資料夾（null 表示只存在記憶體，測試用）
 */
export async function openDb({ url = process.env.DATABASE_URL || process.env.POSTGRES_URL, dataDir } = {}) {
  if (!url && process.env.VERCEL) throw new Error('尚未連接資料庫，請在 Vercel 專案的 Storage 建立 Postgres（Neon）資料庫');
  const db = url ? await pgDriver(url) : await pgliteDriver(dataDir ? path.join(dataDir, 'pgdata') : null);
  await db.exec(SCHEMA);
  await seed(db, { production: !!url });
  return db;
}

async function seed(db, { production }) {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', ['session_secret', randomToken(32)]);

  const now = taipeiNow().datetime;
  const { n: users } = await db.one('SELECT COUNT(*)::int AS n FROM users');
  if (users === 0) {
    // 初始帳號寫入 users 資料表（密碼以 scrypt 雜湊保存）。
    // 雲端請以環境變數 ADMIN_PASSWORD / STAFF_PASSWORD 指定初始密碼；本機未設定時用示範密碼。
    const ownerPw = process.env.ADMIN_PASSWORD || (production ? null : 'owner1234');
    const staffPw = process.env.STAFF_PASSWORD || (production ? null : 'staff1234');
    if (!ownerPw) throw new Error('首次建立資料庫需要設定環境變數 ADMIN_PASSWORD（店主初始密碼）');
    await db.run('INSERT INTO users (username, name, role, pw_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (username) DO NOTHING',
      [process.env.ADMIN_USERNAME || 'owner', '店主', 'owner', hashPassword(ownerPw), now]);
    if (staffPw) {
      await db.run('INSERT INTO users (username, name, role, pw_hash, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (username) DO NOTHING',
        ['staff', '店員', 'staff', hashPassword(staffPw), now]);
    }
  }
  const { n: products } = await db.one('SELECT COUNT(*)::int AS n FROM products');
  if (products === 0) {
    for (const [i, [name, price, desc]] of SEED_PRODUCTS.entries()) {
      await db.run('INSERT INTO products (name, price, description, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [name, price, desc, i, now, now]);
    }
  }
}

/** 這些設定可改由環境變數提供（例如在 Vercel 專案設定），環境變數優先 */
export const ENV_SETTINGS = {
  line_channel_token: 'LINE_CHANNEL_ACCESS_TOKEN',
  liff_id: 'LIFF_ID',
  line_login_channel_id: 'LINE_LOGIN_CHANNEL_ID',
  public_base_url: 'PUBLIC_BASE_URL',
};

export function envSetting(key) {
  const name = ENV_SETTINGS[key];
  return name ? (process.env[name] || '').trim() : '';
}

export async function getSettings(db) {
  const rows = await db.all('SELECT key, value FROM settings');
  const out = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  for (const key of Object.keys(ENV_SETTINGS)) if (envSetting(key)) out[key] = envSetting(key);
  return out;
}

export async function getSetting(db, key) {
  return envSetting(key) || ((await db.one('SELECT value FROM settings WHERE key = ?', [key]))?.value ?? '');
}

export async function setSetting(db, key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}

export async function pickupSlots(db) {
  return (await getSetting(db, 'pickup_slots')).split('\n').map((s) => s.trim()).filter(Boolean);
}
