import { api, boot, esc, toast, openDialog, MSG_STATUS, MSG_KIND } from '/js/common.js';

const $ = (id) => document.getElementById(id);
let users = [];
const me = await boot({ ownerOnly: true });
let settings = await api('/api/settings');
fill();
loadUsers();
loadMsgs();

function fill() {
  for (const form of document.querySelectorAll('#store-form, #pickup-form, #line-form')) {
    for (const el of form.elements) if (el.name && settings[el.name] !== undefined) el.value = settings[el.name];
  }
  const live = settings.line_channel_token;
  $('line-mode').innerHTML = live
    ? '已設定 Channel access token，訊息會實際傳送到客戶 LINE。'
    : '<b>目前為模擬模式：</b>未設定 Channel access token，所有 LINE 訊息只記錄在下方「發送紀錄」，方便先測試流程。';
  $('liff-url').textContent = settings.liff_id ? `https://liff.line.me/${settings.liff_id}` : `${settings.public_base_url || location.origin}/order.html`;
  const locked = settings.env_locked || [];
  for (const el of document.querySelectorAll('#line-form [name]')) {
    el.disabled = locked.includes(el.name);
    if (el.disabled) el.title = '由主機環境變數設定';
  }
  $('env-note').hidden = !locked.length;
  $('env-note').textContent = '灰色欄位由主機的環境變數設定，請到雲端主機的專案設定修改。';
  if (settings.hosting === 'vercel') {
    $('cron-note').hidden = false;
    $('cron-note').textContent = settings.cron_configured
      ? '雲端版由排程服務呼叫提醒：若只用 Vercel 內建排程，提醒會在每天 17:00–18:00 之間送出；要準時在設定時間送出，請依 README 設定外部排程。'
      : '尚未設定 CRON_SECRET，雲端自動提醒不會執行。';
  }
  $('last-reminder').textContent = settings.last_reminder_date ? `上次自動提醒：${settings.last_reminder_date}` : '';
}

for (const id of ['store-form', 'pickup-form', 'line-form']) {
  $(id).addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = {};
    for (const el of e.target.elements) if (el.name) body[el.name] = el.value;
    try {
      settings = await api('/api/settings', { method: 'PUT', body });
      fill();
      toast('已儲存', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

$('run-reminders').addEventListener('click', async (e) => {
  e.target.disabled = true;
  try {
    const { results } = await api('/api/reminders/run', { method: 'POST', body: {} });
    toast(results.length ? `已對 ${results.length} 筆訂單發送提醒` : '沒有需要提醒的訂單（已提醒過的不會重發）', 'ok');
    loadMsgs();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    e.target.disabled = false;
  }
});

/* ── 帳號 ── */

async function loadUsers() {
  users = await api('/api/users');
  $('users').innerHTML = users.map((u) => `<tr>
    <td>${esc(u.username)}</td><td>${esc(u.name)}</td>
    <td>${u.role === 'owner' ? '店主' : '店員'}</td>
    <td>${u.active ? '<span class="tag tag-picked_up">啟用</span>' : '<span class="tag tag-muted">停用</span>'}</td>
    <td class="n"><button class="btn btn-sm" data-user="${u.id}">編輯</button></td></tr>`).join('');
}
$('users').addEventListener('click', (e) => {
  const b = e.target.closest('[data-user]');
  if (b) editUser(users.find((u) => u.id === Number(b.dataset.user)));
});
$('add-user').addEventListener('click', () => editUser(null));

function editUser(u) {
  const self = u?.id === me.id;
  const dlg = openDialog({
    title: u ? `編輯帳號：${u.username}` : '新增帳號',
    body: `<div class="stack">
      ${u ? '' : '<label class="field"><span>帳號（英數字）</span><input class="input" name="username" required autocomplete="off"></label>'}
      <label class="field"><span>姓名</span><input class="input" name="person" required value="${esc(u?.name || '')}"></label>
      <label class="field"><span>角色</span><select class="input" name="role" ${self ? 'disabled' : ''}>
        <option value="staff" ${u?.role === 'staff' || !u ? 'selected' : ''}>店員</option>
        <option value="owner" ${u?.role === 'owner' ? 'selected' : ''}>店主</option></select></label>
      <label class="field"><span>${u ? '新密碼（不改請留空）' : '密碼（至少 6 碼）'}</span><input class="input" name="password" type="password" autocomplete="new-password"></label>
      ${u && !self ? `<label class="switch"><input type="checkbox" name="active" ${u.active ? 'checked' : ''}> 帳號啟用</label>` : ''}
    </div>`,
    actions: [{ id: 'cancel', label: '取消' }, { id: 'save', label: '儲存', cls: 'btn-primary', submit: true }],
  });
  dlg.querySelector('[data-action=cancel]').addEventListener('click', () => dlg.close());
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const body = { name: f.namedItem('person').value };
    if (!self) body.role = f.namedItem('role').value;
    if (f.namedItem('password').value) body.password = f.namedItem('password').value;
    if (u && !self) body.active = f.namedItem('active').checked;
    try {
      if (u) await api(`/api/users/${u.id}`, { method: 'PUT', body });
      else await api('/api/users', { method: 'POST', body: { ...body, username: f.namedItem('username').value } });
      toast('已儲存', 'ok');
      dlg.close();
      loadUsers();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/* ── 發送紀錄 ── */

async function loadMsgs() {
  const msgs = await api('/api/line-messages');
  const cls = { sent: 'tag-picked_up', failed: 'tag-red', mock: 'tag-confirmed', skipped: 'tag-muted' };
  $('msgs').innerHTML = msgs.length ? msgs.map((m) => `<tr>
    <td class="num" style="white-space:nowrap">${esc(m.created_at.slice(5, 16))}</td>
    <td>${MSG_KIND[m.kind] || esc(m.kind)}</td>
    <td>${esc(m.customer_name || '')}${m.order_code ? `<div class="muted small">${esc(m.order_code)}</div>` : ''}</td>
    <td><span class="tag ${cls[m.status] || ''}">${MSG_STATUS[m.status] || esc(m.status)}</span>${m.error ? `<div class="small" style="color:var(--red)">${esc(m.error)}</div>` : ''}</td>
    <td><div class="msg-text">${esc(m.text)}</div></td></tr>`).join('') : '<tr><td colspan="5" class="muted">還沒有發送紀錄</td></tr>';
}
$('reload-msgs').addEventListener('click', loadMsgs);
