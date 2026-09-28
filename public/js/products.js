import { api, boot, esc, money, toast, ask, openDialog, thumbHtml } from '/js/common.js';

const $ = (id) => document.getElementById(id);
let products = [];

await boot({ ownerOnly: true });
await load();

async function load() {
  products = await api('/api/products');
  $('list').innerHTML = products.length ? products.map((p) => `
    <div class="card prow ${p.paused ? 'paused' : ''}">
      ${thumbHtml(p)}
      <div class="info">
        <div class="name">${esc(p.name)}</div>
        <div class="price">${money(p.price)}</div>
        ${p.description ? `<div class="muted small">${esc(p.description)}</div>` : ''}
      </div>
      <div class="toggles">
        <label class="switch"><input type="checkbox" data-toggle="preorderable" data-id="${p.id}" ${p.preorderable ? 'checked' : ''}> 開放預訂</label>
        <label class="switch"><input type="checkbox" data-toggle="paused" data-id="${p.id}" ${p.paused ? 'checked' : ''}> 暫停販售</label>
        <button class="btn btn-sm" data-edit="${p.id}">編輯</button>
      </div>
    </div>`).join('') : '<p class="empty">還沒有商品</p>';
}

$('list').addEventListener('change', async (e) => {
  const t = e.target.closest('[data-toggle]');
  if (!t) return;
  try {
    await api(`/api/products/${t.dataset.id}`, { method: 'PUT', body: { [t.dataset.toggle]: t.checked } });
    toast('已更新', 'ok');
    load();
  } catch (err) {
    toast(err.message, 'error');
    t.checked = !t.checked;
  }
});
$('list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-edit]');
  if (b) edit(products.find((p) => p.id === Number(b.dataset.edit)));
});
$('add').addEventListener('click', () => edit(null));

function edit(p) {
  let image = p?.image || null;
  const dlg = openDialog({
    title: p ? `編輯：${p.name}` : '新增商品',
    body: `<div class="stack">
      <div class="img-pick">
        <div id="img-preview"></div>
        <div class="stack">
          <label class="btn btn-sm" style="width:max-content">選擇照片<input type="file" accept="image/*" id="img-file" hidden></label>
          <button type="button" class="btn btn-sm btn-ghost" id="img-clear" style="width:max-content">移除照片</button>
        </div>
      </div>
      <div class="form-grid">
        <label class="field"><span>商品名稱</span><input class="input" name="name" required maxlength="30" value="${esc(p?.name || '')}"></label>
        <label class="field"><span>售價（元）</span><input class="input num" name="price" type="number" min="0" max="100000" inputmode="numeric" required value="${p?.price ?? ''}"></label>
      </div>
      <label class="field"><span>簡短說明（顯示在訂購頁，可空白）</span><input class="input" name="description" maxlength="100" value="${esc(p?.description || '')}"></label>
      <label class="field"><span>排序（數字小的排前面）</span><input class="input num" name="sort" type="number" value="${p?.sort ?? ''}" placeholder="自動"></label>
      <div class="row" style="gap:20px">
        <label class="switch"><input type="checkbox" name="preorderable" ${!p || p.preorderable ? 'checked' : ''}> 開放 LINE 預訂</label>
        <label class="switch"><input type="checkbox" name="paused" ${p?.paused ? 'checked' : ''}> 暫停販售</label>
      </div>
    </div>`,
    actions: [
      ...(p ? [{ id: 'delete', label: '刪除商品', cls: 'btn-danger' }] : []),
      { id: 'cancel', label: '取消' },
      { id: 'save', label: '儲存', cls: 'btn-primary', submit: true },
    ],
  });
  const preview = () => { dlg.querySelector('#img-preview').innerHTML = thumbHtml({ name: dlg.querySelector('[name=name]').value || '?', image }); };
  preview();
  dlg.querySelector('[name=name]').addEventListener('input', preview);
  dlg.querySelector('#img-clear').addEventListener('click', () => { image = null; preview(); });
  dlg.querySelector('#img-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await resizeImage(file, 800);
      const r = await api('/api/upload', { method: 'POST', body: { data } });
      image = r.path;
      preview();
    } catch (err) {
      toast(err.message || '照片處理失敗', 'error');
    }
  });
  dlg.querySelector('[data-action=cancel]').addEventListener('click', () => dlg.close());
  dlg.querySelector('[data-action=delete]')?.addEventListener('click', async () => {
    const ok = await ask({ title: '刪除商品', message: `確定刪除「${esc(p.name)}」？已成立的訂單與報表不受影響。`, okLabel: '刪除', okCls: 'btn-danger' });
    if (!ok) return;
    try {
      await api(`/api/products/${p.id}`, { method: 'DELETE', body: {} });
      toast('已刪除');
      dlg.close();
      load();
    } catch (err) { toast(err.message, 'error'); }
  });
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const body = {
      name: f.elements.namedItem('name').value, price: f.price.value === '' ? NaN : Number(f.price.value), description: f.description.value,
      image, preorderable: f.preorderable.checked, paused: f.paused.checked,
    };
    if (f.sort.value !== '') body.sort = Number(f.sort.value);
    try {
      await api(p ? `/api/products/${p.id}` : '/api/products', { method: p ? 'PUT' : 'POST', body });
      toast('已儲存', 'ok');
      dlg.close();
      load();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/** 在瀏覽器端把照片縮成最長邊 max px 的 JPEG */
function resizeImage(file, max) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('無法讀取這張照片'));
    img.src = URL.createObjectURL(file);
  });
}
