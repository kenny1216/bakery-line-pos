import { getSetting } from './db.js';
import { taipeiNow } from './util.js';

/**
 * 以 LINE Messaging API 推播文字訊息，結果一律寫入 line_messages。
 * 未設定 Channel access token 時為「模擬模式」：不呼叫 LINE，只記錄。
 * 回傳狀態：sent / failed / mock / skipped
 */
export async function pushText(db, { to, text, kind, customerId = null, orderId = null, transactionId = null }) {
  const token = await getSetting(db, 'line_channel_token');
  let status;
  let error = null;
  if (!to) {
    status = 'skipped';
    error = '沒有 LINE 帳號';
  } else if (!token) {
    status = 'mock';
  } else if (to.startsWith('U-test')) {
    status = 'skipped';
    error = '測試帳號，不會真的傳送';
  } else {
    try {
      const res = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ to, messages: [{ type: 'text', text: text.slice(0, 5000) }] }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) status = 'sent';
      else {
        status = 'failed';
        error = `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`;
      }
    } catch (e) {
      status = 'failed';
      error = String(e.message || e).slice(0, 300);
    }
  }
  await db.run(`INSERT INTO line_messages (created_at, kind, to_user, customer_id, order_id, transaction_id, text, status, error)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [taipeiNow().datetime, kind, to || null, customerId, orderId, transactionId, text, status, error]);
  return status;
}

/** 驗證 LIFF 取得的 ID token，回傳 { userId, name } */
export async function verifyIdToken(db, idToken) {
  const clientId = await getSetting(db, 'line_login_channel_id');
  if (!clientId) throw new Error('尚未設定 LINE Login Channel ID');
  const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ id_token: idToken, client_id: clientId }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`LINE 身分驗證失敗（HTTP ${res.status}）`);
  const data = await res.json();
  return { userId: data.sub, name: data.name || '' };
}

export const MESSAGE_KIND_LABEL = {
  order_received: '收到訂單',
  order_confirmed: '訂單確認',
  order_updated: '訂單調整',
  order_cancelled: '訂單取消',
  receipt: '電子收據',
  reminder: '取貨提醒',
};
