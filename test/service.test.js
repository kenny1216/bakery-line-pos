import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setSetting, getSetting } from '../lib/db.js';
import * as svc from '../lib/service.js';
import { taipeiNow, addDays } from '../lib/util.js';

let db;
const owner = { id: 1, name: '店主', role: 'owner' };
const staff = { id: 2, name: '店員', role: 'staff' };
const today = taipeiNow().date;
const slot = '上午 09:00–12:00';

before(async () => {
  db = await openDb({ url: '', dataDir: null }); // 記憶體內的 PGlite
});
after(() => db.close());

const products = () => svc.listProducts(db);

async function newOrder(lineId, items, date = today) {
  const c = await svc.upsertCustomer(db, lineId);
  return svc.createCustomerOrder(db, c.id, { name: '王小明', phone: '0912345678', pickup_date: date, pickup_slot: slot, items });
}

test('初始資料：預設帳號與商品已寫入資料庫（密碼為雜湊）', async () => {
  const users = await db.all('SELECT username, role, pw_hash FROM users ORDER BY id');
  assert.deepEqual(users.map((u) => [u.username, u.role]), [['owner', 'owner'], ['staff', 'staff']]);
  assert.ok(users.every((u) => !u.pw_hash.includes('1234')));
  assert.equal((await products()).length, 8);
});

test('現金結帳：應收、找零、10 筆交易與報表一致', async () => {
  const [a, b, c] = await products();
  let expected = 0;
  for (let i = 1; i <= 10; i += 1) {
    const items = [{ product_id: a.id, qty: i }, { product_id: b.id, qty: i % 3 }, { product_id: c.id, qty: 1 }].filter((x) => x.qty > 0);
    const price = new Map((await products()).map((p) => [p.id, p.price]));
    const due = items.reduce((s, it) => s + price.get(it.product_id) * it.qty, 0);
    const t = await svc.checkout(db, staff, { items, cash_received: due + 7 * i }, '');
    assert.equal(t.total, due);
    assert.equal(t.change_due, 7 * i);
    expected += due;
  }
  const r = await svc.dailyReport(db, today);
  assert.equal(r.summary.count, 10);
  assert.equal(r.summary.cash_total, expected);
  assert.equal(new Set(r.transactions.map((t) => t.code)).size, 10);
});

test('同時結帳不會拿到重複的交易編號', async () => {
  const [a] = await products();
  const results = await Promise.all(Array.from({ length: 5 }, () => svc.checkout(db, staff, { items: [{ product_id: a.id, qty: 1 }], cash_received: 1000 }, '')));
  assert.equal(new Set(results.map((t) => t.code)).size, 5);
});

test('實收不足時不能完成交易', async () => {
  const [a] = await products();
  await assert.rejects(svc.checkout(db, staff, { items: [{ product_id: a.id, qty: 2 }], cash_received: a.price }, ''), /實收金額不足/);
});

test('暫停販售的商品無法結帳也無法預訂', async () => {
  const p = await svc.createProduct(db, { name: '測試暫停', price: 10 });
  await svc.updateProduct(db, p.id, { paused: true });
  await assert.rejects(svc.checkout(db, staff, { items: [{ product_id: p.id, qty: 1 }], cash_received: 10 }, ''), /暫停販售/);
  await assert.rejects(newOrder('U-test-p', [{ product_id: p.id, qty: 1 }]), /暫停預訂/);
});

test('作廢：金額不計入總額、保留紀錄；預訂單退回已確認', async () => {
  const before = (await svc.dailyReport(db, today)).summary;
  const [a] = await products();
  const o = await newOrder('U-test-void', [{ product_id: a.id, qty: 2 }]);
  await svc.confirmOrder(db, o.id);
  const t = await svc.checkout(db, staff, { items: [{ product_id: a.id, qty: 2 }], cash_received: 500, order_id: o.id }, '');
  assert.equal((await svc.getOrder(db, o.id)).status, 'picked_up');
  await assert.rejects(svc.voidTransaction(db, owner, t.id, ''), /作廢原因/);
  await svc.voidTransaction(db, owner, t.id, '輸入錯誤');
  const after = await svc.dailyReport(db, today);
  assert.equal(after.summary.cash_total, before.cash_total);
  assert.equal(after.summary.void_count, before.void_count + 1);
  assert.ok(after.transactions.some((x) => x.id === t.id && x.voided && x.void_reason === '輸入錯誤'));
  assert.equal((await svc.getOrder(db, o.id)).status, 'confirmed');
});

test('訂單流程：新訂單→確認→結帳取貨，LINE 訊息以模擬模式記錄', async () => {
  const [a, b] = await products();
  const o = await newOrder('U-test-flow', [{ product_id: a.id, qty: 1 }, { product_id: b.id, qty: 2 }]);
  assert.equal(o.status, 'new');
  assert.equal(o.total, a.price + b.price * 2);
  assert.equal(o.messages.at(-1).status, 'mock');
  const c = await svc.confirmOrder(db, o.id);
  assert.equal(c.status, 'confirmed');
  await assert.rejects(svc.confirmOrder(db, o.id), /無法確認/);
  // 下單後改價，不影響訂單結帳金額
  await svc.updateProduct(db, a.id, { price: a.price + 100 });
  const t = await svc.checkout(db, staff, { items: [{ product_id: a.id, qty: 1 }, { product_id: b.id, qty: 2 }], cash_received: 1000, order_id: o.id }, 'http://x');
  await svc.updateProduct(db, a.id, { price: a.price });
  assert.equal(t.total, o.total);
  assert.equal(t.receipt_status, 'mock');
  const receipt = (await db.one("SELECT text FROM line_messages WHERE kind = 'receipt' AND transaction_id = ?", [t.id])).text;
  assert.match(receipt, new RegExp(t.code));
  assert.match(receipt, /付款方式 現金/);
  assert.equal((await svc.dailyReport(db, today)).orders.find((x) => x.id === o.id).status, 'picked_up');
});

test('關閉「收到訂單」通知時不發該則訊息', async () => {
  const [a] = await products();
  await setSetting(db, 'line_notify_received', '0');
  const o = await newOrder('U-test-quiet', [{ product_id: a.id, qty: 1 }]);
  await setSetting(db, 'line_notify_received', '1');
  assert.equal(o.messages.length, 0);
});

test('未取貨提醒：只提醒當日、已確認、未取貨，且每筆只發一次', async () => {
  const [a] = await products();
  const confirmed = await newOrder('U-test-r1', [{ product_id: a.id, qty: 1 }]);
  await svc.confirmOrder(db, confirmed.id);
  const unconfirmed = await newOrder('U-test-r2', [{ product_id: a.id, qty: 1 }]);
  const cancelled = await newOrder('U-test-r3', [{ product_id: a.id, qty: 1 }]);
  await svc.confirmOrder(db, cancelled.id);
  await svc.cancelOrder(db, cancelled.id, '售完');
  const pickedUp = await newOrder('U-test-r4', [{ product_id: a.id, qty: 1 }]);
  await svc.confirmOrder(db, pickedUp.id);
  await svc.checkout(db, staff, { items: [{ product_id: a.id, qty: 1 }], cash_received: 1000, order_id: pickedUp.id }, '');
  const tomorrow = await newOrder('U-test-r5', [{ product_id: a.id, qty: 1 }], addDays(today, 1));
  await svc.confirmOrder(db, tomorrow.id);

  const first = await svc.runReminders(db, today);
  const ids = first.map((r) => r.order_id);
  assert.ok(ids.includes(confirmed.id));
  for (const o of [unconfirmed, cancelled, pickedUp, tomorrow]) assert.ok(!ids.includes(o.id));
  assert.equal((await svc.runReminders(db, today)).length, 0);
});

test('排程檢查：未到時間不執行，到時間只執行一次', async () => {
  await setSetting(db, 'last_reminder_date', '');
  await setSetting(db, 'reminder_time', '23:59');
  const early = await svc.reminderTick(db);
  if (taipeiNow().time < '23:59') assert.equal(early.ran, false);
  await setSetting(db, 'reminder_time', '00:00');
  const first = await svc.reminderTick(db);
  const second = await svc.reminderTick(db);
  assert.equal(first.ran, true);
  assert.equal(second.ran, false);
  assert.equal(await getSetting(db, 'last_reminder_date'), today);
});

test('客戶只能取消尚未確認的訂單', async () => {
  const [a] = await products();
  const o = await newOrder('U-test-c', [{ product_id: a.id, qty: 1 }]);
  await svc.confirmOrder(db, o.id);
  await assert.rejects(svc.cancelOrder(db, o.id, '', { byCustomer: true }), /已確認/);
});

test('取貨日期與時段需在允許範圍內', async () => {
  const [a] = await products();
  await setSetting(db, 'max_advance_days', '3');
  const c = await svc.upsertCustomer(db, 'U-test-d');
  await assert.rejects(svc.createCustomerOrder(db, c.id, { name: 'A', phone: '0912345678', pickup_date: '2000-01-01', pickup_slot: slot, items: [{ product_id: a.id, qty: 1 }] }), /取貨日期/);
  await assert.rejects(svc.createCustomerOrder(db, c.id, { name: 'A', phone: '0912345678', pickup_date: today, pickup_slot: '半夜', items: [{ product_id: a.id, qty: 1 }] }), /時段/);
});
