// 店員端共用：API、登入檢查、導覽列、提示、對話框

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error || `錯誤 ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const money = (n) => `$${Number(n || 0).toLocaleString('en-US')}`;

export const STATUS_LABEL = { new: '新訂單', confirmed: '已確認', picked_up: '已取貨', cancelled: '已取消' };
export const MSG_STATUS = { sent: '已送達', failed: '傳送失敗', mock: '模擬傳送', skipped: '未傳送' };
export const MSG_KIND = { order_received: '收到訂單', order_confirmed: '訂單確認', order_updated: '訂單調整', order_cancelled: '訂單取消', receipt: '電子收據', reminder: '取貨提醒' };

export function todayTaipei(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function shiftDate(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
export function dateLabel(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}（${WEEK[d.getUTCDay()]}）`;
}

export function toast(msg, type = '') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.setAttribute('role', 'status');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  host.append(el);
  setTimeout(() => el.remove(), type === 'error' ? 5000 : 2600);
}

export function thumbHtml(p) {
  return p.image
    ? `<div class="thumb"><img src="${esc(p.image)}" alt="" loading="lazy"></div>`
    : `<div class="thumb"><span class="initial">${esc([...p.name][0] || '?')}</span></div>`;
}

/** 開啟對話框，回傳 dialog 元素；footer 按鈕以 data-action 區分 */
export function openDialog({ title, body, actions = [], wide = false, onOpen }) {
  const dlg = document.createElement('dialog');
  if (wide) dlg.style.width = 'min(760px, calc(100vw - 24px))';
  dlg.innerHTML = `
    <form method="dialog" class="dialog-form" novalidate>
      <div class="dialog-head"><h3>${esc(title)}</h3><button class="btn btn-ghost btn-sm" value="cancel" aria-label="關閉">✕</button></div>
      <div class="dialog-body">${body}</div>
      ${actions.length ? `<div class="dialog-foot">${actions.map((a) => `<button type="${a.submit ? 'submit' : 'button'}" class="btn ${a.cls || ''}" data-action="${a.id}" value="${a.id}">${esc(a.label)}</button>`).join('')}</div>` : ''}
    </form>`;
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  onOpen?.(dlg);
  return dlg;
}

/** 簡單的確認或輸入對話框，回傳 Promise */
export function ask({ title, message = '', input = null, okLabel = '確定', okCls = 'btn-primary' }) {
  return new Promise((resolve) => {
    const dlg = openDialog({
      title,
      body: `${message ? `<p style="margin-top:0">${message}</p>` : ''}${input ? `<label class="field"><span>${esc(input.label)}</span><input class="input" name="v" value="${esc(input.value || '')}" placeholder="${esc(input.placeholder || '')}" autocomplete="off"></label>` : ''}`,
      actions: [{ id: 'cancel', label: '取消' }, { id: 'ok', label: okLabel, cls: okCls, submit: true }],
    });
    const field = dlg.querySelector('input[name=v]');
    field?.focus();
    let done = false;
    dlg.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (input?.required && !field.value.trim()) { field.focus(); return; }
      done = true;
      resolve(input ? field.value.trim() : true);
      dlg.close();
    });
    dlg.querySelector('[data-action=cancel]').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => { if (!done) resolve(null); });
  });
}

const NAV = [
  { href: '/pos.html', label: '收銀 POS' },
  { href: '/orders.html', label: '訂單看板', badge: true },
  { href: '/reports.html', label: '每日報表' },
  { href: '/products.html', label: '商品管理', owner: true },
  { href: '/settings.html', label: '設定', owner: true },
];

/** 檢查登入並畫出導覽列；ownerOnly 頁面店員會被導回 POS */
export async function boot({ ownerOnly = false } = {}) {
  let me;
  try {
    me = await api('/api/me');
  } catch (e) {
    if (e.status === 401) location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`;
    throw e;
  }
  if (ownerOnly && me.role !== 'owner') {
    location.href = '/pos.html';
    throw new Error('forbidden');
  }
  const header = document.createElement('header');
  header.className = 'topbar';
  header.innerHTML = `
    <div class="brand">${esc(me.store_name)}</div>
    <nav aria-label="主選單">${NAV.filter((n) => !n.owner || me.role === 'owner').map((n) =>
      `<a href="${n.href}" class="${location.pathname === n.href ? 'active' : ''}">${n.label}${n.badge ? '<span class="badge-dot" id="nav-new-badge" hidden></span>' : ''}</a>`).join('')}</nav>
    <div class="who"><span class="name">${esc(me.name)}（${me.role === 'owner' ? '店主' : '店員'}）</span><button type="button" id="logout">登出</button></div>`;
  document.body.prepend(header);
  header.querySelector('#logout').addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: {} });
    location.href = '/login.html';
  });
  refreshNewBadge();
  setInterval(refreshNewBadge, 30000);
  return me;
}

export async function refreshNewBadge() {
  try {
    const counts = await api(`/api/orders/counts?date=${todayTaipei()}`);
    const b = document.getElementById('nav-new-badge');
    if (!b) return;
    b.hidden = !counts.new_all_dates;
    b.textContent = counts.new_all_dates;
  } catch { /* 忽略 */ }
}
