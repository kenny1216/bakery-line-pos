import crypto from 'node:crypto';

const TZ = 'Asia/Taipei';
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** 台北時間的日期、時間字串 */
export function taipeiNow(d = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  const hour = p.hour === '24' ? '00' : p.hour;
  const date = `${p.year}-${p.month}-${p.day}`;
  return { date, time: `${hour}:${p.minute}`, datetime: `${date} ${hour}:${p.minute}:${p.second}` };
}

export function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function isDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function assert(cond, status, message) {
  if (!cond) throw new HttpError(status, message);
}

export function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : NaN;
}

export function money(n) {
  return `$${Number(n).toLocaleString('en-US')}`;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
