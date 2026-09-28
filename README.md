# 烘培麵包 POS 與 LINE 接單系統（第一版）

門市現金收銀、LINE 預訂到店付現、電子收據、未取貨提醒、每日銷售報表。
規劃文件見 [PLAN.md](PLAN.md)。

## 資料儲存

所有資料都存在 **PostgreSQL 資料庫**：

| 資料表 | 內容 |
|---|---|
| `users` | 店主／店員帳號（密碼以 scrypt 雜湊保存，不存明碼） |
| `products`、`images` | 麵包品項、售價、狀態、商品照片 |
| `customers` | LINE 客戶（LINE userId、姓名、電話） |
| `orders`、`order_items` | 預訂單與品項 |
| `transactions`、`transaction_items` | 結帳交易、作廢紀錄 |
| `line_messages` | LINE 發送紀錄 |
| `settings` | 店家資訊、取貨時段、提醒時間等設定 |

- **雲端**：環境變數 `DATABASE_URL` 指向 Postgres（建議 Vercel Storage 裡的 Neon，免費方案即可）。
- **本機開發／測試**：不需安裝資料庫，自動使用內嵌的 PGlite（同樣是 Postgres），資料在 `data/pgdata`。

資料庫第一次啟動時自動建立資料表，並寫入 8 項示範麵包與初始帳號：

| 帳號 | 雲端初始密碼 | 本機初始密碼 |
|---|---|---|
| `owner`（店主） | 環境變數 `ADMIN_PASSWORD` | owner1234 |
| `staff`（店員） | 環境變數 `STAFF_PASSWORD` | staff1234 |

之後改密碼、新增帳號都在「設定 → 帳號」操作，直接寫入資料庫；環境變數只在資料庫是空的時候使用一次。

## 本機啟動

需要 Node.js 24。

```bash
npm install
```

```bash
npm start
```

開啟 http://localhost:3000（POS）與 http://localhost:3000/order.html（客戶訂購頁）。

```bash
npm test
```

## 雲端部署（Vercel）

架構：`public/` 靜態頁面由 Vercel CDN 提供；`api/index.js` 是 Serverless Function，處理 `/api/*`、`/r/*`（電子收據）、`/uploads/*`（商品照片）。設定在 `vercel.json`。

### 環境變數

| 名稱 | 說明 |
|---|---|
| `DATABASE_URL` | Postgres 連線字串（在 Vercel Storage 建立 Neon 資料庫並連接專案後自動加入） |
| `ADMIN_PASSWORD`、`STAFF_PASSWORD` | 初始店主／店員密碼 |
| `CRON_SECRET` | 排程呼叫 `/api/cron/reminders` 的密鑰 |
| `LINE_CHANNEL_ACCESS_TOKEN`、`LIFF_ID`、`LINE_LOGIN_CHANNEL_ID`、`PUBLIC_BASE_URL` | 選用。設定後會覆蓋後台「設定 → LINE 串接」的值 |

### 未取貨提醒排程

- `vercel.json` 內建每日排程（UTC 09:00）。Vercel 免費方案的排程只保證在該小時內執行，所以提醒會在**台灣時間 17:00–18:00** 之間送出。
- 要準時在設定的時間（預設 16:30）送出：到 [cron-job.org](https://cron-job.org)（免費）建立排程，每 5 分鐘呼叫
  `GET https://你的網址/api/cron/reminders`，Header 加上 `Authorization: Bearer <CRON_SECRET>`。
  系統會判斷時間，一天只執行一次，每筆訂單只提醒一次，與 Vercel 內建排程同時存在也不會重複。

## 串接 LINE

未設定前為**模擬模式**：訂購頁可用 `U-test-…` 測試 ID 下單，LINE 訊息只寫進「設定 → LINE 發送紀錄」。

1. **官方帳號與 Messaging API**
   在 [LINE Official Account Manager](https://manager.line.biz/) 建立（或使用現有）官方帳號 → 設定 → Messaging API → 啟用，選擇 Provider。
   接著在 [LINE Developers](https://developers.line.biz/console/) 找到該 Messaging API channel → *Messaging API* 分頁 → 發行 **Channel access token (long-lived)**。
2. **LINE Login channel 與 LIFF**
   在同一個 Provider 建立 **LINE Login** channel（App type 勾 Web app）→ *LIFF* 分頁 → Add：
   - Size：Full
   - Endpoint URL：`https://你的網址/order.html`
   - Scopes：`openid`、`profile`
   - Add friend option：**On (Aggressive)**（客人第一次開啟就邀請加入好友，才收得到通知）
   記下 **LIFF ID**；Basic settings 分頁記下 **Channel ID**。
   LINE Login channel 建好後是「Developing」，要把狀態改成 **Published**，一般客人才能使用。
3. **填入系統**：店主登入 →「設定 → LINE 串接」填入 Channel access token、LIFF ID、LINE Login Channel ID、對外網址（`https://你的網址`）→ 儲存。
4. **Rich Menu**：在 LINE Official Account Manager → 圖文選單，新增「預訂麵包」按鈕，連結設為 `https://liff.line.me/<LIFF ID>`。
5. **測試**：用自己的手機從 Rich Menu 下單 → 後台確認 → POS 取貨結帳，確認依序收到「已收到訂單」「訂單已確認」「電子收據」三則訊息。

> **訊息則數**：LINE 官方帳號免費方案每月可主動推播的則數有限（台灣「輕用量」方案為 200 則）。每筆預訂約用 3–4 則（收到訂單、確認、收據、提醒）。
> 若要省則數，可在設定頁關閉「已收到訂單」通知。超過額度時訊息會傳送失敗，訂單看板會提示改以電話聯絡。

## 權限

| 功能 | 店員 | 店主 |
|---|---|---|
| POS 結帳、訂單看板（確認／調整／取消／取貨結帳） | ✓ | ✓ |
| 查看每日報表、下載 CSV | ✓ | ✓ |
| 作廢交易 | | ✓ |
| 商品管理、設定、帳號、LINE 發送紀錄 | | ✓ |

## 計畫書第八章尚待店家確認

- 店名、地址、電話、統編（設定頁可改）
- 取貨時段（設定頁可改）
- 收據格式與是否需開立統一發票 — 請會計或稅務人員確認；目前收據註明「非統一發票」
