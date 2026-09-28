// 本機 / 一般主機啟動：node server.js
// 有 DATABASE_URL 時連 Postgres，否則使用 data/pgdata 內的 PGlite。
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.js';
import { createApp } from './lib/app.js';
import { startReminderScheduler } from './lib/service.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

const dbReady = openDb({ dataDir: process.env.DATA_DIR || path.join(ROOT, 'data') });
const server = http.createServer(createApp(dbReady));

const db = await dbReady;
startReminderScheduler(db);
server.listen(PORT, () => {
  console.log(`烘焙 POS 已啟動（資料庫：${db.kind}）：http://localhost:${PORT}`);
  console.log(`  店員 POS   http://localhost:${PORT}/pos.html`);
  console.log(`  客戶訂購頁 http://localhost:${PORT}/order.html`);
});
