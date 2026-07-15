# PAPER CALL：純 LINE 群組報告輪值 Bot

不使用 Google Sheet。指定成員、輪值順序、請假、停會及會議時間全部保存在 Google Apps Script 的 Script Properties，並直接在 LINE 群組操作。

## 功能

- 管理員在群組輸入「加入輪值」並標註特定成員。
- 只有被選中的人持續循環輪班，每次預設兩位。
- 開會前一天自動在群組標註報告人。
- 報告人可按「我要請假」，Bot 立即找下一位替補。
- 請假者在下一個實際開會週優先補報告。
- 管理員可按「本週不開會」，輪值順序完全保留。
- 報告人按「完成報告」後移到輪值隊尾。
- 支援固定每週會議與臨時指定下次會議。

## 需要準備

1. LINE Official Account。
2. LINE Developers 的 Messaging API Channel；LINE Login Channel 不能用來傳 Bot 訊息。
3. Messaging API Channel Access Token。
4. Google Apps Script 專案與部署後的 Webhook URL。

不需要 Google Sheet、資料庫或額外伺服器。

## 1. LINE Messaging API 設定

1. 到 LINE Official Account Manager 建立或開啟官方帳號。
2. 在設定中啟用 Messaging API，Provider 選擇自己的 Provider。
3. 回 LINE Developers，開啟新產生的 Messaging API Channel。
4. 在 Messaging API 分頁開啟 `Allow bot to join group chats`。
5. 發行 Channel Access Token。
6. 關閉官方帳號內建的自動回應，避免重複回覆。

## 2. 建立 Apps Script

1. 到 https://script.google.com 建立「獨立 Apps Script 專案」。
2. 將 [Code.gs](Code.gs) 內容貼入編輯器。
3. 在專案設定開啟顯示資訊清單，將 [appsscript.json](appsscript.json) 內容貼入。
4. 在「專案設定 → 指令碼屬性」新增：

| 屬性 | 必填 | 說明 |
|---|---:|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 是 | Messaging API 分頁發行的 Token |
| `WEBHOOK_SECRET` | 否 | 自訂隨機字串；若設定，Webhook URL 必須加相同 `?key=` |
| `LINE_ADMIN_USER_IDS` | 否 | 可先不填，之後用「初始化管理員」設定第一位管理員 |
| `REMINDER_COUNT` | 否 | 每次報告人數，預設 `2`，最大 `10` |

Token 只放 Script Properties，不要寫進程式或 GitHub。

## 3. 部署 Apps Script

1. Apps Script 點「部署 → 新部署」。
2. 類型選「網頁應用程式」。
3. 執行身分選「我」。
4. 存取權選「所有人」。
5. 部署後複製 `/exec` 網址。
6. 如果有設定 `WEBHOOK_SECRET`，在網址後加 `?key=相同字串`。
7. 先保存這個網址，下一節會把它設成 Cloudflare Worker 的 `APPS_SCRIPT_URL`。
8. 程式修改後需「管理部署 → 編輯 → 新版本」重新部署。

## 4. 部署 Webhook 代理

LINE Verify 不接受 Google Apps Script 固定產生的 `302` 轉址，因此不能把 `/exec` 網址直接填入 LINE。使用免費 Cloudflare Worker 將 Apps Script 已處理完成的 `302` 回應轉成直接的 `200 OK`：

1. 登入 https://dash.cloudflare.com 。
2. 選擇「Workers & Pages → Create → Worker」。
3. 建立 Worker 後點「Edit code」。
4. 將 [cloudflare-worker.mjs](cloudflare-worker.mjs) 的完整內容貼入並部署。
5. 到 Worker 的「Settings → Variables and Secrets」。
6. 新增純文字變數：
	- 名稱：`APPS_SCRIPT_URL`
	- 值：上一節取得、以 `/exec` 結尾的 Apps Script 網頁應用程式網址
7. 儲存並重新部署 Worker。
8. 開啟 Worker 網址，應看到 `PAPER CALL webhook proxy is running.`。
9. 複製 Worker 網址，例如 `https://paper-call.你的帳號.workers.dev`。
10. 將 **Worker 網址** 貼入 LINE Developers → Messaging API → Webhook URL。
11. 按 Verify，成功後開啟 Use webhook。

不要再把 Apps Script `/exec` 網址直接填入 LINE Webhook；它會被 LINE 判定為 `302 Found`。

## 5. 加入群組與初始化

1. 將 LINE 官方帳號邀請到目標群組。
2. 第一位管理員在群組輸入：`初始化管理員`。
3. Bot 會記住第一個使用它的群組，其他群組無法操作同一個專案。
4. 管理員輸入「加入輪值」，並在同一則訊息中標註要加入的人。
5. 可一次標註多人；Bot 會依加入順序建立循環隊列。

如果已在 Script Properties 填入 `LINE_ADMIN_USER_IDS`，不需要執行初始化管理員。可在群組輸入「我的ID」取得 User ID。

## 6. 設定會議

固定每週開會：

- `設定週會 星期二 10:00`
- `設定週會 週五 14:30`

臨時指定下一次會議，這個日期會優先於較晚的固定週會：

- `設定下次會議 2026/07/21 10:00`

## 7. 設定前一天自動提醒

在 Apps Script 左側「觸發條件」新增：

- 執行函式：`sendDailyReminder`
- 事件來源：時間驅動
- 類型：日計時器
- 執行時段：例如每天上午 9–10 點

只有當「明天是會議日」時才會發送提醒，同一天不會重複發送。

## LINE 群組指令

| 指令 | 誰可以用 | 功能 |
|---|---|---|
| `初始化管理員` | 首位設定者 | 尚無管理員時，將自己設為管理員 |
| `加入輪值` + 標註成員 | 管理員 | 將特定群組成員加入循環 |
| `移除輪值` + 標註成員 | 管理員 | 從循環移除成員 |
| `加入我輪值` | 所有人 | 將自己加入循環 |
| `輪值名單` | 所有人 | 查看目前完整輪值順序 |
| `輪值` | 所有人 | 查看下一次會議與報告人 |
| `設定週會 星期二 10:00` | 管理員 | 設定固定每週會議 |
| `設定下次會議 2026/07/21 10:00` | 管理員 | 設定一次性下次會議 |
| `請假` | 本次報告人 | 本次找人替補，下個開會週優先補 |
| `幫請假` + 標註成員 | 管理員 | 替本次報告人請假並立即補上下一位 |
| `完成` | 本次報告人 | 標記完成並移到隊尾 |
| `我的ID` | 所有人 | 顯示自己的 LINE User ID |
| `說明` | 所有人 | 顯示指令摘要 |

提醒訊息也會提供「我要請假」、「完成報告」和「本週不開會」按鈕。

## 建議首次測試

1. 管理員初始化。
2. 加入至少三位輪值成員。
3. 輸入 `設定下次會議`，日期設為明天。
4. 輸入 `輪值`，確認 Bot 標註前兩位。
5. 其中一位按「我要請假」，確認第三位立即替補。
6. 再輸入 `輪值`，確認更新後名單。
7. 執行 `sendDailyReminder()`，確認群組收到前一天提醒。
8. 按「本週不開會」，再執行提醒函式，確認不會再次通知。

## GitHub

原始碼位於：https://github.com/juliahahah/LINE_PAPER_ANN

所有群組資料與 Token 都存在 Apps Script，不會提交到 GitHub。