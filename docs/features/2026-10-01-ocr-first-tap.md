# 功能規格：mobile_tap 先 OCR、後 dump（OCR-first tap）

- **分支**：未建立（建議 `feat/ocr-first-tap`）
- **狀態**：STAGE 0a 規格，尚未實作
- **前置**：`mobile_tap`（`tapByDescription`，見 [2026-10-01-jev-tap.md](2026-10-01-jev-tap.md)）與 OCR 層已在 `main`

## 1. 問題

`mobile_tap` 每次點擊都**先** dump 無障礙樹，Jev 沒把握才補 OCR（`src/jev.ts` `tapByDescription`）。在 Flutter debug build 上，mobilecli 的 `dump ui` 走 Dart VM service，每次 6.3–10.2 秒（根因見 jev-tap 規格 §7），而這段時間在許多點擊中是白付的：

- **側選單項目根本不在樹裡**：「關鍵字過濾」「我的位置」只能靠 OCR 找到，但每次都先付一次 dump 才輪到 OCR。
- **實測**（2026-10-01，Pixel 9a 模擬器 Android 17，FindRestaurant）：相同 10 步流程，本 fork 122 秒、上游 mobile-mcp 81 秒。約 11 次 Flutter dump，合計約 70–110 秒。

測試流程：關閉所有 app → launcher 點 FindRestaurant → 等待載入 → 捲動 100px → 漢堡選單 → 關鍵字過濾 → 取消 → 漢堡選單 → 我的位置 → 等待載入。

OCR（截圖 + macOS Vision）約 1–1.5 秒，比 Flutter dump 便宜 5–9 秒。把順序倒過來：先用便宜的 OCR 試，只有沒把握時才付 dump。

## 2. 使用者故事

身為以 `mobile_tap` 操作 Flutter debug app 的 agent，我點擊畫面上看得到的文字目標（側選單項目、按鈕文字）時，希望不必等一次 6–10 秒的 dump，就能被正確點中；點擊沒有文字的圖示目標（無 label 的漢堡按鈕）時，仍能退回無障礙樹找到它。

## 3. 目標與非目標

**目標**
1. server 在 macOS 上執行時（OCR 在 server 端跑，Android／iOS 裝置皆適用），`mobile_tap` 改為先以 OCR 元素讓 Jev 選擇；有把握就直接點，**不呼叫** `robot.getElementsOnScreen`。
2. OCR 沒把握時才 dump 無障礙樹，與**已讀到的** OCR 元素合併後再問 Jev 一次；同一次嘗試內不做第二次 OCR。
3. 只有 OCR、沒有樹時，畫面方向由截圖本身判定，不依賴 robot 回報的方向。
4. 「沒點擊」的錯誤訊息標明搜尋了哪些來源。

**非目標**
- dump 快取（同一畫面重用前一次 dump）。
- 修改 `mobile_list_elements_on_screen` 的行為或輸出。
- 修改 OCR 辨識本身（Vision 參數、語言、`mergeOcrElements` 去重規則）。
- server 不在 macOS 上執行（例如 Linux CI，沒有 Vision）：行為完全不變，只 dump。
- 未設定 `TYPESAFE_API_KEY`：`mobile_tap` 不註冊，與現況相同。

## 4. 方案比較

| 方案 | 內容 | 取捨 | 結論 |
|---|---|---|---|
| A. 無條件 OCR-first | 支援 OCR 時每次點擊都先 OCR | 規則最簡單、無狀態；原生畫面（launcher dump 僅 0.7 秒）與圖示目標每次多付 1–1.5 秒 | ✅ 採用（使用者決定） |
| B. 依上次 dump 耗時切換 | 上次 dump 慢（例如 > 3 秒）才 OCR-first，否則維持 dump-first | 原生畫面不吃虧；需跨呼叫保存狀態與門檻值，行為依歷史而變、難以預測與測試 | 不採用 |
| C. 維持 dump-first，只做 dump 快取 | 同畫面重用 dump | 畫面判定「未改變」本身就需要讀畫面；過期快取會點錯 | 不在本次範圍 |

採用 A 的代價明確記錄：**原生畫面與圖示目標每次點擊多 1–1.5 秒**（OCR 讀完沒把握，仍要 dump）。換取的是 Flutter debug app 文字目標每次省 5–9 秒，以及一條沒有狀態的規則。

## 5. 行為規格

### 5.1 資料流

```
mobile_tap(target)
  最多 2 次嘗試：
    [server 在 macOS]
      截圖 → 由 PNG 寬高判定方向 → OCR 元素 → chooseElement(Jev)       source = "OCR"
        └─ 無把握 → dump 樹 → currentViewport(樹) → 合併「本次已讀的 OCR 元素」→ chooseElement(Jev)
                                                                       source = "OCR + accessibility tree"
    [server 不在 macOS]
      dump 樹 → chooseElement(Jev)                                     source = "accessibility tree"（同現況）

    無把握 → 不點擊，拋 ActionableError（附 source 與前 3 名候選）
    有 ref 且 robot 支援 → tapByRef(ref)；否則 → tap(元素中心)
    tapByRef 回報「not found on current screen」→ 下一次嘗試（從 OCR 重新開始）
```

### 5.2 只有 OCR 時的畫面尺寸

`currentViewport` 依賴 dump 中的 window root 判斷方向；沒有樹時會退回 `robot.getOrientation()`，而 mobilecli 已知會對橫向 Chrome 回報直向（README 已記錄）。因此：

- **只有 OCR 的那一步**：以 `robot.getScreenSize()` 為尺寸，**由截圖 PNG 的寬高比決定是否對調寬高**（截圖寬 > 高 ⇒ 橫向）。不呼叫 `getOrientation()`。
- **有樹之後**：沿用現有 `currentViewport(robot, tree)` 行為不變。
- OCR 座標換算到螢幕座標，用的是「截圖當下」的尺寸；退回樹時若兩者方向不一致（畫面在兩步之間旋轉），以樹的 viewport 為準描述元素。旋轉中途點擊屬既有的座標點擊過期風險（§6），本次不另行處理。

### 5.3 行為改變：文字目標改以座標點擊

OCR 元素沒有 ref，只能以座標點擊，沒有過期 ref 防護。現況下由樹的 ref 點中的文字目標，在 OCR-first 下若 Jev 只靠 OCR 就有把握，會**改為座標點擊**：

| 目標 | 現況 | OCR-first 後 |
|---|---|---|
| 「取消」（樹中為 Button） | `tapByRef(@e74)` | OCR 座標點擊（若 OCR 有把握） |
| launcher「FindRestaurant」（樹中為 TextView） | `tapByRef` | 見 §5.4 |
| 側選單「關鍵字過濾」「我的位置」 | dump 後 OCR 座標點擊 | OCR 座標點擊（省掉 dump） |
| 漢堡按鈕（無文字） | `tapByRef(@e65)` | OCR 無把握 → dump → `tapByRef`（多付 1–1.5 秒） |

後果：

- **stale-ref 重試只在退回樹、且選中有 ref 的元素時才生效**。OCR 直接點中的路徑，畫面在截圖與點擊之間改變時會點到舊座標（與現有 OCR 元素的限制相同，見 jev-tap §8「座標點擊沒有過期防護」）。
- 座標取 OCR 文字框中心，而非整個按鈕的中心；文字在按鈕內，仍落在可點區域內。

### 5.4 畫面上有重複文字

launcher 上桌面與 dock 各有一個「FindRestaurant」。只靠 OCR 時，兩個相同文字框會分散機率，Jev 很可能沒把握 → 退回 dump + 合併，由樹提供位置與 ref。此情況耗時等同現況再加 1–1.5 秒，不視為錯誤；若合併後仍分散，行為同現況（拒絕並附候選，agent 需改寫描述）。

### 5.5 錯誤訊息

`Nothing tapped` 訊息的 `searched ...` 必須反映實際搜尋過的來源：

| 情況 | `searched` |
|---|---|
| macOS，OCR 無把握、退回樹後仍無把握 | `OCR + accessibility tree` |
| server 不在 macOS | `accessibility tree` |

成功訊息的 `from ...` 同樣標明 `OCR` 或 `OCR + accessibility tree`。

### 5.6 錯誤處理

| 情況 | 行為 |
|---|---|
| 截圖或 Vision 失敗（拋錯、逾時） | 退回只 dump 的流程（同 server 不在 macOS 時），`from`／`searched` 註明 OCR 失敗；不讓 OCR 的錯誤擋住原本靠樹就點得到的目標。dump 也失敗才把錯誤回給 agent |
| 截圖有效但 OCR 讀不到任何文字 | 視為 OCR 無把握，直接退回 dump + 合併 |
| 元素數 ≥ 255（Jev Choice 上限） | 同現況，拒絕並請 agent 改用 `list` |

## 6. 預期耗時（估算，未實測）

| 步驟 | 目標 | 現況 | OCR-first | 差異 |
|---|---|---|---|---|
| launcher 點 FindRestaurant | 原生、重複文字 | dump 0.7 秒 | OCR + dump（多半退回） | +1–1.5 秒 |
| 漢堡選單 ×2 | Flutter、無文字圖示 | dump | OCR + dump | 每次 +1–1.5 秒 |
| 關鍵字過濾、我的位置 | Flutter、只在 OCR | dump + OCR | OCR | 每次 −6–10 秒 |
| 取消 | Flutter、文字 | dump | OCR | −5–9 秒 |

文字目標每次省約 5–9 秒，圖示／原生目標每次多 1–1.5 秒。整段流程預估約 **105–110 秒**（現況 122 秒），此數字為推算，需以 §7 驗收 3 實測確認。仍明顯慢於上游 81 秒，剩下的差距來自漢堡按鈕仍需 dump，以及 agent 確認畫面時的 `list` 呼叫——後者不在本次範圍。

## 7. 驗收標準

1. **OCR 有把握不 dump**（單元測試）：假 robot 在 macOS 路徑下，OCR 元素即可讓 Jev 有把握選中文字目標時，完成點擊且 `robot.getElementsOnScreen` 呼叫次數為 0。
2. **退回時不重複 OCR**（單元測試）：OCR 無把握 → dump → 合併後點中；同一次嘗試中截圖／OCR 只做 1 次、`getElementsOnScreen` 1 次，且合併結果包含先前讀到的 OCR 元素。
3. **實機**：重跑 §1 的同一流程（Pixel 9a 模擬器、FindRestaurant），10 步全部成功，總耗時 < 122 秒，並記錄實際秒數與每步 `from` 來源。
4. **方向來自截圖**（單元測試）：只有 OCR 時，robot 回報直向尺寸與直向 orientation、但截圖 PNG 為橫向，OCR 座標以對調後的寬高換算；且此步不呼叫 `getOrientation()`。
5. **錯誤訊息**（單元測試）：兩階段都無把握時不點擊，訊息含 `searched OCR + accessibility tree`。
6. **server 不在 macOS 時不變**（單元測試）：`isOcrSupported()` 為 false 時，流程為 dump → Jev，不截圖，訊息來源為 `accessibility tree`。
7. **stale-ref 重試仍有效**（既有測試調整）：退回樹後選中的 ref 失效時，重新從頭讀畫面並點中。
8. **OCR 失敗不擋點擊**（單元測試）：截圖或 Vision 拋錯時，改走 dump → Jev 並點中樹裡的目標，訊息註明 OCR 失敗。
9. 無 key 時工具清單不變；所有既有測試與 `npm run lint` 通過。

## 8. 已知限制與風險

| 項目 | 說明 |
|---|---|
| 原生畫面變慢 | 原生畫面 dump 只要 0.7 秒，OCR-first 每次多 1–1.5 秒；方案 B 的門檻切換可消除，但被否決（§4） |
| 文字目標失去 ref 防護 | 原本以 ref 點的文字按鈕改以 OCR 座標點擊，畫面在截圖與點擊之間改變會點到舊位置（§5.3） |
| OCR 誤讀 | Vision 誤讀或漏讀文字時，Jev 可能以近似文字有把握地選錯；目前僅靠 `MIN_CONFIDENCE = 0.5` 擋，門檻未校準 |
| 隱私 | 不變：OCR 文字本來就會在退回時送到 TypeSafe，只是現在每次點擊都會送 |
| 耗時估算未實測 | §6 為推算，以驗收 3 為準 |
