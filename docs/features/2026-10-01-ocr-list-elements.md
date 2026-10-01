# 功能規格：在無障礙樹與截圖之間加入 OCR（`mobile_list_elements_on_screen` 的 `ocr` 參數）

- **分支**：`feat/ocr-list-elements`（已併入 `main`）
- **狀態**：已實作並完成實機驗證（本文件為事後補記的 STAGE 0a 規格）
- **基底**：fork 自 [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp)，同步至上游 `da98beb`（`e2a0e84`）

## 1. 問題

上游 mobile-mcp 定位點擊目標只有兩條路：

1. `mobile_list_elements_on_screen`：讀無障礙樹，回傳 ref、座標、label。快、便宜、準。
2. `mobile_take_screenshot`：樹裡找不到時，把截圖交給模型目測，再依縮放比例換算座標。慢、耗 token，準度取決於模型的視覺能力。

很多畫面的文字根本不在無障礙樹裡：Flutter 的 `Drawer` 沒有輸出 semantics、canvas 繪製的 UI、嵌在圖片裡的文字。這些情況只能退到截圖。實例：FindRestaurant 的側選單打開後，樹裡只有一層全螢幕的 `ConstrainedBox` 遮罩，「關鍵字過濾」「我的位置」「設定」等項目完全不存在。

另一個問題：無障礙樹的 `at=x,y` 是左上角，模型要自己算中心點；提醒它的只有 SKILL 裡的一句 prompt。

## 2. 目標與非目標

**目標**
1. 樹裡找不到文字時，先在本機用 OCR 讀出文字與座標，還找不到才截圖。
2. OCR 結果直接是螢幕座標，並附上算好的中心點，模型不必換算。
3. 不重複列出樹裡已經有的文字。
4. 預設行為不變：不帶參數時與上游完全相同。

**非目標**
- 辨識圖示（OCR 只讀文字）。
- 非 macOS 平台的 OCR。
- 由 server 自動決定何時開 OCR。
- OCR 元素的 ref（由 server 端解析）。

## 3. 方案比較

### 3.1 介面

| 方案 | 內容 | 取捨 | 結論 |
|---|---|---|---|
| A. 新工具 `find_text` | 另開一個只做 OCR 的工具 | 多一份 tool schema（每次對話都佔 token）；模型要多判斷先用哪個；兩種輸出格式，同一個按鈕可能出現兩次 | 否決 |
| B. `list` 加 `ocr` 參數 | 樹＋OCR 合併、去重後同一份清單輸出 | 少一個工具、單一格式；仍由模型判斷何時帶 `ocr: true` | ✅ 採用 |
| C. `list` 永遠跑 OCR | 不需判斷 | 每次 `list` 多 1–1.5 秒，而 `list` 是最常呼叫的工具 | 否決 |
| D. 樹「太稀疏」時自動開 | 不需判斷 | 「幾個元素算稀疏」沒有正確答案，只是另一個特殊情況 | 否決；改為樹**完全為空**時在回傳中提示改用 `ocr: true` |

### 3.2 OCR 引擎

| 選項 | 繁中準確度 | 相依 | 速度 | 非 macOS |
|---|---|---|---|---|
| **macOS Vision**（經 `osascript` JXA） | 好 | 無（系統內建，免編譯） | 約 0.3–0.9 秒 | ❌ |
| tesseract.js（WASM） | 普通，UI 字體與中文偏弱 | 新增套件＋10MB 以上的語言模型 | 1–3 秒 | ✅ |
| 雲端 OCR | 好 | API key、網路，截圖外傳 | 看網路 | ✅ |

採用 macOS Vision：開發機與模擬器都在 Mac 上，繁中最準，零 npm 相依。JXA 直接讀 stdin 的圖片，連暫存檔都不需要。

## 4. 設計

### 4.1 資料流

```
mobile_list_elements_on_screen({ device, ocr: true })
  ├─ robot.getElementsOnScreen()                    ← 無障礙樹
  └─ withOcrElements(robot, elements)
       ├─ robot.getScreenSize()
       ├─ robot.getScreenshot({ format: "png" })    ← 原尺寸，小字才認得出來
       ├─ recognizeText()   osascript -l JavaScript，Vision VNRecognizeTextRequest
       ├─ toScreenElements() 正規化座標 × 螢幕尺寸 → OcrText 元素
       └─ mergeOcrElements() 去掉樹裡已有的文字後附加在後面
  → formatElements()：沒有 ref 的元素多印 tap=x,y（中心點）
```

### 4.2 元件

| 檔案 | 職責 |
|---|---|
| `src/ocr.ts` | `recognizeText`（JXA + Vision，辨識語言 zh-Hant、zh-Hans、ja-JP、ko-KR、en-US，accurate 等級）、`toScreenElements`、`isCovered`／`mergeOcrElements`、`isOcrSupported`、`withOcrElements` |
| `src/server.ts` | `list` 新增 `ocr` 參數；樹為空且支援 OCR 時附加提示 |
| `src/format-elements.ts` | 沒有 ref 的元素（OCR、legacy robot）輸出 `tap=x,y` |
| `skills/mobile-automation/SKILL.md` | 告訴 agent：找不到文字時先 `ocr: true`，再退到截圖 |

### 4.3 決策規則

- **座標換算**：Vision 回傳相對於截圖的正規化座標（原點在左下角），截圖涵蓋整個螢幕，所以「正規化座標 × 螢幕尺寸」就是螢幕座標，不必知道截圖本身的像素尺寸，也不受 iOS point／pixel 差異影響。
- **去重**：OCR 框的中心點落在某個無障礙元素範圍內，且該元素的 `text`／`label`／`name`／`value` 包含這段文字時丟棄。比對只看字母與數字（OCR 會把 `·` 讀成 `•`、增減空白）。
- **不以 confidence 過濾**：Vision 的 confidence 只有 0.3／0.5／1 三種值，0.3 裡同時有雜訊（「苷」）與可點的有效文字（「開啟 》」、`$$$`），門檻會丟掉有效目標；交給模型依語意判斷。
- **OCR 元素沒有 ref**，只能用 `tap=` 座標點擊。

### 4.4 錯誤處理

| 情況 | 行為 |
|---|---|
| 非 macOS | `ActionableError`（「OCR is only supported when the server runs on macOS」） |
| 螢幕尺寸未知（0x0） | `ActionableError`，不產生無法換算的座標 |
| `osascript` 逾時（30 秒）或失敗 | 例外往上拋 |

## 5. 驗收標準

1. 不帶 `ocr` 時，`list` 的行為與上游相同（`tap=` 只加在沒有 ref 的元素上）。
2. 樹中找不到的文字可經 `ocr: true` 取得可點擊的座標。
3. 樹中已有的文字不重複出現。
4. 非 macOS 與螢幕尺寸未知時明確報錯。

## 6. 驗證結果

### 6.1 單元測試

`test/ocr.test.ts` 4 個案例（座標換算、去重、標點差異去重、`tap=` 輸出），與 `format-elements`、`server-batch`、`server-annotations`、`mobile-device` 合計 **30 passed**；`npm run lint` 無問題。

### 6.2 第一次實機（Pixel 6 模擬器，FindRestaurant 首頁）

| 項目 | 結果 |
|---|---|
| 去重 | 店名、地址、分類等樹中已有的文字全部被濾掉 |
| 座標準度 | OCR「尋找餐廳」中心 `314,209`，樹中 `@e31` 中心 `315,201`，相差約 8px |
| 中文辨識 | 地址、店名全部正確；橘底白字標題讀成「尋𣏾餐𩧉」；圖示讀成「苷」「太」，`$$` 讀成 `SS` |
| 去重修正 | 初版只忽略空白，`Bistros · Bars` 與 OCR 的 `Bistros•Bars` 對不上；改為只比對字母與數字後正確去重 |
| 耗時 | `withOcrElements` 約 1.0–1.6 秒 |

### 6.3 真實流程（經 MCP 安裝，`mcp__jev-mobile__*`）

| 流程 | 結果 |
|---|---|
| 9 步：開側選單 → 設定 → 登出 → Google 登入 | 110 秒完成；側選單在樹中完全不存在，OCR 一次取得「設定」`tap=192,1383` 並點中，全程 0 次截圖 |
| 11 步：開側選單 → 關鍵字過濾 → 取消 → 我的位置 → 等待重新載入（兩輪） | 85 秒、77 秒完成，0 次截圖、0 次重試；兩輪 OCR 座標完全相同（「關鍵字過濾」`258,647`、「我的位置」`219,1088`） |

### 6.4 未完成的驗證

- canvas 頁面（文字只畫在 `<canvas>`）的端到端點擊測試在進行中被中斷，未完成。
- iOS 模擬器、橫向畫面未測。

## 7. 已知限制與後續

| 項目 | 說明 |
|---|---|
| 僅 macOS | 其他平台傳 `ocr: true` 會報錯，其餘功能不受影響 |
| 只讀文字 | 純圖示按鈕（愛心、漢堡選單）仍需截圖；根本解法是 app 端補 `tooltip`／`Semantics(label:)` |
| 雜訊 | 圖示、星等、低對比文字會被誤讀；OCR 讀錯字時無法和樹中的同一段文字去重 |
| 速度 | 每次 `ocr: true` 多 1–1.5 秒（含截圖） |
| 橫向畫面座標 | `withOcrElements` 以 `getScreenSize()` 換算座標；後續在 `feat/jev-decision` 實測發現 mobilecli 開自動旋轉時回報錯誤方向，橫向時 OCR 座標會被壓進直向尺寸。已在該分支 `a209596` 改為以 dump 的視窗根元素決定畫面範圍 |
| 由模型判斷何時用 OCR | 模型可能不重試而直接截圖；只有樹完全為空時才有明確提示 |
| 後續 | 在 `feat/jev-decision` 以 Jev 依描述點擊（`mobile_tap`）時，server 端在樹中找不到目標才自動加上 OCR，見 `docs/features/2026-10-01-jev-tap.md` |
