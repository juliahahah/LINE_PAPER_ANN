# LINE 群組報告輪值 Bot

使用 Google Apps Script、Google Sheets 與 LINE Messaging API，無需另租伺服器。

## 功能

- 每次從 Sheet 找出兩位尚未報告的人。
- 開會前一天自動在 LINE 群組提醒。
- 報告人可按「我要請假」，系統立即找下一位替補。
- 請假者在下一個有開會的週次優先補報告。
- 管理員可按「本週不開會」，該週不通知、不消耗名單。
- 成員可在群組輸入「輪值」查看下一次報告人。
- 成員可輸入「完成」更新 Sheet 狀態。
- 管理員可從群組中特別指定哪些人參與輪值，不需要全員加入。
- 自動偵測表頭位置，不要求表頭一定在第一列。

## Sheet 必要欄位

欄位名稱需包含：

- 報告日期
- 報告人
- 報告主題
- 狀態
- 結果（名稱可以是「結果（自動）」）

狀態請使用「未報告」、「已報告」或「請假」。報告日期欄中的日期視為開會日期；同一天可有兩位。

## 1. 建立 LINE 官方帳號與 Messaging API

1. 到 LINE Official Account Manager 建立官方帳號。
2. 到 LINE Developers 建立 Messaging API Channel。
3. 開啟「Allow bot to join group chats」。
4. 發行長效 Channel Access Token。
5. 關閉 LINE 官方帳號內建的自動回應，避免一則訊息回覆兩次。

## 2. 建立 Apps Script

1. 從目標 Google Sheet 點「擴充功能 → Apps Script」。
2. 將 [Code.gs](Code.gs) 的內容貼入。
3. 在專案設定開啟「顯示 appsscript.json」，再貼入 [appsscript.json](appsscript.json)。
4. 在「專案設定 → 指令碼屬性」新增：

| 屬性 | 必填 | 值 |
|---|---:|---|
| `LINE_CHANNEL_ACCESS_TOKEN` | 是 | LINE Developers 發行的長效 Token |
| `SHEET_NAME` | 是 | 實際分頁名稱；程式預設為「報告輪值表」 |
| `WEBHOOK_SECRET` | 是 | 自訂一段無法猜到的隨機字串，例如密碼產生器產生的 32 字元字串 |
| `SPREADSHEET_ID` | 否 | 已預填目前網址中的 Sheet ID |
| `REMINDER_COUNT` | 否 | 每週人數，預設 `2` |
| `LINE_ADMIN_USER_IDS` | 建議 | 可按 SKIP 的 User ID；多人用逗號分隔 |

若未設定 `LINE_ADMIN_USER_IDS`，群組中任何人都能按「本週不開會」。

## 3. 部署 Webhook

1. Apps Script 點「部署 → 新部署 → 網頁應用程式」。
2. 執行身分選「我」。
3. 存取權選「所有人」。
4. 複製部署完成的 `/exec` 網址。
5. 在網址後加上 `?key=你的WEBHOOK_SECRET`，例如 `https://script.google.com/macros/s/部署ID/exec?key=隨機字串`。
6. 將完整網址貼到 LINE Developers 的 Webhook URL，開啟 Use webhook，再按 Verify。
7. 每次修改程式後，要到「管理部署 → 編輯 → 新版本」重新部署。

> Apps Script 無法直接讀取 LINE 的 `X-Line-Signature` HTTP Header，因此此版本用不可猜測的 URL 密鑰保護 Webhook。密鑰不要公開或提交到 GitHub。

## 4. 設定每天檢查

在 Apps Script 左側「觸發條件」新增：

- 執行函式：`sendDailyReminder`
- 事件來源：時間驅動
- 類型：日計時器
- 時段：例如上午 9–10 點

程式每天檢查明天是否有 Sheet 中的開會日期；只有開會前一天才傳提醒。

## 5. 加入 LINE 群組並初始化

1. 把官方帳號邀進目標 LINE 群組。
2. 在群組輸入「說明」。Bot 會自動記住該群組 ID，無需手動尋找。
3. 每位成員輸入「綁定 Sheet姓名」，例如：`綁定 Julia_Liu`。
4. 管理員輸入「我的ID」，把 Bot 回覆的 ID 填入 Script Property `LINE_ADMIN_USER_IDS`。
5. 管理員輸入「啟用輪值 姓名」逐一選擇要參與的人，例如：`啟用輪值 Julia_Liu`。
6. 輸入「輪值名單」檢查指定的人員，再輸入「輪值」查看下一次兩位報告人。

## 群組操作

- `綁定 姓名`：將自己的 LINE 帳號對應到 Sheet 姓名。
- `輪值`：顯示下一次開會日期及兩位報告人。
- `請假` 或「我要請假」按鈕：只有本次報告人能成功請假。
- `完成` 或「完成報告」按鈕：將本人第一筆未完成報告設為已報告。
- 「本週不開會」：二次確認後跳過該開會日，名單留到下次。
- `啟用輪值 姓名`：管理員把 Sheet 中的特定人員加入輪值；第一次使用時切換成指定名單模式。
- `停用輪值 姓名`：管理員暫停特定人員。
- `輪值名單`：查看目前參與輪值的人員。
- `我的ID`：取得設定 `LINE_ADMIN_USER_IDS` 所需的 LINE User ID。

## 你需要準備哪些東西

### 不需要傳給程式作者、由你自己貼進 Script Properties

1. **LINE Channel Access Token**
	- LINE Developers → 你的 Provider → Messaging API Channel → Messaging API 分頁。
	- 找到 Channel access token，按 Issue。
	- 貼到 `LINE_CHANNEL_ACCESS_TOKEN`。這是密鑰，不要傳到群組或提交 GitHub。
2. **WEBHOOK_SECRET**
	- 用密碼產生器建立至少 32 字元的隨機字串。
	- 同一字串放入 Script Property，並加在 Webhook URL 的 `?key=` 後面。
3. **LINE 管理員 User ID**
	- Bot 部署成功後，在群組輸入「我的ID」。
	- 將回覆值填入 `LINE_ADMIN_USER_IDS`；多位管理員以逗號分隔。

### 已經具備或可自動取得

- Google Sheet ID：已由你提供的網址預填為 `1ncJnbfJXqyWPDPKmtAMgC91Gg_p-_mjnsRO9r-3Jl-4`。
- LINE 群組 ID：Bot 加入群組後，第一次收到群組指令會自動記錄。
- Webhook URL：由 Apps Script「部署為網頁應用程式」後產生，不是從 LINE 取得。
- GitHub 倉庫：專案原始碼推送到 `https://github.com/juliahahah/LINE_PAPER_ANN.git`；所有密鑰都不會放入倉庫。

## 首次測試

1. 確認 Sheet 中有一個明天的開會日期。
2. 在 Apps Script 手動執行一次 `sendDailyReminder()` 並授權。
3. 群組應收到明日報告提醒與按鈕。
4. 用其中一位已綁定成員按「我要請假」，確認 Sheet 變成「請假」，群組名單自動補下一位。
5. 按「本週不開會」確認後，再執行 `sendDailyReminder()`，不應再次發送。

## 注意

LINE Push Message 會計入官方帳號每月訊息額度。一般每週一次的單一群組提醒，用量通常很低。Script Properties 內的 Token 不要貼到群組或公開儲存庫。