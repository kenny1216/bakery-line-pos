import { api, esc, money, toast, openDialog, thumbHtml, dateLabel, STATUS_LABEL } from '/js/common.js';

const $ = (id) => document.getElementById(id);
const state = { config: null, products: [], qty: new Map(), date: null, slot: null, view: 'shop', busy: false };

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 無痕模式 */ } },
};

try {
  state.config = await api('/api/public/config');
  document.title = `預訂麵包｜${state.config.store_name}`;
  $('shop-name').textContent = state.config.store_name;
  await signIn();
  await loadShop();
  show('shop');
} catch (e) {
  $('view-loading').innerHTML = `<p class="empty">${esc(e.message)}<br><br><button class="btn" onclick="location.reload()">重新載入</button></p>`;
}

/* ── 身分：LIFF 或測試模式 ── */

async function signIn() {
  let lineName = '';
  let me;
  if (state.config.liff_id) {
    await loadScript('https://static.line-scdn.net/liff/edge/2/sdk.js');
    await window.liff.init({ liffId: state.config.liff_id });
    if (!window.liff.isLoggedIn()) {
      window.liff.login({ redirectUri: location.href });
      await new Promise(() => {}); // 等待跳轉
    }
    me = await api('/api/customer/session', { method: 'POST', body: { idToken: window.liff.getIDToken() } });
    lineName = me.name;
  } else {
    $('mock-bar').hidden = false;
    const id = store.get('mock_line_id') || 'U-test-0001';
    $('mock-id').value = id;
    me = await api('/api/customer/session', { method: 'POST', body: { mockUserId: id } });
  }
  $('name').value = me.name || lineName || '';
  $('phone').value = me.phone || '';
}

$('mock-switch').addEventListener('click', async () => {
  const id = $('mock-id').value.trim();
  try {
    await api('/api/customer/session', { method: 'POST', body: { mockUserId: id } });
    store.set('mock_line_id', id);
    location.reload();
  } catch (e) { toast(e.message, 'error'); }
});

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('無法載入 LINE 元件，請檢查網路'));
    document.head.append(s);
  });
}

/* ── 畫面切換 ── */

function show(view) {
  state.view = view;
  for (const v of ['loading', 'shop', 'done', 'mine']) $(`view-${v}`).hidden = v !== view;
  $('checkout-bar').hidden = view !== 'shop';
  document.querySelectorAll('[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === (view === 'done' ? 'shop' : view)));
  if (view === 'mine') loadMine();
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.view === 'shop' && state.view === 'done') resetShop();
  show(b.dataset.view);
}));

/* ── 商品與取貨 ── */

async function loadShop() {
  state.products = await api('/api/customer/products');
  // 移除已不可訂的商品
  for (const id of state.qty.keys()) if (!state.products.some((p) => p.id === id)) state.qty.delete(id);
  const { pickup_dates: dates, pickup_slots: slots, today } = state.config;
  if (!dates.includes(state.date)) state.date = null;
  $('dates').innerHTML = dates.map((d) => `<button type="button" class="chip ${d === state.date ? 'active' : ''}" data-date="${d}">${d === today ? '今天' : dateLabel(d).split('（')[0]}<small>${d === today ? dateLabel(d).split('（')[0] : `週${dateLabel(d).split('（')[1].replace('）', '')}`}</small></button>`).join('');
  $('slots').innerHTML = slots.map((s) => `<button type="button" class="chip ${s === state.slot ? 'active' : ''}" data-slot="${esc(s)}">${esc(s)}</button>`).join('');
  renderMenu();
  renderBar();
}

function renderMenu() {
  $('menu').innerHTML = state.products.length ? state.products.map((p) => {
    const q = state.qty.get(p.id) || 0;
    return `<div class="card mitem ${q ? 'picked' : ''}">
      ${thumbHtml(p)}
      <div>
        <div class="mname">${esc(p.name)}</div>
        ${p.description ? `<div class="mdesc">${esc(p.description)}</div>` : ''}
        <div class="mfoot">
          <span class="mprice">${money(p.price)}</span>
          ${q ? `<span class="stepper"><button type="button" data-dec="${p.id}" aria-label="減少">−</button><span>${q}</span><button type="button" data-inc="${p.id}" aria-label="增加" ${q >= 99 ? 'disabled' : ''}>+</button></span>`
            : `<button type="button" class="btn btn-sm add-btn" data-inc="${p.id}">加入</button>`}
        </div>
      </div>
    </div>`;
  }).join('') : '<p class="empty">目前沒有開放預訂的商品</p>';
}

$('menu').addEventListener('click', (e) => {
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  if (!inc && !dec) return;
  const id = Number((inc || dec).dataset[inc ? 'inc' : 'dec']);
  const q = (state.qty.get(id) || 0) + (inc ? 1 : -1);
  if (q <= 0) state.qty.delete(id);
  else state.qty.set(id, Math.min(99, q));
  renderMenu();
  renderBar();
});
$('dates').addEventListener('click', (e) => {
  const b = e.target.closest('[data-date]');
  if (!b) return;
  state.date = b.dataset.date;
  $('dates').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
  renderBar();
});
$('slots').addEventListener('click', (e) => {
  const b = e.target.closest('[data-slot]');
  if (!b) return;
  state.slot = b.dataset.slot;
  $('slots').querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', c === b));
  renderBar();
});

function cartItems() {
  return state.products.filter((p) => state.qty.get(p.id)).map((p) => ({ ...p, qty: state.qty.get(p.id) }));
}

function renderBar() {
  const items = cartItems();
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const n = items.reduce((s, i) => s + i.qty, 0);
  $('bar-total').textContent = money(total);
  $('bar-info').textContent = !n ? '尚未選擇商品' : !state.date ? `${n} 件．請選取貨日期` : !state.slot ? `${n} 件．請選取貨時段` : `${n} 件．到店付現`;
  $('submit').disabled = !n || !state.date || !state.slot || state.busy;
}

/* ── 送出 ── */

$('submit').addEventListener('click', () => {
  const name = $('name').value.trim();
  const phone = $('phone').value.trim();
  if (!name) { toast('請填寫姓名', 'error'); $('name').focus(); return; }
  if (!/^[0-9+\-\s()#]{8,20}$/.test(phone)) { toast('請填寫正確的手機號碼', 'error'); $('phone').focus(); return; }
  const items = cartItems();
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const dlg = openDialog({
    title: '確認訂單內容',
    body: `<div class="summary">
      <dl><dt>取貨</dt><dd>${dateLabel(state.date)} ${esc(state.slot)}</dd><dt>姓名</dt><dd>${esc(name)}</dd><dt>電話</dt><dd>${esc(phone)}</dd>
      ${$('note').value.trim() ? `<dt>備註</dt><dd>${esc($('note').value.trim())}</dd>` : ''}</dl>
      <ul>${items.map((i) => `<li><span>${esc(i.name)} ×${i.qty}</span><span class="num">${money(i.price * i.qty)}</span></li>`).join('')}</ul>
      <dl><dt><b>合計</b></dt><dd><b class="num">${money(total)}</b></dd><dt>付款</dt><dd>到店付現</dd></dl>
    </div>`,
    actions: [{ id: 'back', label: '返回修改' }, { id: 'send', label: '送出訂單', cls: 'btn-primary', submit: true }],
  });
  dlg.querySelector('[data-action=back]').addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = dlg.querySelector('[data-action=send]');
    btn.disabled = true;
    state.busy = true;
    try {
      const o = await api('/api/customer/orders', {
        method: 'POST',
        body: { items: items.map((i) => ({ product_id: i.id, qty: i.qty })), pickup_date: state.date, pickup_slot: state.slot, name, phone, note: $('note').value },
      });
      dlg.close();
      showDone(o);
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      if (err.status === 400) loadShop();
    } finally {
      state.busy = false;
      renderBar();
    }
  });
});

function showDone(o) {
  $('view-done').innerHTML = `<div class="done">
    <div class="icon">🥐</div>
    <h2>訂單已送出</h2>
    <p><span class="tag tag-new">待店家確認</span></p>
    <p class="muted">到店付現。店家確認後會以 LINE 通知您${o.notify === 'failed' ? '<br><b style="color:var(--red)">（LINE 通知暫時無法送達，請確認已加入官方帳號好友）</b>' : ''}。</p>
    <div class="card card-pad summary">
      <dl><dt>訂單編號</dt><dd><b>${esc(o.code)}</b></dd><dt>取貨</dt><dd>${dateLabel(o.pickup_date)} ${esc(o.pickup_slot)}</dd></dl>
      <ul>${o.items.map((i) => `<li><span>${esc(i.name)} ×${i.qty}</span><span class="num">${money(i.price * i.qty)}</span></li>`).join('')}</ul>
      <dl><dt><b>合計</b></dt><dd><b class="num">${money(o.total)}</b></dd></dl>
    </div>
    <div class="row" style="justify-content:center;margin-top:20px">
      <button type="button" class="btn" id="to-mine">查看我的訂單</button>
      <button type="button" class="btn btn-primary" id="again">再訂一筆</button>
    </div>
  </div>`;
  $('to-mine').addEventListener('click', () => show('mine'));
  $('again').addEventListener('click', () => { resetShop(); show('shop'); });
  show('done');
}

function resetShop() {
  state.qty.clear();
  $('note').value = '';
  loadShop();
}

/* ── 我的訂單 ── */

async function loadMine() {
  $('view-mine').innerHTML = '<p class="empty">載入中…</p>';
  try {
    const orders = await api('/api/customer/orders');
    $('view-mine').innerHTML = orders.length ? orders.map((o) => `<div class="card my-order">
      <div class="top"><b>${dateLabel(o.pickup_date)} ${esc(o.pickup_slot)}</b><span class="tag tag-${o.status}">${o.status === 'new' ? '待店家確認' : STATUS_LABEL[o.status]}</span></div>
      <div class="items">${o.items.map((i) => `${esc(i.name)} ×${i.qty}`).join('、')}</div>
      <div class="top"><span class="muted small">${esc(o.code)}</span><b class="num">${money(o.total)}</b></div>
      ${o.status === 'new' ? `<div style="margin-top:10px"><button type="button" class="btn btn-sm btn-danger" data-cancel="${o.id}">取消這筆訂單</button></div>` : ''}
    </div>`).join('') : '<p class="empty">還沒有訂單</p>';
  } catch (e) {
    $('view-mine').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}
$('view-mine').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cancel]');
  if (!b || !confirm('確定取消這筆訂單？')) return;
  try {
    await api(`/api/customer/orders/${b.dataset.cancel}/cancel`, { method: 'POST', body: {} });
    toast('已取消');
    loadMine();
  } catch (err) { toast(err.message, 'error'); }
});
