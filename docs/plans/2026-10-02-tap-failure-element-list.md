# mobile_tap 失敗時附上元素清單 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mobile_tap` 拋出 `Nothing tapped` 時，在既有第一行之後附上本次判斷所用的元素清單（`formatElements(elements, "text")`），agent 直接挑 ref 或 `tap=` 座標去點，不必再 `list` 一次。

**Architecture:** `src/jev.ts` 的 `Reading` 多帶一個 `elements`，`choose` 的每條回傳路徑把「交給 Jev 的那份元素」一併帶出；`tapByDescription` 的失敗分支把它格式化接在訊息後。`src/server.ts` 只改 `mobile_tap` description 一個字串。

**Spec:** `docs/features/2026-10-02-tap-failure-element-list.md`

## Global Constraints

- 不新增檔案、不新增相依、不新增選項或設定。
- 錯誤訊息第一行逐字不變；清單只接在其後。
- `mobile_list_elements_on_screen`、`formatElements`、`CANDIDATES_SHOWN`、`MIN_CONFIDENCE`、成功路徑一律不動。
- 縮排 ≤ 3 層；ESLint `curly: all`。
- 未經使用者要求不 commit。

## 實作方向與 trade-off

| 方向 | 內容 | 取捨 | 結論 |
|---|---|---|---|
| A. `Reading` 加 `elements: ScreenElement[]`（必填） | `chooseFromTree` 填合併＋精簡後的 `elements`；OCR 有把握的路徑填 `ocr.elements` | 3 處各加一個欄位，型別強制每條路徑都填，沒有 `?`／`undefined` 分支 | ✅ 採用 |
| B. `elements?` 選填，只在 `chooseFromTree` 填 | OCR 路徑少寫一個欄位 | 失敗分支要多處理 `undefined`，等於為「不會發生的情況」加特殊情況 | 不採用 |
| C. 失敗時把清單塞進 `ElementChoice` | 由 `chooseElement` 回傳 | `ElementChoice` 是 Jev 的答案，`parseAnswer`／測試都用它；混進畫面資料汙染了它的語意，diff 也更大 | 不採用 |

**失敗路徑一定經過 `chooseFromTree`，故清單一定是「最後一次 dump（＋已讀 OCR）」**：

- `readOcr` 為 null（非 macOS）→ `chooseFromTree(..., [], "accessibility tree")`。
- OCR 拋錯 → `chooseFromTree(..., [], "accessibility tree (OCR failed: ...)")`。
- OCR 無把握 → `chooseFromTree(..., ocr.elements, "OCR + accessibility tree")`。
- OCR **有把握**才回 `source: "OCR"`；`tapByDescription` 的失敗條件是 `!isConfident(choice)`，與 `choose` 的回傳條件互斥，所以「OCR 路徑的 `elements` 出現在失敗訊息」不會發生。該路徑填 `ocr.elements` 只為型別完整，填什麼都不影響行為，取最直接的值。
- stale ref 重試時 `choose` 整個重跑，失敗訊息用的是第 2 次的 `Reading`，自然是最後一次 dump。

## 訊息格式（決定規格 §4.1 留下的兩項）

- 分隔標題：獨立一行 `Elements on screen:`，下一行起為 `formatElements` 原樣輸出（含它自己的 `One element per line: ...` 標頭）。
- 空清單：與標題同行 `Elements on screen: none`，不輸出 `formatElements` 的標頭。

```
Nothing tapped: no element matches "設定" confidently (confidence 0.20, searched accessibility tree). Closest: @e1 Button "" at 74,202 (0.20)
Elements on screen:
One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [tap=x,y when no ref] [focused] [selected] [checked] [disabled]
@e1 Button at=11,139 size=126x126
@e2 Button label="登出" at=42,1291 size=996x126
OcrText text="我的位置" at=118,1063 size=202x50 tap=219,1088
```

```
Nothing tapped: no element matches "設定" confidently (confidence 0.00, searched OCR + accessibility tree). Closest: none
Elements on screen: none
```

## mobile_tap description（`src/server.ts` 第 742 行，確切全文）

```
Tap the on-screen element that matches a short description, e.g. "登出 button" or "menu button at the top left". The server reads the screen (OCR first, then the accessibility tree if needed) and picks the element, so there is no need to list elements first. If nothing matches confidently, nothing is tapped; the closest candidates and the elements on screen are returned, so pick one of them and tap it with mobile_click_on_screen_at_coordinates (by ref, or at its tap= coordinates). Call mobile_list_elements_on_screen only if the screen has changed since. Icons missing from the accessibility tree cannot be found this way.
```

（原始碼中 `"登出 button"` 與 `"menu button at the top left"` 的雙引號維持 `\"` 跳脫，與現況相同。）

## mobile_click_on_screen_at_coordinates description（`src/server.ts` 第 647 行，使用者於 STAGE 0b 確認追加）

只改 ref 來源的子句，讓 agent 敢直接用失敗訊息裡的 ref：

```
Click on the screen, either at x,y coordinates or on an element by its ref (e.g. "@e5") from the latest mobile_list_elements_on_screen result or failed mobile_tap result. Prefer ref when the element is listed.
```

## File Structure

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/jev.ts` | Modify | import `formatElements`；`Reading.elements`；3 個回傳點填值；失敗訊息附清單 |
| `src/server.ts` | Modify | `mobile_tap` 與 `mobile_click_on_screen_at_coordinates` description 字串 |
| `test/jev.test.ts` | Modify | 擴充 1 個既有測試、新增 3 個測試 |
| `README.md`、`README.zh-TW.md` | Modify | 流程圖末行與步驟 4 改為「附清單、直接挑」 |

---

### Task 1: 失敗訊息附清單 + description（含測試）

模型等級：**整合**（改動機械，但要對得上既有 fake 與 compact／merge 的實際輸出）。

**Files:** `src/jev.ts`、`src/server.ts`、`test/jev.test.ts`

- [ ] **Step 1: 寫測試（紅）**，全部放在 `test.describe("tapByDescription")` 內，沿用既有 `answerWith`／`fakeRobot`／`ocrReading`／`myLocation`。

擴充既有「taps nothing when Jev is not confident」（驗收 2），在 `expect(taps)` 前加兩行：

```ts
		expect(error.message).toContain("\nElements on screen:\nOne element per line:");
		expect(error.message.split("\n")).toContain("@e2 Button label=\"登出\" at=42,1291 size=996x126");
```

新增（驗收 1、5）：Jev 回 NONE。`answerWith("NONE", 0.9)` 的 probabilities 只有 `NONE`，`ranked` 為空，故 `Closest: none`；第一行以 `toBe` 逐字鎖住，證明格式未變。

```ts
	test("NONE: lists the elements on screen after the first line, taps nothing", async () => { // tap-failure acceptance 1, 5
		answerWith("NONE", 0.9);
		const { robot, taps } = fakeRobot();
		const error = await tapByDescription(robot, "設定", null).catch(err => err);
		expect(error).toBeInstanceOf(ActionableError);
		const [first, heading, ...list] = error.message.split("\n");
		expect(first).toBe("Nothing tapped: no element matches \"設定\" confidently (confidence 0.90, searched accessibility tree). Closest: none");
		expect(heading).toBe("Elements on screen:");
		expect(list).toContain("@e2 Button label=\"登出\" at=42,1291 size=996x126");
		expect(taps).toEqual([]);
	});
```

新增（驗收 3）：OCR 無把握 → 樹 → 仍無把握。OCR 文字用樹裡沒有的「關鍵字過濾」，避免被 `mergeOcrElements` 的覆蓋判斷濾掉（同既有 acceptance 2 測試）。座標：`myLocation` 換算為 108,1140 216x60，中心 216,1170。

```ts
	test("unsure after OCR and tree: OCR text is listed with tap coordinates", async () => { // tap-failure acceptance 3
		answerWith("1", 0.2);
		const { robot, taps } = fakeRobot();
		const ocr = ocrReading(() => [{ ...myLocation, text: "關鍵字過濾" }]);
		const error = await tapByDescription(robot, "設定", ocr.read).catch(err => err);
		expect(error).toBeInstanceOf(ActionableError);
		expect(error.message.split("\n")).toContain("OcrText text=\"關鍵字過濾\" at=108,1140 size=216x60 tap=216,1170");
		expect(taps).toEqual([]);
	});
```

新增（驗收 4）：OCR 與樹皆空。`chooseElement` 對空陣列直接回 NONE、不呼叫 fetch，兩次判斷都不送請求。

```ts
	test("nothing on screen: says so instead of an empty list", async () => { // tap-failure acceptance 4
		const requests = answerWith("1", 0.95);
		const { robot, taps } = fakeRobot({ getElementsOnScreen: async () => [] });
		const error = await tapByDescription(robot, "設定", ocrReading(() => []).read).catch(err => err);
		expect(error).toBeInstanceOf(ActionableError);
		expect(error.message).toMatch(/Closest: none\nElements on screen: none$/);
		expect(error.message).not.toContain("One element per line");
		expect([requests.length, taps.length]).toEqual([0, 0]);
	});
```

- [ ] **Step 2: 確認紅**：`npx playwright test test/jev.test.ts` → 上述 4 個測試失敗（訊息沒有清單），其餘通過。

- [ ] **Step 3: 改 `src/jev.ts`（綠）**

import（依路徑字母序插在 `./compact-elements` 之後）：

```ts
import { formatElements } from "./format-elements";
```

`Reading`：

```ts
interface Reading {
	choice: ElementChoice;
	screen: Dimensions;
	source: string;
	elements: ScreenElement[];
}
```

`chooseFromTree` 回傳：

```ts
	return { choice: await chooseElement(target, elements, screen), screen, source, elements };
```

`choose` 的 OCR 有把握回傳：

```ts
		return { choice, screen: ocr.screen, source: "OCR", elements: ocr.elements };
```

`tapByDescription`：解構加 `elements`，失敗分支改為：

```ts
		const { choice, screen, source, elements } = await choose(robot, target, readOcr);
		const element = choice.element;
		if (!element || !isConfident(choice)) {
			const closest = choice.ranked.map(c => `${describeElement(c.element, screen)} (${c.probability.toFixed(2)})`).join(", ") || "none";
			const onScreen = elements.length > 0 ? `\n${formatElements(elements, "text")}` : " none";
			throw new ActionableError(`Nothing tapped: no element matches "${target}" confidently (confidence ${choice.confidence.toFixed(2)}, searched ${source}). Closest: ${closest}\nElements on screen:${onScreen}`);
		}
```

- [ ] **Step 4: 改 `src/server.ts` 第 742 行**：把 `mobile_tap` description 換成上方「確切全文」（雙引號以 `\"` 跳脫）；同檔第 647 行 `mobile_click_on_screen_at_coordinates` description 換成上方對應字句。

- [ ] **Step 5: 驗證**
  - `npx playwright test test/jev.test.ts` → 全綠（含既有對 `Nothing tapped`／`searched ...` 的斷言，驗收 5）。
  - `npm test`（= `c8 playwright test`）→ 全綠；`list` 相關測試未修改即通過（驗收 7）。需實機的 device 測試若因環境略過，以略過數與 `main` 相同為準。
  - `npm run lint` → 無錯誤。
  - `npx tsc --noEmit` → 無型別錯誤。

- [ ] **Step 6: Commit（僅在使用者要求時）** `feat(tap): list the elements on screen when nothing is tapped`

### Task 2: README 同步（兩語）

模型等級：**機械性**。

**Files:** `README.md`、`README.zh-TW.md`

兩份 README 都寫著「失敗 → 回候選 → agent 改用 `mobile_list_elements_on_screen`」，本案後不再正確，必須改。

- [ ] **Step 1: `README.md`**
  - 第 32 行流程圖末行：`nothing tapped, candidates returned → agent falls back to the path below` → `nothing tapped, candidates + element list returned → agent picks one and clicks it`
  - 第 114 行步驟 4：`4. Still no confident match → **nothing is tapped**; the closest candidates are returned so the agent can fall back to `mobile_list_elements_on_screen`.` → `4. Still no confident match → **nothing is tapped**; the closest candidates are returned together with the element list Jev chose from (the same format as `mobile_list_elements_on_screen`, OCR text included), so the agent can pick a ref or `tap=` coordinates for `mobile_click_on_screen_at_coordinates` without reading the screen again.`
- [ ] **Step 2: `README.zh-TW.md`**
  - 第 32 行：`不點擊，回傳候選 → agent 改走下方路徑` → `不點擊，回傳候選與元素清單 → agent 直接挑一個點`
  - 第 114 行：`4. 仍然沒有把握 → **不點擊**，回傳最接近的候選，讓 agent 改用 `mobile_list_elements_on_screen`。` → `4. 仍然沒有把握 → **不點擊**，回傳最接近的候選，並附上 Jev 判斷所用的元素清單（格式同 `mobile_list_elements_on_screen`，含 OCR 文字），agent 可直接挑 ref 或 `tap=` 座標交給 `mobile_click_on_screen_at_coordinates`，不必再讀一次畫面。`
- [ ] **Step 3: 驗證**：目視比對兩語內容一致；流程圖對齊（等寬欄位）未被破壞。
- [ ] **Step 4: Commit（僅在使用者要求時）** `docs(readme): describe the element list on a failed mobile_tap`

**不改**：`CHANGELOG.md` 只記上游 release（`mobile_tap`、OCR-first 皆未列入），維持慣例不加。`docs/features` 舊規格為歷史紀錄，不回改。

## 驗收對照

| 驗收（spec §7） | 由誰覆蓋 |
|---|---|
| 1 失敗訊息含清單、不點擊 | Task 1「NONE: lists the elements…」 |
| 2 低信心同樣附清單 | Task 1 擴充「taps nothing when Jev is not confident」 |
| 3 OCR 元素以座標呈現 | Task 1「unsure after OCR and tree…」 |
| 4 空清單 | Task 1「nothing on screen…」 |
| 5 第一行不變 | 「NONE…」的 `toBe` ＋ 既有 `Nothing tapped`／`searched` 斷言 |
| 6 description 更新 | Task 1 Step 4 |
| 7 不動 list、全測試與 lint | Task 1 Step 5 |

## 執行方式

- **subagent-driven**：Task 1 與 Task 2 寫入檔案不重疊，可由兩個 subagent 平行執行；Task 2 只依本計畫字句，不需等 Task 1。
- **parallel session**：本案太小，不建議開兩個 session；單一 session 依序做 Task 1（紅 → 綠 → 驗證）再做 Task 2 即可。
