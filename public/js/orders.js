import { api, boot, esc, money, toast, ask, openDialog, todayTaipei, shiftDate, dateLabel, refreshNewBadge, STATUS_LABEL, MSG_STATUS, MSG_KIND } from '/js/common.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const TABS = [
  ['all', '全部'],
  ['new', '待確認（全部日期）'],
  ['confirmed', '已確認・未取貨'],
  ['picked_up', '已取貨'],
  ['cancelled', '已取消'],
];
const state = { date: params.get('date') || todayTaipei(), status: params.get('status') || 'all', data: null, products: null, config: null };

await boot();
state.config = await api('/api/public/config');
$('date').value = state.date;
await load();
setInterval(load, 20000);

$('date').addEventListener('change', () => { if ($('date').value) { state.date = $('date').value; load(); } });
$('prev').addEventListener('click', () => { state.date = shiftDate(state.date, -1); $('date').value = state.date; load(); });
$('next').addEventListener('click', () => { state.date = shiftDate(state.date, 1); $('date').value = state.date; load(); });
$('today').addEventListener('click', () => { state.date = todayTaipei(); $('date').value = state.date; load(); });

async function load() {
  try {
    const status = state.status === 'all' ? '' : state.status;
    state.data = await api(`/api/orders?date=${state.date}&status=${status}`);
    render();
    refreshNewBadge();
    history.replaceState(null, '', `?date=${state.date}&status=${state.status}`);
  } catch (e) {
    toast(e.message, 'error');
  }
}

function render() {
  const { counts, orders } = state.data;
  $('tabs').innerHTML = TABS.map(([k, label]) => {
    const n = k === 'new' ? counts.new_all_dates : counts[k];
    return `<button type="button" role="tab" data-status="${k}" class="${state.status === k ? 'active' : ''}">${label}<span class="count">${n}</span></button>`;
  }).join('');
  $('tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.status = b.dataset.status; load(); }));

  const otherNew = counts.new_all_dates - counts.new;
  $('new-alert').hidden = !(state.status !== 'new' && otherNew > 0);
  $('new-alert').textContent = `另有 ${otherNew} 筆其他日期的新訂單待確認，請切換到「待確認」查看。`;

  if (!orders.length) {
    $('list').innerHTML = `<p class="empty" style="grid-column:1/-1">${state.status === 'new' ? '沒有待確認的訂單 👍' : `${dateLabel(state.date)} 沒有這類訂單`}</p>`;
    return;
  }
  // 依取貨日期＋時段分組
  let html = '';
  let lastGroup = '';
  for (const o of orders) {
    const group = state.status === 'new' ? `${dateLabel(o.pickup_date)} ${o.pickup_slot}` : o.pickup_slot;
    if (group !== lastGroup) {
      html += `<div class="slot-head">${esc(group)}</div>`;
      lastGroup = group;
    }
    html += card(o);
  }
  $('list').innerHTML = html;
}

function card(o) {
  const lastMsg = o.messages.at(-1);
  const failed = o.messages.some((m) => m.status === 'failed');
  let actions = '';
  if (o.status === 'new') {
    actions = `<button class="btn btn-primary" data-act="confirm" data-id="${o.id}">確認訂單</button>
      <button class="btn" data-act="edit" data-id="${o.id}">調整</button>
      <button class="btn btn-danger" data-act="cancel" data-id="${o.id}">取消</button>`;
  } else if (o.status === 'confirmed') {
    actions = `<a class="btn btn-green" href="/pos.html?order=${o.id}">取貨結帳</a>
      <button class="btn" data-act="edit" data-id="${o.id}">調整</button>
      <button class="btn btn-danger" data-act="cancel" data-id="${o.id}">取消</button>`;
  } else if (o.status === 'picked_up' && o.receipt_token) {
    actions = `<a class="btn" href="/r/${esc(o.receipt_token)}" target="_blank" rel="noopener">查看收據</a>`;
  }
  return `<article class="card ocard ${o.status === 'new' ? 'is-new' : ''}">
    <div class="top">
      <div class="grow">
        <div class="who">${esc(o.customer_name)} <a href="tel:${esc(o.customer_phone.replace(/[^\d+]/g, ''))}">${esc(o.customer_phone)}</a></div>
        <div class="muted small">${esc(o.code)}．${dateLabel(o.pickup_date)} ${esc(o.pickup_slot)}</div>
      </div>
      <span class="tag tag-${o.status}">${STATUS_LABEL[o.status]}</span>
    </div>
    <ul class="items">${o.items.map((i) => `<li><span>${esc(i.name)} ×${i.qty}</span><span class="num">${money(i.price * i.qty)}</span></li>`).join('')}</ul>
    <div class="sum"><span>合計（到店付現）</span><span>${money(o.total)}</span></div>
    ${o.note ? `<div class="note">備註：${esc(o.note)}</div>` : ''}
    ${o.status === 'cancelled' && o.cancel_reason ? `<div class="note">取消原因：${esc(o.cancel_reason)}</div>` : ''}
    <div class="msgs">
      ${!o.has_line ? '<span class="tag tag-muted">無 LINE 帳號</span>' : ''}
      ${lastMsg ? `<span>LINE：${MSG_KIND[lastMsg.kind] || lastMsg.kind} ${MSG_STATUS[lastMsg.status] || lastMsg.status}</span>` : ''}
      ${failed ? '<span class="tag tag-red">有通知未送達，請電話聯絡</span>' : ''}
      ${o.reminded_at ? `<span>已於 ${esc(o.reminded_at.slice(11, 16))} 發送取貨提醒</span>` : ''}
    </div>
    ${actions ? `<div class="actions">${actions}</div>` : ''}
  </article>`;
}

$('list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const id = Number(b.dataset.id);
  const o = state.data.orders.find((x) => x.id === id);
  try {
    if (b.dataset.act === 'confirm') {
      b.disabled = true;
      const r = await api(`/api/orders/${id}/confirm`, { method: 'POST', body: {} });
      const m = r.messages.at(-1);
      toast(`已確認 ${r.code}${m ? `，LINE 通知${MSG_STATUS[m.status]}` : ''}`, m?.status === 'failed' ? 'error' : 'ok');
    } else if (b.dataset.act === 'cancel') {
      const reason = await ask({ title: `取消訂單 ${o.code}`, message: `${esc(o.customer_name)} 的訂單將被取消，並以 LINE 通知客人。`, input: { label: '取消原因（會傳給客人）', placeholder: '例如：當日商品已售完' }, okLabel: '確定取消', okCls: 'btn-danger' });
      if (reason === null) return;
      await api(`/api/orders/${id}/cancel`, { method: 'POST', body: { reason } });
      toast(`已取消 ${o.code}`);
    } else if (b.dataset.act === 'edit') {
      await editOrder(o);
      return;
    }
    await load();
  } catch (err) {
    toast(err.message, 'error');
    b.disabled = false;
  }
});

async function editOrder(o) {
  state.products ??= await api('/api/products');
  const qtyOf = new Map(o.items.map((i) => [i.product_id, i.qty]));
  // 已在訂單中的商品＋其他未刪除商品
  const rows = [
    ...o.items.map((i) => ({ id: i.product_id, name: i.name, price: i.price })),
    ...state.products.filter((p) => !qtyOf.has(p.id)).map((p) => ({ id: p.id, name: p.name, price: p.price })),
  ];
  const slots = state.config.pickup_slots.includes(o.pickup_slot) ? state.config.pickup_slots : [o.pickup_slot, ...state.config.pickup_slots];
  const dlg = openDialog({
    title: `調整訂單 ${o.code}`,
    body: `<div class="stack">
      <div class="form-grid">
        <label class="field"><span>取貨日期</span><input class="input" type="date" name="pickup_date" value="${o.pickup_date}" min="${todayTaipei()}"></label>
        <label class="field"><span>取貨時段</span><select class="input" name="pickup_slot">${slots.map((s) => `<option ${s === o.pickup_slot ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      </div>
      <div class="field"><span>商品數量（0 表示移除）</span>
        <div class="edit-items">${rows.map((r) => `<label class="ei"><span>${esc(r.name)} <span class="muted small">${money(r.price)}</span></span><input class="input num" type="number" min="0" max="999" inputmode="numeric" data-pid="${r.id}" value="${qtyOf.get(r.id) || 0}"></label>`).join('')}</div>
      </div>
      <label class="field"><span>備註</span><input class="input" name="note" value="${esc(o.note)}" maxlength="200"></label>
      <label class="switch"><input type="checkbox" name="notify" checked> 以 LINE 通知客人調整內容</label>
    </div>`,
    actions: [{ id: 'cancel', label: '取消' }, { id: 'save', label: '儲存', cls: 'btn-primary', submit: true }],
    wide: true,
  });
  dlg.querySelector('[data-action=cancel]').addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const items = [...f.querySelectorAll('[data-pid]')].map((i) => ({ product_id: Number(i.dataset.pid), qty: Number(i.value) || 0 })).filter((i) => i.qty > 0);
    if (!items.length) { toast('至少需要一項商品；若要取消請使用「取消」', 'error'); return; }
    try {
      await api(`/api/orders/${o.id}`, { method: 'PUT', body: { items, pickup_date: f.pickup_date.value, pickup_slot: f.pickup_slot.value, note: f.note.value, notify: f.notify.checked } });
      toast('訂單已更新', 'ok');
      dlg.close();
      load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}
