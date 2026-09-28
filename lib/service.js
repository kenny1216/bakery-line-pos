import { getSettings, getSetting, pickupSlots } from './db.js';
import { pushText } from './line.js';
import { taipeiNow, addDays, isDateStr, randomToken, assert, toInt, money } from './util.js';

export const ORDER_STATUS_LABEL = { new: '新訂單', confirmed: '已確認', picked_up: '已取貨', cancelled: '已取消' };

/* ───────────── 商品 ───────────── */

export function listProducts(db) {
  return db.all('SELECT * FROM products WHERE deleted = 0 ORDER BY sort, id');
}

function cleanProductInput(input, partial = false) {
  const out = {};
  if (!partial || input.name !== undefined) {
    const name = String(input.name ?? '').trim();
    assert(name.length >= 1 && name.length <= 30, 400, '商品名稱需 1–30 字');
    out.name = name;
  }
  if (!partial || input.price !== undefined) {
    const price = toInt(input.price);
    assert(price >= 0 && price <= 100000, 400, '售價需為 0–100000 的整數');
    out.price = price;
  }
  if (input.description !== undefined) out.description = String(input.description).trim().slice(0, 100);
  if (input.image !== undefined) {
    const img = input.image ? String(input.image) : null;
    assert(img === null || /^\/uploads\/[\w.-]+$/.test(img), 400, '照片路徑不正確');
    out.image = img;
  }
  if (input.preorderable !== undefined) out.preorderable = input.preorderable ? 1 : 0;
  if (input.paused !== undefined) out.paused = input.paused ? 1 : 0;
  if (input.sort !== undefined) {
    const sort = toInt(input.sort);
    assert(Number.isInteger(sort), 400, '排序需為整數');
    out.sort = sort;
  }
  return out;
}

export async function createProduct(db, input) {
  const p = cleanProductInput(input);
  const now = taipeiNow().datetime;
  const { m } = await db.one('SELECT COALESCE(MAX(sort), -1)::int AS m FROM products');
  return db.one(`INSERT INTO products (name, price, description, image, preorderable, paused, sort, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
  [p.name, p.price, p.description ?? '', p.image ?? null, p.preorderable ?? 1, p.paused ?? 0, p.sort ?? m + 1, now, now]);
}

export async function updateProduct(db, id, input) {
  const existing = await db.one('SELECT * FROM products WHERE id = ? AND deleted = 0', [id]);
  assert(existing, 404, '找不到商品');
  const p = cleanProductInput(input, true);
  const keys = Object.keys(p);
  if (!keys.length) return existing;
  return db.one(`UPDATE products SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? RETURNING *`,
    [...keys.map((k) => p[k]), taipeiNow().datetime, id]);
}

export async function deleteProduct(db, id) {
  const r = await db.run('UPDATE products SET deleted = 1, updated_at = ? WHERE id = ? AND deleted = 0', [taipeiNow().datetime, id]);
  assert(r.rowCount === 1, 404, '找不到商品');
}

/* ───────────── 共用 ───────────── */

/** 產生當日流水號；必須在交易內呼叫（以 advisory lock 避免同時結帳拿到同號） */
async function nextCode(t, table, prefix, width) {
  await t.run('SELECT pg_advisory_xact_lock(hashtext(?))', [table]);
  const { n } = await t.one(`SELECT COUNT(*)::int AS n FROM ${table} WHERE code LIKE ?`, [`${prefix}%`]);
  return `${prefix}${String(n + 1).padStart(width, '0')}`;
}

function normalizeItems(items) {
  assert(Array.isArray(items) && items.length > 0, 400, '請至少選擇一項商品');
  assert(items.length <= 50, 400, '品項太多');
  const merged = new Map();
  for (const it of items) {
    const pid = toInt(it.product_id);
    const qty = toInt(it.qty);
    assert(pid > 0, 400, '商品資料不正確');
    assert(qty >= 1 && qty <= 999, 400, '數量需為 1–999');
    merged.set(pid, (merged.get(pid) || 0) + qty);
  }
  for (const qty of merged.values()) assert(qty <= 999, 400, '數量需為 1–999');
  return [...merged].map(([product_id, qty]) => ({ product_id, qty }));
}

function itemLines(items) {
  return items.map((i) => `${i.name} x${i.qty}　${money(i.price * i.qty)}`).join('\n');
}

/* ───────────── 訂單 ───────────── */

export async function getOrder(db, id) {
  const o = await db.one('SELECT * FROM orders WHERE id = ?', [id]);
  if (!o) return null;
  o.items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY id', [id]);
  o.messages = await db.all('SELECT id, created_at, kind, status, error FROM line_messages WHERE order_id = ? ORDER BY id', [id]);
  o.has_line = !!(await db.one('SELECT line_user_id FROM customers WHERE id = ?', [o.customer_id]))?.line_user_id;
  o.receipt_token = o.transaction_id
    ? (await db.one('SELECT receipt_token FROM transactions WHERE id = ?', [o.transaction_id]))?.receipt_token ?? null
    : null;
  return o;
}

export async function listOrders(db, { date, status }) {
  let rows;
  if (status === 'new') {
    rows = await db.all("SELECT id FROM orders WHERE status = 'new' ORDER BY pickup_date, id");
  } else {
    assert(isDateStr(date), 400, '日期格式不正確');
    rows = status && ORDER_STATUS_LABEL[status]
      ? await db.all('SELECT id FROM orders WHERE pickup_date = ? AND status = ? ORDER BY pickup_slot, id', [date, status])
      : await db.all('SELECT id FROM orders WHERE pickup_date = ? ORDER BY pickup_slot, id', [date]);
  }
  const out = [];
  for (const r of rows) out.push(await getOrder(db, r.id));
  return out;
}

export async function orderCounts(db, date) {
  const counts = { new: 0, confirmed: 0, picked_up: 0, cancelled: 0, all: 0 };
  for (const r of await db.all('SELECT status, COUNT(*)::int AS n FROM orders WHERE pickup_date = ? GROUP BY status', [date])) {
    counts[r.status] = r.n;
    counts.all += r.n;
  }
  counts.new_all_dates = (await db.one("SELECT COUNT(*)::int AS n FROM orders WHERE status = 'new'")).n;
  return counts;
}

async function validatePickup(db, pickup_date, pickup_slot) {
  const today = taipeiNow().date;
  const maxDays = toInt(await getSetting(db, 'max_advance_days')) || 7;
  assert(isDateStr(pickup_date), 400, '請選擇取貨日期');
  assert(pickup_date >= today && pickup_date <= addDays(today, maxDays), 400, `取貨日期需在今天到 ${maxDays} 天內`);
  assert((await pickupSlots(db)).includes(pickup_slot), 400, '請選擇取貨時段');
}

export async function upsertCustomer(db, lineUserId) {
  const now = taipeiNow().datetime;
  await db.run('INSERT INTO customers (line_user_id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT (line_user_id) DO NOTHING', [lineUserId, now, now]);
  return db.one('SELECT * FROM customers WHERE line_user_id = ?', [lineUserId]);
}

async function notifyOrder(db, order, kind, text) {
  const c = await db.one('SELECT line_user_id FROM customers WHERE id = ?', [order.customer_id]);
  return pushText(db, { to: c?.line_user_id, text, kind, customerId: order.customer_id, orderId: order.id });
}

export async function createCustomerOrder(db, customerId, input) {
  const name = String(input.name ?? '').trim();
  const phone = String(input.phone ?? '').trim();
  const note = String(input.note ?? '').trim().slice(0, 200);
  assert(name.length >= 1 && name.length <= 30, 400, '請填寫姓名');
  assert(/^[0-9+\-\s()#]{8,20}$/.test(phone), 400, '請填寫正確的電話');
  await validatePickup(db, input.pickup_date, input.pickup_slot);
  const wanted = normalizeItems(input.items);

  const orderId = await db.tx(async (t) => {
    const items = [];
    for (const { product_id, qty } of wanted) {
      const p = await t.one('SELECT * FROM products WHERE id = ? AND deleted = 0', [product_id]);
      assert(p, 400, '有商品已下架，請重新整理');
      assert(!p.paused && p.preorderable, 400, `「${p.name}」目前暫停預訂，請重新整理`);
      items.push({ product_id, name: p.name, price: p.price, qty });
    }
    const total = items.reduce((s, i) => s + i.price * i.qty, 0);
    const now = taipeiNow();
    await t.run('UPDATE customers SET name = ?, phone = ?, updated_at = ? WHERE id = ?', [name, phone, now.datetime, customerId]);
    const code = await nextCode(t, 'orders', `O${now.date.replaceAll('-', '')}-`, 3);
    const { id } = await t.one(`INSERT INTO orders (code, customer_id, customer_name, customer_phone, pickup_date, pickup_slot, note, total, created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [code, customerId, name, phone, input.pickup_date, input.pickup_slot, note, total, now.datetime, now.datetime]);
    for (const i of items) {
      await t.run('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)', [id, i.product_id, i.name, i.price, i.qty]);
    }
    return id;
  });

  const order = await getOrder(db, orderId);
  if ((await getSetting(db, 'line_notify_received')) !== '0') {
    const storeName = await getSetting(db, 'store_name');
    await notifyOrder(db, order, 'order_received',
      `【${storeName}】已收到您的預訂\n訂單編號 ${order.code}\n取貨 ${order.pickup_date} ${order.pickup_slot}\n${itemLines(order.items)}\n合計 ${money(order.total)}（到店付現）\n\n目前狀態：待店家確認。確認後會再以 LINE 通知您。`);
  }
  return getOrder(db, orderId);
}

export async function confirmOrder(db, id) {
  const now = taipeiNow().datetime;
  const r = await db.run("UPDATE orders SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ? AND status = 'new'", [now, now, id]);
  if (r.rowCount !== 1) {
    const o = await db.one('SELECT status FROM orders WHERE id = ?', [id]);
    assert(o, 404, '找不到訂單');
    assert(false, 409, `訂單目前為「${ORDER_STATUS_LABEL[o.status]}」，無法確認`);
  }
  const o = await getOrder(db, id);
  const storeName = await getSetting(db, 'store_name');
  await notifyOrder(db, o, 'order_confirmed',
    `【${storeName}】您的訂單已確認 ✅\n訂單編號 ${o.code}\n取貨 ${o.pickup_date} ${o.pickup_slot}\n${itemLines(o.items)}\n合計 ${money(o.total)}，請到店付現。\n\n需要調整請直接回覆此 LINE。`);
  return getOrder(db, id);
}

export async function cancelOrder(db, id, reason, { byCustomer = false } = {}) {
  const o = await getOrder(db, id);
  assert(o, 404, '找不到訂單');
  if (byCustomer) assert(o.status === 'new', 409, '店家已確認的訂單請直接回覆 LINE 聯絡店家取消');
  assert(o.status === 'new' || o.status === 'confirmed', 409, `訂單目前為「${ORDER_STATUS_LABEL[o.status]}」，無法取消`);
  const why = String(reason ?? '').trim().slice(0, 100) || (byCustomer ? '客戶自行取消' : '');
  const now = taipeiNow().datetime;
  const r = await db.run("UPDATE orders SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ? WHERE id = ? AND status IN ('new','confirmed')",
    [now, why, now, id]);
  assert(r.rowCount === 1, 409, '訂單狀態已變更，請重新整理');
  const storeName = await getSetting(db, 'store_name');
  await notifyOrder(db, o, 'order_cancelled',
    `【${storeName}】訂單 ${o.code} 已取消。${why && !byCustomer ? `\n原因：${why}` : ''}\n如有疑問請直接回覆此 LINE。`);
  return getOrder(db, id);
}

export async function updateOrder(db, id, input) {
  const o = await getOrder(db, id);
  assert(o, 404, '找不到訂單');
  assert(o.status === 'new' || o.status === 'confirmed', 409, '只有新訂單或已確認訂單可以調整');
  await validatePickup(db, input.pickup_date ?? o.pickup_date, input.pickup_slot ?? o.pickup_slot);
  const wanted = input.items ? normalizeItems(input.items) : null;

  await db.tx(async (t) => {
    let total = o.total;
    if (wanted) {
      // 已在訂單內的商品維持下單時的價格；新增的商品用目前售價
      const old = new Map(o.items.map((i) => [i.product_id, i]));
      const items = [];
      for (const { product_id, qty } of wanted) {
        const prev = old.get(product_id);
        if (prev) {
          items.push({ product_id, name: prev.name, price: prev.price, qty });
        } else {
          const p = await t.one('SELECT * FROM products WHERE id = ? AND deleted = 0', [product_id]);
          assert(p, 400, '商品不存在');
          items.push({ product_id, name: p.name, price: p.price, qty });
        }
      }
      await t.run('DELETE FROM order_items WHERE order_id = ?', [id]);
      for (const i of items) {
        await t.run('INSERT INTO order_items (order_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)', [id, i.product_id, i.name, i.price, i.qty]);
      }
      total = items.reduce((s, i) => s + i.price * i.qty, 0);
    }
    const note = input.note !== undefined ? String(input.note).trim().slice(0, 200) : o.note;
    await t.run('UPDATE orders SET pickup_date = ?, pickup_slot = ?, note = ?, total = ?, updated_at = ? WHERE id = ?',
      [input.pickup_date ?? o.pickup_date, input.pickup_slot ?? o.pickup_slot, note, total, taipeiNow().datetime, id]);
  });

  const updated = await getOrder(db, id);
  if (input.notify !== false) {
    const storeName = await getSetting(db, 'store_name');
    await notifyOrder(db, updated, 'order_updated',
      `【${storeName}】您的訂單已由店家調整\n訂單編號 ${updated.code}\n取貨 ${updated.pickup_date} ${updated.pickup_slot}\n${itemLines(updated.items)}\n合計 ${money(updated.total)}（到店付現）`);
  }
  return getOrder(db, id);
}

/* ───────────── 結帳 ───────────── */

export async function getTransaction(db, id) {
  const t = await db.one('SELECT * FROM transactions WHERE id = ?', [id]);
  if (!t) return null;
  t.items = await db.all('SELECT * FROM transaction_items WHERE transaction_id = ? ORDER BY id', [id]);
  t.order_code = t.order_id ? (await db.one('SELECT code FROM orders WHERE id = ?', [t.order_id]))?.code ?? null : null;
  return t;
}

export async function receiptText(db, t, baseUrl) {
  const s = await getSettings(db);
  const lines = [
    `【${s.store_name}】電子收據`,
    `交易編號 ${t.code}`,
    t.order_code ? `訂單編號 ${t.order_code}` : null,
    `時間 ${t.created_at.slice(0, 16)}`,
    '────────',
    itemLines(t.items),
    '────────',
    `合計 ${money(t.total)}`,
    '付款方式 現金',
    `實收 ${money(t.cash_received)}　找零 ${money(t.change_due)}`,
    `狀態 ${t.voided ? '已作廢' : t.order_id ? '已結帳．已取貨' : '已結帳'}`,
    baseUrl ? `\n收據網頁 ${baseUrl}/r/${t.receipt_token}` : null,
    s.receipt_footer || null,
  ];
  return lines.filter((l) => l !== null).join('\n');
}

export async function checkout(db, user, input, baseUrl) {
  const orderId = input.order_id ? toInt(input.order_id) : null;
  const cash = toInt(input.cash_received);
  const wanted = normalizeItems(input.items);

  const txId = await db.tx(async (t) => {
    let order = null;
    let orderPrices = new Map();
    if (orderId) {
      order = await t.one('SELECT * FROM orders WHERE id = ? FOR UPDATE', [orderId]);
      assert(order, 404, '找不到訂單');
      assert(order.status === 'new' || order.status === 'confirmed', 409, `訂單目前為「${ORDER_STATUS_LABEL[order.status]}」，無法結帳`);
      const items = await t.all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
      orderPrices = new Map(items.map((i) => [i.product_id, i]));
    }
    const priced = [];
    for (const { product_id, qty } of wanted) {
      const fromOrder = orderPrices.get(product_id);
      if (fromOrder) {
        priced.push({ product_id, name: fromOrder.name, price: fromOrder.price, qty });
        continue;
      }
      const p = await t.one('SELECT * FROM products WHERE id = ? AND deleted = 0', [product_id]);
      assert(p, 400, '有商品已被刪除，請重新整理');
      assert(!p.paused, 400, `「${p.name}」已暫停販售`);
      priced.push({ product_id, name: p.name, price: p.price, qty });
    }
    const total = priced.reduce((s, i) => s + i.price * i.qty, 0);
    assert(Number.isInteger(cash) && cash >= total, 400, '實收金額不足');
    assert(cash <= total + 100000, 400, '實收金額不合理，請再確認');

    const now = taipeiNow();
    const code = await nextCode(t, 'transactions', `T${now.date.replaceAll('-', '')}-`, 4);
    const { id } = await t.one(`INSERT INTO transactions (code, biz_date, created_at, user_id, user_name, total, cash_received, change_due, order_id, customer_id, receipt_token)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [code, now.date, now.datetime, user.id, user.name, total, cash, cash - total, orderId, order?.customer_id ?? null, randomToken(18)]);
    for (const i of priced) {
      await t.run('INSERT INTO transaction_items (transaction_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)', [id, i.product_id, i.name, i.price, i.qty]);
    }
    if (order) {
      await t.run("UPDATE orders SET status = 'picked_up', picked_up_at = ?, transaction_id = ?, updated_at = ? WHERE id = ?",
        [now.datetime, id, now.datetime, orderId]);
    }
    return id;
  });

  const t = await getTransaction(db, txId);
  let receipt_status = 'none';
  if (t.customer_id) {
    const c = await db.one('SELECT line_user_id FROM customers WHERE id = ?', [t.customer_id]);
    receipt_status = await pushText(db, {
      to: c?.line_user_id, text: await receiptText(db, t, baseUrl), kind: 'receipt',
      customerId: t.customer_id, orderId: t.order_id, transactionId: t.id,
    });
  }
  return { ...t, receipt_status };
}

export async function voidTransaction(db, user, id, reason) {
  const why = String(reason ?? '').trim();
  assert(why.length >= 2 && why.length <= 100, 400, '請填寫作廢原因（2–100 字）');
  await db.tx(async (t) => {
    const tr = await t.one('SELECT * FROM transactions WHERE id = ? FOR UPDATE', [id]);
    assert(tr, 404, '找不到交易');
    assert(!tr.voided, 409, '這筆交易已作廢');
    const now = taipeiNow().datetime;
    await t.run('UPDATE transactions SET voided = 1, void_reason = ?, voided_by = ?, voided_at = ? WHERE id = ?', [why, user.name, now, id]);
    if (tr.order_id) {
      // 訂單退回「已確認」，可重新結帳
      await t.run("UPDATE orders SET status = 'confirmed', picked_up_at = NULL, transaction_id = NULL, updated_at = ? WHERE id = ? AND transaction_id = ?",
        [now, tr.order_id, id]);
    }
  });
  return getTransaction(db, id);
}

/* ───────────── 報表 ───────────── */

export async function dailyReport(db, date) {
  assert(isDateStr(date), 400, '日期格式不正確');
  const txRows = await db.all('SELECT * FROM transactions WHERE biz_date = ? ORDER BY id', [date]);
  const itemRows = await db.all(`SELECT ti.* FROM transaction_items ti JOIN transactions t ON t.id = ti.transaction_id
                                 WHERE t.biz_date = ? ORDER BY ti.id`, [date]);
  const codes = new Map((await db.all(`SELECT o.id, o.code FROM orders o JOIN transactions t ON t.order_id = o.id WHERE t.biz_date = ?`, [date]))
    .map((r) => [r.id, r.code]));
  const txs = txRows.map((t) => ({ ...t, items: itemRows.filter((i) => i.transaction_id === t.id), order_code: codes.get(t.order_id) ?? null }));
  const valid = txs.filter((t) => !t.voided);
  const voided = txs.filter((t) => t.voided);
  const products = new Map();
  for (const t of valid) {
    for (const i of t.items) {
      const p = products.get(i.name) || { name: i.name, qty: 0, amount: 0 };
      p.qty += i.qty;
      p.amount += i.qty * i.price;
      products.set(i.name, p);
    }
  }
  const orders = await db.all('SELECT id, code, customer_name, customer_phone, pickup_slot, status, total FROM orders WHERE pickup_date = ? ORDER BY pickup_slot, id', [date]);
  const orderStatus = { new: 0, confirmed: 0, picked_up: 0, cancelled: 0 };
  for (const o of orders) orderStatus[o.status] += 1;
  return {
    date,
    summary: {
      count: valid.length,
      cash_total: valid.reduce((s, t) => s + t.total, 0),
      item_qty: valid.reduce((s, t) => s + t.items.reduce((a, i) => a + i.qty, 0), 0),
      preorder_count: valid.filter((t) => t.order_id).length,
      void_count: voided.length,
      void_total: voided.reduce((s, t) => s + t.total, 0),
    },
    products: [...products.values()].sort((a, b) => b.amount - a.amount),
    transactions: txs,
    orders,
    order_status: orderStatus,
  };
}

export function reportCsv(report) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const rows = [];
  const s = report.summary;
  rows.push([`每日銷售報表 ${report.date}`]);
  rows.push(['有效交易筆數', s.count], ['現金總額', s.cash_total], ['售出件數', s.item_qty], ['預訂取貨筆數', s.preorder_count], ['作廢筆數', s.void_count], ['作廢金額', s.void_total]);
  rows.push([]);
  rows.push(['商品', '數量', '金額']);
  for (const p of report.products) rows.push([p.name, p.qty, p.amount]);
  rows.push([]);
  rows.push(['交易編號', '時間', '店員', '訂單編號', '品項', '應收', '實收', '找零', '狀態', '作廢原因', '作廢人', '作廢時間']);
  for (const t of report.transactions) {
    rows.push([t.code, t.created_at, t.user_name, t.order_code || '', t.items.map((i) => `${i.name}x${i.qty}`).join(' '),
      t.total, t.cash_received, t.change_due, t.voided ? '作廢' : '有效', t.void_reason || '', t.voided_by || '', t.voided_at || '']);
  }
  rows.push([]);
  rows.push(['訂單編號', '客戶', '電話', '取貨時段', '狀態', '金額']);
  for (const o of report.orders) rows.push([o.code, o.customer_name, o.customer_phone, o.pickup_slot, ORDER_STATUS_LABEL[o.status], o.total]);
  return `﻿${rows.map((r) => r.map(esc).join(',')).join('\r\n')}\r\n`;
}

/* ───────────── 未取貨提醒 ───────────── */

export async function runReminders(db, date = taipeiNow().date) {
  const rows = await db.all(`SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id
                             WHERE o.pickup_date = ? AND o.status = 'confirmed' AND o.reminded_at IS NULL
                               AND c.line_user_id IS NOT NULL AND c.line_user_id <> ''`, [date]);
  const storeName = await getSetting(db, 'store_name');
  const results = [];
  for (const { id } of rows) {
    // 先標記再發送，確保每筆只發一次（多台機器同時執行也只有一台會標記成功）
    const r = await db.run('UPDATE orders SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL', [taipeiNow().datetime, id]);
    if (r.rowCount !== 1) continue;
    const o = await getOrder(db, id);
    const status = await notifyOrder(db, o, 'reminder',
      `【${storeName}】您預訂的麵包尚未取貨，門市目前為您保留中。\n訂單編號 ${o.code}（${o.pickup_slot}）\n如需調整取貨時間，請直接回覆 LINE。`);
    results.push({ order_id: id, code: o.code, status });
  }
  return results;
}

/**
 * 排程檢查：到了提醒時間且今天還沒跑過，就發提醒。
 * 本機由計時器每 30 秒呼叫；雲端由 /api/cron/reminders 定時呼叫。
 * force：不看時間直接執行（Vercel 每日備援排程使用）。
 */
export async function reminderTick(db, { force = false } = {}) {
  const now = taipeiNow();
  const at = (await getSetting(db, 'reminder_time')) || '16:30';
  if (!force && now.time < at) return { ran: false, reason: `尚未到提醒時間 ${at}` };
  // 以條件更新搶「今天的執行權」，避免重複
  const r = await db.run("UPDATE settings SET value = ? WHERE key = 'last_reminder_date' AND value <> ?", [now.date, now.date]);
  if (r.rowCount !== 1) return { ran: false, reason: '今天已執行過' };
  const results = await runReminders(db, now.date);
  console.log(`[提醒] ${now.datetime} 已處理 ${results.length} 筆未取貨提醒`);
  return { ran: true, results };
}

export function startReminderScheduler(db, intervalMs = 30000) {
  const tick = () => reminderTick(db).catch((e) => console.error('[提醒] 排程錯誤', e));
  tick();
  return setInterval(tick, intervalMs);
}
