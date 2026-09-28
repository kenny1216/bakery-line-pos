import { api, boot, esc, money, toast, ask, todayTaipei, shiftDate, dateLabel, STATUS_LABEL } from '/js/common.js';

const $ = (id) => document.getElementById(id);
let date = new URLSearchParams(location.search).get('date') || todayTaipei();
const me = await boot();
$('date').value = date;
await load();

$('date').addEventListener('change', () => { if ($('date').value) { date = $('date').value; load(); } });
$('prev').addEventListener('click', () => go(shiftDate(date, -1)));
$('next').addEventListener('click', () => go(shiftDate(date, 1)));
$('today').addEventListener('click', () => go(todayTaipei()));
$('print').addEventListener('click', () => window.print());
function go(d) { date = d; $('date').value = d; load(); }

async function load() {
  let r;
  try {
    r = await api(`/api/reports/daily?date=${date}`);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  history.replaceState(null, '', `?date=${date}`);
  $('csv').href = `/api/reports/daily.csv?date=${date}`;
  $('print-title').textContent = `${dateLabel(date)} 每日銷售報表`;
  const s = r.summary;
  const isOwner = me.role === 'owner';
  const voided = r.transactions.filter((t) => t.voided);

  $('report').innerHTML = `
    <div class="stats">
      <div class="card stat"><div class="label">現金總額</div><div class="value">${money(s.cash_total)}</div><div class="sub">不含作廢交易</div></div>
      <div class="card stat"><div class="label">交易筆數</div><div class="value">${s.count}</div><div class="sub">其中預訂取貨 ${s.preorder_count} 筆</div></div>
      <div class="card stat"><div class="label">售出件數</div><div class="value">${s.item_qty}</div></div>
      <div class="card stat"><div class="label">作廢</div><div class="value">${s.void_count}</div><div class="sub">金額 ${money(s.void_total)}</div></div>
    </div>

    <div class="two-col section">
      <section class="card card-pad">
        <h2>商品銷售</h2>
        ${r.products.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>商品</th><th class="n">數量</th><th class="n">金額</th></tr></thead>
          <tbody>${r.products.map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${p.qty}</td><td class="n">${money(p.amount)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">這天沒有銷售</p>'}
      </section>
      <section class="card card-pad">
        <h2>預訂單取貨狀態（取貨日 ${dateLabel(date)}）</h2>
        <div class="row" style="margin-bottom:12px">
          ${Object.entries(r.order_status).map(([k, n]) => `<span class="tag tag-${k}">${STATUS_LABEL[k]} ${n}</span>`).join('')}
        </div>
        ${r.orders.length ? `<div class="table-wrap"><table class="table">
          <thead><tr><th>訂單</th><th>客戶</th><th>時段</th><th>狀態</th><th class="n">金額</th></tr></thead>
          <tbody>${r.orders.map((o) => `<tr><td>${esc(o.code)}</td><td>${esc(o.customer_name)}</td><td>${esc(o.pickup_slot)}</td><td><span class="tag tag-${o.status}">${STATUS_LABEL[o.status]}</span></td><td class="n">${money(o.total)}</td></tr>`).join('')}</tbody>
        </table></div>` : '<p class="muted">這天沒有預訂單</p>'}
      </section>
    </div>

    <section class="card card-pad section">
      <h2>交易明細</h2>
      ${r.transactions.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>時間</th><th>交易編號</th><th>品項</th><th class="n">應收</th><th class="n">實收</th><th class="n">找零</th><th>店員</th><th>狀態</th>${isOwner ? '<th class="no-print"></th>' : ''}</tr></thead>
        <tbody>${r.transactions.map((t) => `<tr class="${t.voided ? 'voided' : ''}">
          <td>${esc(t.created_at.slice(11, 16))}</td>
          <td><a href="/r/${esc(t.receipt_token)}" target="_blank" rel="noopener">${esc(t.code)}</a>${t.order_code ? `<div class="muted small">${esc(t.order_code)}</div>` : ''}</td>
          <td>${t.items.map((i) => `${esc(i.name)}×${i.qty}`).join('、')}</td>
          <td class="n">${money(t.total)}</td><td class="n">${money(t.cash_received)}</td><td class="n">${money(t.change_due)}</td>
          <td>${esc(t.user_name)}</td>
          <td class="keep">${t.voided ? '<span class="tag tag-red">已作廢</span>' : '<span class="tag tag-picked_up">有效</span>'}</td>
          ${isOwner ? `<td class="keep no-print">${t.voided ? '' : `<button class="btn btn-sm btn-danger" data-void="${t.id}" data-code="${esc(t.code)}">作廢</button>`}</td>` : ''}
        </tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">這天沒有交易</p>'}
    </section>

    <section class="card card-pad section">
      <h2>作廢紀錄</h2>
      ${voided.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>交易編號</th><th class="n">金額</th><th>原因</th><th>作廢人</th><th>作廢時間</th></tr></thead>
        <tbody>${voided.map((t) => `<tr><td>${esc(t.code)}</td><td class="n">${money(t.total)}</td><td>${esc(t.void_reason)}</td><td>${esc(t.voided_by)}</td><td>${esc(t.voided_at)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">沒有作廢交易</p>'}
      ${isOwner ? '' : '<p class="muted small">作廢交易需由店主操作。</p>'}
    </section>`;
}

$('report').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-void]');
  if (!b) return;
  const reason = await ask({
    title: `作廢交易 ${b.dataset.code}`,
    message: '作廢後金額不計入當日總額，但交易與作廢紀錄都會保留在報表中。若為預訂單，訂單會退回「已確認」。',
    input: { label: '作廢原因（必填）', placeholder: '例如：數量輸入錯誤，重新結帳', required: true },
    okLabel: '確定作廢', okCls: 'btn-danger',
  });
  if (!reason) return;
  try {
    await api(`/api/transactions/${b.dataset.void}/void`, { method: 'POST', body: { reason } });
    toast('已作廢', 'ok');
    load();
  } catch (err) {
    toast(err.message, 'error');
  }
});
