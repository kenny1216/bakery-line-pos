import { api, boot, esc, money, toast, thumbHtml, openDialog, todayTaipei, refreshNewBadge } from '/js/common.js';

const $ = (id) => document.getElementById(id);
const state = {
  products: [],
  cart: [], // { product_id, name, price, qty }
  order: null, // 轉入結帳的預訂單
  orders: [],
  busy: false,
};

await boot();
await loadProducts();
await loadOrders();

const preset = new URLSearchParams(location.search).get('order');
if (preset) {
  try {
    loadOrderIntoCart(await api(`/api/orders/${encodeURIComponent(preset)}`));
  } catch (e) {
    toast(e.message, 'error');
  }
  history.replaceState(null, '', '/pos.html');
}
render();
setInterval(loadOrders, 30000);

/* ── 資料 ── */

async function loadProducts() {
  state.products = (await api('/api/products')).filter((p) => !p.paused);
  renderProducts();
}

async function loadOrders() {
  try {
    const { orders } = await api(`/api/orders?date=${todayTaipei()}`);
    state.orders = orders.filter((o) => o.status === 'new' || o.status === 'confirmed');
    $('order-count').textContent = state.orders.length ? state.orders.length : '';
    renderOrders();
  } catch { /* 下次再試 */ }
}

/* ── 分頁 ── */

document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $('tab-products').hidden = b.dataset.tab !== 'products';
  $('tab-orders').hidden = b.dataset.tab !== 'orders';
  if (b.dataset.tab === 'orders') loadOrders();
}));

/* ── 商品格 ── */

function renderProducts() {
  const grid = $('product-grid');
  if (!state.products.length) {
    grid.innerHTML = '<p class="empty">還沒有可販售的商品，請店主到「商品管理」新增。</p>';
    return;
  }
  grid.innerHTML = state.products.map((p) => {
    const inCart = state.cart.find((c) => c.product_id === p.id)?.qty;
    return `<button type="button" class="product-btn" data-pid="${p.id}">
      ${thumbHtml(p)}
      <span class="pname">${esc(p.name)}</span>
      <span class="pprice">${money(p.price)}</span>
      ${inCart ? `<span class="in-cart">${inCart}</span>` : ''}
    </button>`;
  }).join('');
}

$('product-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pid]');
  if (!btn) return;
  const p = state.products.find((x) => x.id === Number(btn.dataset.pid));
  const line = state.cart.find((c) => c.product_id === p.id);
  if (line) line.qty = Math.min(999, line.qty + 1);
  else state.cart.push({ product_id: p.id, name: p.name, price: p.price, qty: 1 });
  render();
});

/* ── 預訂單 ── */

function renderOrders() {
  const q = $('order-search').value.trim().toLowerCase();
  const list = state.orders.filter((o) => !q || o.customer_name.toLowerCase().includes(q) || o.customer_phone.replace(/\D/g, '').includes(q.replace(/\D/g, '') || '§') || o.code.toLowerCase().includes(q));
  $('order-list').innerHTML = list.length ? list.map((o) => `
    <button type="button" class="card order-pick" data-oid="${o.id}">
      <span class="who">${esc(o.customer_name)} <span class="muted small">${esc(o.customer_phone)}</span></span>
      <span class="amt">${money(o.total)}</span>
      <span class="small"><span class="tag tag-${o.status}">${o.status === 'new' ? '待確認' : '已確認'}</span> ${esc(o.pickup_slot)}．${esc(o.code)}</span>
      <span></span>
      <span class="items">${o.items.map((i) => `${esc(i.name)} ×${i.qty}`).join('、')}${o.note ? `｜備註：${esc(o.note)}` : ''}</span>
    </button>`).join('') : `<p class="empty">${q ? '找不到符合的訂單' : '今天沒有待取貨的預訂單'}</p>`;
}
$('order-search').addEventListener('input', renderOrders);
$('order-list').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-oid]');
  if (!btn) return;
  const o = state.orders.find((x) => x.id === Number(btn.dataset.oid));
  if (state.cart.length && !state.order && !confirm('購物清單已有商品，要改為結帳這筆預訂單嗎？（目前清單會清空）')) return;
  loadOrderIntoCart(o);
  document.querySelector('[data-tab=products]').click();
  render();
  openCartOnMobile();
});

function loadOrderIntoCart(o) {
  if (o.status !== 'new' && o.status !== 'confirmed') {
    toast(`這筆訂單目前是「${o.status === 'picked_up' ? '已取貨' : '已取消'}」，無法結帳`, 'error');
    return;
  }
  state.order = o;
  state.cart = o.items.map((i) => ({ product_id: i.product_id, name: i.name, price: i.price, qty: i.qty }));
  $('cash').value = '';
}

/* ── 購物清單 ── */

function total() {
  return state.cart.reduce((s, i) => s + i.price * i.qty, 0);
}
function cashValue() {
  const v = $('cash').value.replace(/[^\d]/g, '');
  return v === '' ? null : Number(v);
}

function render() {
  const items = $('cart-items');
  items.innerHTML = state.cart.length ? state.cart.map((c, idx) => `
    <li>
      <div><div class="cname">${esc(c.name)}</div><div class="cprice">${money(c.price)}</div></div>
      <div class="qty"><button type="button" data-dec="${idx}" aria-label="減少">−</button><span>${c.qty}</span><button type="button" data-inc="${idx}" aria-label="增加">+</button></div>
      <div class="sub">${money(c.price * c.qty)}</div>
    </li>`).join('') : '<li class="cart-empty">點選左側商品加入</li>';

  const banner = $('order-banner');
  banner.hidden = !state.order;
  if (state.order) {
    const o = state.order;
    banner.innerHTML = `<div class="grow"><b>預訂單 ${esc(o.code)}</b><br>${esc(o.customer_name)}．${esc(o.customer_phone)}．${esc(o.pickup_slot)}${o.has_line ? '．結帳後以 LINE 傳收據' : ''}</div>
      <button type="button" class="btn btn-sm" id="drop-order">解除</button>`;
    $('drop-order').addEventListener('click', clearCart);
  }

  const due = total();
  const qty = state.cart.reduce((s, i) => s + i.qty, 0);
  $('due').textContent = money(due);
  $('bar-total').textContent = money(due);
  $('bar-qty').textContent = qty;
  const cash = cashValue();
  const changeRow = $('change').parentElement;
  if (cash === null || !state.cart.length) {
    $('change').textContent = '—';
    changeRow.classList.remove('short');
  } else if (cash < due) {
    $('change').textContent = `還差 ${money(due - cash)}`;
    changeRow.classList.add('short');
  } else {
    $('change').textContent = money(cash - due);
    changeRow.classList.remove('short');
  }
  $('checkout').disabled = state.busy || !state.cart.length || cash === null || cash < due;
  renderProducts();
}

$('cart-items').addEventListener('click', (e) => {
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  if (inc) {
    const c = state.cart[inc.dataset.inc];
    c.qty = Math.min(999, c.qty + 1);
  } else if (dec) {
    const i = Number(dec.dataset.dec);
    state.cart[i].qty -= 1;
    if (state.cart[i].qty <= 0) state.cart.splice(i, 1);
  } else return;
  render();
});

function clearCart() {
  state.cart = [];
  state.order = null;
  $('cash').value = '';
  render();
}
$('cart-clear').addEventListener('click', () => {
  if (state.cart.length && !confirm('確定清空這次的購物清單？')) return;
  clearCart();
});

/* ── 收款 ── */

$('cash').addEventListener('input', () => {
  $('cash').value = $('cash').value.replace(/[^\d]/g, '').slice(0, 7);
  render();
});
$('quick-cash').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cash]');
  if (!b) return;
  $('cash').value = b.dataset.cash === 'exact' ? total() : b.dataset.cash;
  render();
});
$('keypad').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const cur = $('cash').value;
  $('cash').value = b.dataset.key === 'back' ? cur.slice(0, -1) : (cur + b.textContent).replace(/^0+(?=\d)/, '').slice(0, 7);
  render();
});
$('cash').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('checkout').disabled) $('checkout').click();
});

$('checkout').addEventListener('click', async () => {
  if (state.busy) return;
  state.busy = true;
  render();
  try {
    const t = await api('/api/transactions', {
      method: 'POST',
      body: {
        items: state.cart.map(({ product_id, qty }) => ({ product_id, qty })),
        cash_received: cashValue(),
        order_id: state.order?.id,
      },
    });
    showDone(t);
    clearCart();
    closeCartOnMobile();
    loadOrders();
    refreshNewBadge();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    state.busy = false;
    render();
  }
});

/* ── 交易完成 ── */

function showDone(t) {
  const url = `${location.origin}/r/${t.receipt_token}`;
  const lineNote = {
    none: '<span class="muted">門市交易：請客人掃描 QR Code 取得電子收據</span>',
    sent: '<span class="tag tag-picked_up">LINE 收據已送達</span>',
    mock: '<span class="tag tag-confirmed">LINE 收據（模擬傳送）</span>',
    skipped: '<span class="tag tag-muted">客人沒有 LINE 帳號，未傳送</span>',
    failed: '<span class="tag tag-red">LINE 收據傳送失敗，請讓客人掃 QR Code</span>',
  }[t.receipt_status] || '';
  const dlg = openDialog({
    title: '交易完成',
    body: `
      <div class="done-change"><div class="label">找零</div><div class="value">${money(t.change_due)}</div>
        <div class="muted num">應收 ${money(t.total)}．實收 ${money(t.cash_received)}</div></div>
      <div class="done-grid">
        <div class="stack small">
          <div><b>${esc(t.code)}</b>${t.order_code ? `<br>預訂單 ${esc(t.order_code)}（已取貨）` : ''}</div>
          <div>${lineNote}</div>
          <div><a href="${esc(url)}" target="_blank" rel="noopener">開啟電子收據</a></div>
        </div>
        <div class="qr-box" id="qr" aria-label="電子收據 QR Code"></div>
      </div>`,
    actions: [
      { id: 'print', label: '列印收據' },
      { id: 'next', label: '下一位客人', cls: 'btn-primary', submit: true },
    ],
  });
  dlg.querySelector('[data-action=print]').addEventListener('click', () => window.open(`${url}?print=1`, '_blank', 'noopener'));
  dlg.querySelector('[data-action=next]').focus();
  drawQr(dlg.querySelector('#qr'), url);
}

let qrLib;
async function drawQr(el, text) {
  try {
    qrLib ??= new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
      s.onload = () => resolve(window.QRCode);
      s.onerror = reject;
      document.head.append(s);
    });
    const QR = await qrLib;
    new QR(el, { text, width: 118, height: 118, correctLevel: QR.CorrectLevel.M });
  } catch {
    el.innerHTML = '<span class="muted small">QR Code 需要網路</span>';
  }
}

/* ── 手機版結帳欄 ── */

function openCartOnMobile() { $('cart').classList.add('open'); }
function closeCartOnMobile() { $('cart').classList.remove('open'); }
$('cart-bar').addEventListener('click', openCartOnMobile);
$('cart-collapse').addEventListener('click', closeCartOnMobile);
