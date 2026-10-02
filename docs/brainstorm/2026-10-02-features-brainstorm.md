# jev-mobile-mcp 發想與待辦

（截至 2026-10-02）

狀態符號：⬜ 未開始 ｜ 🟡 進行中 ｜ ✅ 完成

## 完成度總覽

| # | 項目 | 狀態 | 備註 |
|---|---|---|---|
| A1 | OCR 補充無障礙樹（`list` 的 `ocr` 參數） | ✅ | macOS Vision，經 JXA 呼叫 |
| A2 | 精簡元素清單（畫面外、空容器、重複 label） | ✅ | `compactElements`：只留目前畫面範圍內的元素、去掉空容器、只對多行合併 label 去重；有無 TypeSafe key 都生效，首頁約 −60% |
| A3 | 由 Jev 依描述選擇點擊目標 | ✅ | `mobile_tap`，僅設定 `TYPESAFE_API_KEY` 時註冊；server 在 macOS 時先用 OCR 問 Jev，無把握才讀無障礙樹並合併已讀的 OCR（不重跑 OCR），仍無把握就不點、回傳候選並附上判斷所用的元素清單（樹＋OCR），agent 直接挑一個點擊、不必再 `list`，ref 過期時重讀一次；Flutter debug app 的 10 步實測由 122 秒降到約 80–85 秒 |
| A4 | 由 Jev 決定操作與目標，server 端自跑迴圈（`mobile_run_goal`） | ⬜ | 依 A3 的效果再評估 |
| A5 | 等待條件（server 端輪詢直到畫面出現指定內容） | ⬜ | 取代 agent 自己反覆 `list` 確認畫面 |
| B1 | 查清 `dump ui` 為何慢 | ✅ | 已查明：mobilecli 對可除錯的 Flutter app 改走 Dart VM service 走訪整棵 render tree（6–10 秒）；修正屬 mobilecli 範疇，profile build 的效果未量測 |
| B2 | 橫向畫面的座標與過濾 | ✅ | 畫面範圍改由 dump 的視窗根元素決定（mobilecli 開自動旋轉時回報錯誤方向）；Android 模擬器實測，iOS 見 B4 |
| B3 | canvas 畫面的 OCR 端到端點擊驗證 | ⬜ | 測試曾中斷 |
| B4 | iOS 模擬器驗證 | ⬜ | |

## 項目說明

### A2 精簡元素清單

`list` 的輸出包含畫面外的列與被推到背後的前一頁、沒有內容的容器，以及 Flutter 在每個子節點重複的合併 label。精簡後可降低 agent 每次讀取畫面的 token。

### A3 由 Jev 依描述選擇點擊目標

agent 只給一句描述，server 端把元素表交給 Jev 選擇，agent 不必讀整份清單。前提是元素表夠精簡（A2）。

### A4 `mobile_run_goal`

jev-ultrafast 快的主因：每一步由 Jev 同時決定操作與目標。工作量大，且需獨立驗證完成狀態。

### A5 等待條件

流程中「等待畫面載入」目前靠 agent 反覆 `list` 判斷，耗 token 也多一次往返。

### B1 `dump ui` 速度

在 FindRestaurant 上一次可達數秒，原因未明。

### B2–B4 驗證缺口

橫向畫面、canvas 繪製的文字、iOS 模擬器都還沒有實測。
