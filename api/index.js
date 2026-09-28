// Vercel 入口：所有 /api/*、/r/*、/uploads/* 請求都由這裡處理（見 vercel.json）。
// 靜態頁面（public/）由 Vercel CDN 直接提供。
import { openDb } from '../lib/db.js';
import { createApp } from '../lib/app.js';

const handle = createApp(openDb());

export default function handler(req, res) {
  // rewrite 後原始路徑放在 __path
  const url = new URL(req.url, 'http://localhost');
  const original = url.searchParams.get('__path');
  if (original !== null) {
    url.searchParams.delete('__path');
    const qs = url.searchParams.toString();
    req.url = `/${original}${qs ? `?${qs}` : ''}`;
  }
  return handle(req, res);
}
