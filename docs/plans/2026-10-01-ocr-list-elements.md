# `mobile_list_elements_on_screen` OCR 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 本文件為事後補記的 STAGE 0b 計畫：Task 1–5 已在 `feat/ocr-list-elements` 完成並併入 `main`（已勾選並附 commit），「後續任務」為尚未完成的工作。

**Goal:** 無障礙樹裡沒有的文字，用 macOS Vision OCR 補進 `mobile_list_elements_on_screen` 的同一份清單，附上可直接點擊的螢幕座標。

**Architecture:** 新檔 `src/ocr.ts` 經 `osascript` JXA 呼叫 Vision 辨識原尺寸截圖，把正規化座標乘上螢幕尺寸換成 `OcrText` 元素，去掉樹中已有的文字後附加到清單；`list` 以選用參數 `ocr` 啟用；`formatElements` 為沒有 ref 的元素輸出中心點 `tap=x,y`。

**Tech Stack:** TypeScript（Node ≥ 20）、`@modelcontextprotocol/server`、`zod`、mobilecli、macOS Vision（`VNRecognizeTextRequest`，經 `osascript -l JavaScript`）、`@playwright/test`。

**Spec:** `docs/features/2026-10-01-ocr-list-elements.md`

## Global Constraints

- 不帶 `ocr` 參數時，`list` 行為與上游 mobile-mcp 相同。
- 不新增 npm 相依；不寫暫存檔（圖片經 stdin 傳給 `osascript`）。
- OCR 只在 `process.platform === "darwin"` 時可用，其他平台回 `ActionableError`。
- `osascript` 逾時 30 秒，`maxBuffer` 16MB。
- 不以 Vision confidence 過濾結果。
- 邏輯放新檔 `src/ocr.ts`，對上游檔案（`src/server.ts`、`src/format-elements.ts`）只做最少接線。
- 文件（`docs/`、README.zh-TW）以繁體中文撰寫；commit 訊息英文。

## File Structure

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/format-elements.ts` | Modify | 沒有 ref 的元素輸出 `tap=x,y` |
| `src/ocr.ts` | Create | Vision 辨識、座標換算、去重合併 |
| `test/ocr.test.ts` | Create | 座標換算、去重、`tap=` 輸出 |
| `src/server.ts` | Modify | `list` 的 `ocr` 參數與空樹提示 |
| `skills/mobile-automation/SKILL.md` | Modify | 何時使用 OCR |
| `package.json` | Modify | `prepare` 在安裝時 build，讓 repo 可從 GitHub 安裝 |
| `README.md`、`README.zh-TW.md` | Modify | 雙語說明，互相連結 |

---

### Task 1: 沒有 ref 的元素輸出中心點 ✅ `1e8458b`

**Files:**
- Modify: `src/format-elements.ts`

**Interfaces:**
- Produces: text 格式中，`ref` 為空的元素在 `size=` 之後多一個 `tap=<x>,<y>`（`Math.round` 後的中心點）；表頭加上 `[tap=x,y when no ref]`。

- [x] **Step 1: 實作**

```ts
// without a ref the element can only be tapped by coordinates, so hand over the center
if (!element.ref) {
	parts.push(`tap=${Math.round(element.rect.x + element.rect.width / 2)},${Math.round(element.rect.y + element.rect.height / 2)}`);
}
```

- [x] **Step 2: 驗證**：既有 `test/format-elements.test.ts` 的元素都有 ref，輸出不變，全部通過。
- [x] **Step 3: Commit** `feat(elements): emit tap center for elements without a ref`

### Task 2: OCR 本體與 `list` 參數 ✅ `3c0be10`

**Files:**
- Create: `src/ocr.ts`
- Create: `test/ocr.test.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Produces:
  - `interface OcrObservation { text: string; x: number; y: number; width: number; height: number }`（正規化、原點左下）
  - `toScreenElements(observations: OcrObservation[], screen: Dimensions): ScreenElement[]`
  - `mergeOcrElements(elements: ScreenElement[], ocrElements: ScreenElement[]): ScreenElement[]`
  - `isOcrSupported(): boolean`
  - `withOcrElements(robot: Robot, elements: ScreenElement[]): Promise<ScreenElement[]>`
  - `mobile_list_elements_on_screen` 新增 `ocr?: boolean`（預設 `false`）

- [x] **Step 1: 確認 Vision 可經 JXA 使用**：以 `osascript -l JavaScript` 對 repo 內的 `mobile-mcp.png` 辨識，取得 4 段文字，約 0.9 秒；改為從 stdin 讀圖亦可。
- [x] **Step 2: 實作辨識**：`VNRecognizeTextRequest`，`recognitionLevel = 0`（accurate）、`usesLanguageCorrection = true`、語言 `zh-Hant, zh-Hans, ja-JP, ko-KR, en-US`；`execFileSync("osascript", ["-l", "JavaScript", "-e", VISION_SCRIPT], { input: image, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })`。
- [x] **Step 3: 座標換算**

```ts
rect: {
	x: Math.round(o.x * screen.width),
	y: Math.round((1 - o.y - o.height) * screen.height),
	width: Math.round(o.width * screen.width),
	height: Math.round(o.height * screen.height),
}
```

- [x] **Step 4: 去重**：OCR 框中心落在無障礙元素內，且 `text`／`label`／`name`／`value` 正規化後包含 OCR 文字時丟棄；正規化為 `value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase()`。
- [x] **Step 5: 接到 `list`**：`ocr` 為真時 `elements = await withOcrElements(robot, elements)`；樹為空、未帶 `ocr` 且支援 OCR 時，回傳末尾附「No elements found in the accessibility tree. Retry with ocr: true to read text off the screen.」
- [x] **Step 6: 測試**：正規化座標換成左上原點的螢幕座標；中心落在同文字元素內的 OCR 框被丟棄、位置不同或文字不同的保留；`·`／`•` 差異仍能去重；OCR 元素輸出 `tap=`。
- [x] **Step 7: 實機驗證**：FindRestaurant 首頁去重正確、與樹的中心點誤差約 8px（spec §6.2）。
- [x] **Step 8: Commit** `feat(elements): add opt-in OCR to mobile_list_elements_on_screen`

> 實際執行紀錄：測試是在實作後補寫，並非 TDD-first；去重的正規化原本只去掉空白，是第一次實機測試看到 `·` 被讀成 `•` 之後才改成只比對字母與數字。

### Task 3: SKILL 說明 ✅ `47b78a1`

**Files:**
- Modify: `skills/mobile-automation/SKILL.md`

- [x] **Step 1**：「See the screen」一節加上：找不到要點的文字時，先 `ocr: true` 並點 `OcrText` 的 `tap=x,y`；OCR 只讀文字、不認圖示；仍找不到才截圖。
- [x] **Step 2: Commit** `docs(skill): describe when to list elements with OCR`

### Task 4: 可從 GitHub 安裝 ✅ `32968c3`

**Files:**
- Modify: `package.json`

- [x] **Step 1**：`"prepare": "npm run build && (husky || true)"`。git 相依安裝時沒有 `.git`，`husky` 會失敗，所以容忍。
- [x] **Step 2: 驗證**：在 scratchpad 複製 repo、`git init` 後以 `npm install git+file://...` 模擬，`lib/index.js`、`lib/ocr.js` 與 `mcp-server-mobile` 執行檔皆產生，約 15 秒。
- [x] **Step 3: Commit** `build(package): build on install so the repo can be installed from git`

### Task 5: 雙語 README ✅ `16c082f`

**Files:**
- Modify: `README.md`
- Create: `README.zh-TW.md`

- [x] **Step 1**：`README.md`（英文）與 `README.zh-TW.md`（繁中）頂端互相連結，內容涵蓋動機、三層流程、改動檔案、`ocr` 參數與輸出範例、觸發時機、實測、限制、安裝（GitHub、`.mcp.json`、npx 快取更新、本機開發）、上游同步、授權。
- [x] **Step 2: Commit** `docs(readme): document the OCR layer in English and Traditional Chinese`

### 驗證紀錄（已完成）

- [x] 以 `github:Yomiamy/jev-mobile-agent#feat/ocr-list-elements` 安裝為 MCP，經 `mcp__jev-mobile__*` 跑 FindRestaurant 流程：9 步 110 秒、11 步 85 秒與 77 秒，皆 0 次截圖（spec §6.3）。

---

## 後續任務

### Task 6: canvas 端到端驗證

- [ ] 以本機 HTTP server 提供只在 `<canvas>` 上繪製文字與按鈕的頁面，經 `adb reverse` 在模擬器 Chrome 開啟。
- [ ] 確認不帶 `ocr` 時清單中沒有該文字、帶 `ocr: true` 時出現 `OcrText`，並以其 `tap=` 點擊後畫面改變。

### Task 7: 橫向畫面的座標換算

- [ ] `withOcrElements` 的螢幕尺寸改由 dump 的視窗根元素決定（已在 `feat/jev-decision` 的 `a209596` 實作，隨該分支併入）。
- [ ] 實機：開自動旋轉的橫向畫面，比對 OCR 座標與樹中同一元素的中心點。

### Task 8: iOS 模擬器驗證

- [ ] 在 iOS 模擬器上確認 Vision 座標換算（螢幕尺寸為 point、截圖為 pixel）與去重結果。

## 執行方式

- **subagent-driven**：Task 6、8 互不重疊，可平行；Task 7 依賴 `feat/jev-decision` 併入。
- **parallel session**：Task 6 需要模擬器與本機 HTTP server，適合單獨 session 進行。
