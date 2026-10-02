# mobile_tap 先 OCR、後 dump（OCR-first tap）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mobile_tap` 在 server 跑於 macOS 時先以 OCR 元素問 Jev，有把握就直接點、不 dump；沒把握才 dump 無障礙樹，與已讀到的 OCR 元素合併後再問一次。

**Architecture:** `src/ocr.ts` 新增 `readScreenText(robot)`：不需要樹，只截圖 → 以 PNG 寬高校正 `getScreenSize()` 的方向 → Vision → `ScreenElement[]`，連同所用的 viewport 一起回傳。`src/jev.ts` 的 `tapByDescription` 把「讀畫面＋選元素」抽成 `choose()`：OCR → Jev →（無把握）dump → `currentViewport` → `mergeOcrElements(tree, 已讀 OCR)` → Jev。`withOcrElements` 與 `mobile_list_elements_on_screen` 一行不動。

**Tech Stack:** TypeScript、既有 `PNG`（`src/png.ts`）、既有 `toScreenElements`／`mergeOcrElements`／`currentViewport`／`compactElements`、`@playwright/test`（單元測試）。

**Spec:** `docs/features/2026-10-01-ocr-first-tap.md`

## Global Constraints

- 不新增 npm 相依、不新增檔案（測試加在既有 `test/jev.test.ts`）。
- `withOcrElements` 與 `src/server.ts` 不修改；`mobile_list_elements_on_screen` 行為與輸出不變。
- server 不在 macOS（`isOcrSupported()` 為 false）時流程與現況完全相同：dump → Jev，來源 `accessibility tree`。
- OCR-only 路徑不呼叫 `robot.getOrientation()`。
- 同一次嘗試最多截圖／OCR 一次、dump 一次；stale-ref 重試從 OCR 重新開始（`MAX_TAP_ATTEMPTS = 2` 不變）。
- 函式縮排 ≤ 3 層；ESLint `curly: all`（if 一律加大括號）。
- 文件以繁體中文撰寫；commit 訊息英文。未經使用者要求不 commit。

## 實作方向與 trade-off

### A. OCR 讀取如何脫離樹

| 方向 | 內容 | 取捨 | 結論 |
|---|---|---|---|
| A1. 新增 `readScreenText(robot)`，`withOcrElements` 原樣保留 | 新函式只做「截圖 → 方向 → Vision → 元素」；舊函式仍以樹的 `currentViewport` 換算 | `server.ts` 路徑零 diff、零風險；兩個函式各約 5 行，共用 `recognizeText`／`toScreenElements` | ✅ 採用 |
| A2. 改寫 `withOcrElements` 成 `readScreenText` 的薄包裝 | `withOcrElements = merge(tree, (await readScreenText(robot)).elements)` | `list` 的 OCR viewport 會從「樹的 root」改成「截圖寬高」，改變了非目標（spec §3 非目標 2）的輸出；換來的只是少 3 行重複 | 不採用 |

### B. 測試如何避開真的 Vision（osascript）

| 方向 | 內容 | 取捨 | 結論 |
|---|---|---|---|
| B1. 兩個預設參數當 seam | `readScreenText(robot, recognize = recognizeText)`；`tapByDescription(robot, target, readOcr = isOcrSupported() ? readScreenText : null)` | `server.ts` 呼叫端不變（兩參數）；測試可同時控制「平台是否支援」「Vision 回傳什麼／是否拋錯」，且 viewport 換算走真實程式碼 | ✅ 採用 |
| B2. 測試中改 `process.platform`、以 `execFileSync` mock | 不改簽章 | 需 monkey-patch 模組內部或全域，脆弱；現有測試在 macOS 上已在 Jev 無把握時真的跑 osascript（非決定性） | 不採用 |

B1 也修掉一個既有問題：現有 `tapByDescription` 測試在 macOS 會對 `baseline.jpg` 真跑 Vision。改用 B1 後所有測試皆決定性、跨平台結果一致。

### C. 退回樹後 OCR 元素要不要以樹的 viewport 重新換算

不重新換算，直接 `mergeOcrElements(tree, ocr.elements)`，以 `currentViewport(robot, tree)` 為 Jev 與 `centerOf` 的 screen。理由：

- `rootViewport` 只接受與 `getScreenSize()` 長短邊相同的 root，`readScreenText` 的 viewport 也只會是 `size` 或其對調，所以兩者**只可能差在方向**，尺寸不會不同。
- 方向一致（正常情況）：兩個 viewport 相同，不需換算。
- 方向不一致：代表截圖與 dump 之間畫面旋轉了，OCR 文字框本身就過期，換算也救不回來；spec §5.2 已決定以樹為準、旋轉中點擊屬既有風險。重新換算只會增加程式碼而不增加正確性。
- 已知殘餘：樹裡沒有 window root、且 `getOrientation()` 回報錯誤（mobilecli 橫向 Chrome）時，退回樹後的 viewport 會錯，而截圖的是對的。此情況與現況相同（不惡化），spec §5.2 規定有樹後沿用 `currentViewport`，本次不處理。

### D. OCR 失敗

`readOcr` 拋任何錯（截圖失敗、非 PNG、尺寸未知、Vision 失敗或逾時）→ 改走只 dump 的流程，來源記為 `accessibility tree (OCR failed: <message>)`。Jev／TypeSafe 的錯誤**不在** catch 範圍內（`chooseElement` 在 try 之外），維持現況直接回給 agent。

## File Structure

| 檔案 | 動作 | 職責 |
|---|---|---|
| `src/ocr.ts` | Modify | 新增 `screenshotViewport`（私有）、`OcrScreen`、`readScreenText`；匯入 `PNG` |
| `src/jev.ts` | Modify | 新增 `OcrReader` 型別、`chooseFromTree`、`choose`；`tapByDescription` 改用 `choose`；改 import |
| `test/jev.test.ts` | Modify | 新 fakes（PNG、輪流回答的 fetch、OCR reader）；驗收 1、2、4、5、6、7、8 測試；既有樹路徑測試改傳 `null` |
| `README.md`、`README.zh-TW.md` | Modify | `mobile_tap` 流程與限制改為 OCR-first |

---

### Task 1: OCR-first 讀取與選擇（含測試）

**Files:**
- Modify: `src/ocr.ts`
- Modify: `src/jev.ts`
- Modify: `test/jev.test.ts`

**Interfaces:**
- Consumes: `PNG`（`src/png.ts`）、`recognizeText`、`toScreenElements`、`mergeOcrElements`、`isOcrSupported`（`src/ocr.ts`）、`currentViewport`、`compactElements`（`src/compact-elements.ts`）、`chooseElement`、`isConfident`（`src/jev.ts`）
- Produces:
  - `interface OcrScreen { elements: ScreenElement[]; screen: Dimensions }`
  - `readScreenText(robot: Robot, recognize?: (image: Buffer) => OcrObservation[]): Promise<OcrScreen>`
  - `type OcrReader = (robot: Robot) => Promise<OcrScreen>`
  - `tapByDescription(robot: Robot, target: string, readOcr?: OcrReader | null): Promise<string>`（`server.ts` 仍以兩參數呼叫）

- [ ] **Step 1: 測試 fakes**（`test/jev.test.ts` 的 `tapByDescription` describe 內）

移除 `fs`／`path` import 與 `baseline.jpg`（fixture 檔保留，其他測試仍在用）。改 import：

```ts
import { buildRequest, centerOf, chooseElement, isConfident, OcrReader, parseAnswer, tapByDescription } from "../src/jev";
import { OcrObservation, readScreenText } from "../src/ocr";
```

```ts
// only the signature and IHDR size are read
const pngOf = (width: number, height: number): Buffer => {
	const png = Buffer.alloc(24);
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
	png.writeUInt32BE(width, 16);
	png.writeUInt32BE(height, 20);
	return png;
};

// answers in turn, cycling; returns the request bodies sent
const answerInTurn = (...answers: Array<[string, number]>) => {
	const requests: any[] = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		const [choice, confidence] = answers[requests.length % answers.length];
		requests.push(JSON.parse(String(init?.body)));
		return new Response(JSON.stringify({
			answers: { element: { choice, confidence, probabilities: { [choice]: confidence } } },
		}));
	}) as typeof fetch;
	return requests;
};

const answerWith = (choice: string, confidence: number) => answerInTurn([choice, confidence]);

// the real readScreenText (screenshot, orientation, mapping) with vision faked
const ocrReading = (recognize: () => OcrObservation[]) => {
	let reads = 0;
	const read: OcrReader = robot => {
		reads++;
		return readScreenText(robot, recognize);
	};
	return { read, reads: () => reads };
};

// "我的位置" at 108,1140 216x60 on a 1080x2400 portrait screenshot, center 216,1170
const myLocation: OcrObservation = { text: "我的位置", x: 0.1, y: 0.5, width: 0.2, height: 0.025 };
```

`fakeRobot` 改動：`getScreenshot` 預設回 `pngOf(1080, 2400)` 並計次；新增 `getOrientation` 計次（回 `"portrait"`）；回傳 `{ robot, taps, dumps, screenshots, orientations }`。

- [ ] **Step 2: 既有測試改為明確的樹路徑**

「taps the chosen element by ref」「taps the center of an element without a ref」「taps the visible part…」「taps the landscape screen the robot reports as portrait」四個測試的呼叫改為 `tapByDescription(robot, target, null)`，行為與斷言不變。
「taps nothing when Jev is not confident」同樣傳 `null`，並加斷言 `expect(error.message).toContain("searched accessibility tree")`。
既有「reads the screen again when the chosen ref went stale」由 Step 3 的驗收 7 測試取代（刪除舊版）。

- [ ] **Step 3: 寫驗收測試（先紅）**

```ts
test("OCR confident: taps by coordinates without a dump", async () => { // 驗收 1
	answerWith("1", 0.95);
	const { robot, taps, dumps } = fakeRobot();
	const result = await tapByDescription(robot, "我的位置", ocrReading(() => [myLocation]).read);
	expect(taps).toEqual(["216,1170"]);
	expect(dumps()).toBe(0);
	expect(result).toContain("from OCR)");
});

test("OCR unsure: dumps once, merges the OCR already read, no second OCR", async () => { // 驗收 2
	const requests = answerInTurn(["1", 0.2], ["2", 0.95]);
	const { robot, taps, dumps, screenshots } = fakeRobot();
	const ocr = ocrReading(() => [{ ...myLocation, text: "關鍵字過濾" }]);
	const result = await tapByDescription(robot, "登出", ocr.read);
	expect(taps).toEqual(["@e2"]);
	expect([ocr.reads(), screenshots(), dumps()]).toEqual([1, 1, 1]);
	expect(Object.values(requests[1].questions.element.criteria).some((c: any) => c.text === "關鍵字過濾")).toBe(true);
	expect(result).toContain("from OCR + accessibility tree");
});

test("OCR alone takes the orientation from the screenshot, not the robot", async () => { // 驗收 4
	answerWith("1", 0.95);
	const { robot, taps, dumps, orientations } = fakeRobot({ getScreenshot: async () => pngOf(2400, 1080) });
	// 1500,432 300x108 on 2400x1080; on the unswapped 1080x2400 it would be 675,960
	const button: OcrObservation = { text: "右側按鈕", x: 0.625, y: 0.5, width: 0.125, height: 0.1 };
	await tapByDescription(robot, "右側按鈕", ocrReading(() => [button]).read);
	expect(taps).toEqual(["1650,486"]);
	expect([dumps(), orientations()]).toEqual([0, 0]);
});

test("unsure on both: taps nothing and names both sources", async () => { // 驗收 5
	answerWith("1", 0.2);
	const { robot, taps } = fakeRobot();
	const error = await tapByDescription(robot, "設定", ocrReading(() => [myLocation]).read).catch(err => err);
	expect(error).toBeInstanceOf(ActionableError);
	expect(error.message).toContain("searched OCR + accessibility tree");
	expect(taps).toEqual([]);
});

test("without OCR support: dump then Jev, no screenshot", async () => { // 驗收 6
	answerWith("2", 0.95);
	const { robot, taps, screenshots } = fakeRobot();
	const result = await tapByDescription(robot, "登出", null);
	expect(taps).toEqual(["@e2"]);
	expect(screenshots()).toBe(0);
	expect(result).toContain("from accessibility tree)");
});

test("a stale ref from the tree fallback reads the screen again from OCR", async () => { // 驗收 7
	answerInTurn(["1", 0.2], ["2", 0.95]);
	let first = true;
	const taps: string[] = [];
	const { robot, dumps } = fakeRobot({
		tapByRef: async (ref: string) => {
			if (first) {
				first = false;
				throw new Error(`ref ${ref} not found on current screen; refs come from the latest 'dump ui'`);
			}

			taps.push(ref);
		},
	});
	const ocr = ocrReading(() => [myLocation]);
	const result = await tapByDescription(robot, "登出", ocr.read);
	expect([ocr.reads(), dumps()]).toEqual([2, 2]);
	expect(taps).toEqual(["@e2"]);
	expect(result).toContain("after the screen changed");
});

test("an OCR failure falls back to the tree instead of blocking the tap", async () => { // 驗收 8
	answerWith("2", 0.95);
	const { robot, taps } = fakeRobot();
	const ocr = ocrReading(() => {
		throw new Error("Vision text recognition failed");
	});
	const result = await tapByDescription(robot, "登出", ocr.read);
	expect(taps).toEqual(["@e2"]);
	expect(result).toContain("OCR failed: Vision text recognition failed");
});
```

驗證紅燈：`npx playwright test test/jev.test.ts` → 編譯失敗（`OcrReader`、`readScreenText` 不存在）。

- [ ] **Step 4: 實作 `src/ocr.ts`**

在 `withOcrElements` 之前加入（`withOcrElements` 不動）：

```ts
import { PNG } from "./png";

// the screenshot is the screen as it is now; robots can report portrait for a landscape screen
const screenshotViewport = (size: Dimensions, screenshot: Buffer): Dimensions => {
	const { width, height } = new PNG(screenshot).getDimensions();
	return (width > height) === (size.width > size.height) ? size : { ...size, width: size.height, height: size.width };
};

export interface OcrScreen {
	elements: ScreenElement[];
	screen: Dimensions;
}

/**
 * Reads text off a screenshot without the accessibility tree. The orientation
 * comes from the screenshot itself, the robot's orientation is not asked.
 */
export const readScreenText = async (robot: Robot, recognize = recognizeText): Promise<OcrScreen> => {
	const screenshot = await robot.getScreenshot({ format: "png" });
	const screen = screenshotViewport(await robot.getScreenSize(), screenshot);
	if (screen.width <= 0 || screen.height <= 0) {
		throw new ActionableError("Screen size is unknown, cannot map OCR results onto screen coordinates");
	}

	return { elements: toScreenElements(recognize(screenshot), screen), screen };
};
```

非 PNG（`PNG.getDimensions` 拋 `Not a valid PNG file`）由呼叫端視為 OCR 失敗。

- [ ] **Step 5: 實作 `src/jev.ts`**

import 改為：

```ts
import { isOcrSupported, mergeOcrElements, OcrScreen, readScreenText } from "./ocr";
```

在 `describeElement` 之後加入：

```ts
export type OcrReader = (robot: Robot) => Promise<OcrScreen>;

interface Reading {
	choice: ElementChoice;
	screen: Dimensions;
	source: string;
}

// ocr elements already read are merged in, the screen is not read twice
const chooseFromTree = async (robot: Robot, target: string, ocr: ScreenElement[], source: string): Promise<Reading> => {
	const tree = await robot.getElementsOnScreen();
	const screen = await currentViewport(robot, tree);
	const elements = compactElements(mergeOcrElements(tree, ocr), screen);
	return { choice: await chooseElement(target, elements, screen), screen, source };
};

// ocr first, it costs about a second where a flutter debug dump costs 6-10
const choose = async (robot: Robot, target: string, readOcr: OcrReader | null): Promise<Reading> => {
	if (!readOcr) {
		return chooseFromTree(robot, target, [], "accessibility tree");
	}

	let ocr: OcrScreen;
	try {
		ocr = await readOcr(robot);
	} catch (err: any) {
		// a failed screenshot or vision run must not block a target the tree has
		return chooseFromTree(robot, target, [], `accessibility tree (OCR failed: ${err?.message ?? err})`);
	}

	const choice = await chooseElement(target, ocr.elements, ocr.screen);
	if (isConfident(choice)) {
		return { choice, screen: ocr.screen, source: "OCR" };
	}

	return chooseFromTree(robot, target, ocr.elements, "OCR + accessibility tree");
};
```

`tapByDescription` 改為（迴圈其餘部分不變）：

```ts
/**
 * Lets Jev pick the element matching `target` from OCR text first and from the
 * accessibility tree (merged with that OCR text) only when unsure, then taps it.
 * Taps nothing when unsure; reads the screen once more when the chosen ref went stale.
 */
export const tapByDescription = async (robot: Robot, target: string, readOcr: OcrReader | null = isOcrSupported() ? readScreenText : null): Promise<string> => {
	for (let attempt = 1; ; attempt++) {
		const { choice, screen, source } = await choose(robot, target, readOcr);
		const element = choice.element;
		// ...（不變：無把握 → ActionableError；tapByRef / tap；stale-ref continue；成功訊息）
```

刪除原本的 `tree`／`screen`／`source`／兩段 `chooseElement` 共 7 行。`mergeOcrElements(tree, [])` 等於 `tree`，所以非 macOS 與 OCR 失敗路徑送給 Jev 的元素與現況相同。

- [ ] **Step 6: 驗證**

```bash
npx playwright test test/jev.test.ts test/ocr.test.ts   # 全部 PASS
npm test                                                # 全部 PASS（含 server-annotations，有 key／無 key 各跑一次）
TYPESAFE_API_KEY=x npm test
npm run lint                                            # 無錯誤
npm run build                                           # tsc 通過
```

- [ ] **Step 7: Commit（僅在使用者要求時）** `feat(tap): read the screen with OCR first and dump only when Jev is unsure`

### Task 2: README 更新

**Files:**
- Modify: `README.md`（`## Tap by description with Jev (optional)` 一節）
- Modify: `README.zh-TW.md`（對應一節）

- [ ] **Step 1**：流程第 1–3 點改為：macOS 上先截圖 OCR 問 Jev → 無把握才讀無障礙樹（精簡規則不變）並與已讀 OCR 合併再問一次；非 macOS 只讀樹；OCR 失敗時退回只讀樹。範例回傳改列 `from OCR` 與 `from OCR + accessibility tree` 各一。
- [ ] **Step 2**：限制補兩條：文字目標若只靠 OCR 就有把握，改以座標點擊、失去 stale-ref 防護（spec §5.3）；原生畫面與圖示目標每次多約 1–1.5 秒 OCR（spec §4 方案 A 代價）。隱私段改為「OCR 文字每次點擊都會送出」。
- [ ] **Step 3: 驗證**：`npm run lint`（README 不在 lint 範圍，僅確認未誤動程式碼）；目視比對兩語版本內容一致。
- [ ] **Step 4: Commit（僅在使用者要求時）** `docs(readme): describe OCR-first mobile_tap`

### Task 3: 實機驗收（驗收 3，手動）

前置：Task 1 完成並 `npm run build`；以本分支安裝為 MCP（`claude mcp add jev-mobile-mcp -e TYPESAFE_API_KEY=... -- node <repo>/lib/index.js` 或 `npx -y github:Yomiamy/jev-mobile-mcp#feat/ocr-first-tap`）。

- [ ] Pixel 9a 模擬器（Android 17）、FindRestaurant debug build，重跑 spec §1 的 10 步流程。
- [ ] 記錄：10 步是否全部成功、總秒數（目標 < 122 秒）、每步 `mobile_tap` 回傳的 `from` 來源與信心。
- [ ] 將結果補記到 spec §6（以實測取代估算）。

## 驗收對照

| 驗收 | 由誰覆蓋 |
|---|---|
| 1 OCR 有把握不 dump | Task 1 測試「OCR confident…」 |
| 2 退回時不重複 OCR | Task 1 測試「OCR unsure…」 |
| 3 實機 | Task 3 |
| 4 方向來自截圖 | Task 1 測試「OCR alone takes the orientation…」 |
| 5 錯誤訊息 | Task 1 測試「unsure on both…」 |
| 6 非 macOS 不變 | Task 1 測試「without OCR support…」＋ Step 2 既有測試 |
| 7 stale-ref 重試 | Task 1 測試「a stale ref from the tree fallback…」 |
| 8 OCR 失敗不擋點擊 | Task 1 測試「an OCR failure falls back…」 |
| 9 工具清單、既有測試、lint | Task 1 Step 6（`npm test` 有／無 key、`npm run lint`） |

## 執行方式

- **subagent-driven**：Task 1 與 Task 2 寫入路徑不重疊（`src/`＋`test/` vs README），可由兩個 subagent 平行執行；Task 2 依本計畫描述撰寫即可，不需等 Task 1 的程式碼。Task 3 依賴 Task 1 完成與 build，且需要使用者的模擬器與 app，由使用者或主 session 在最後執行。
- **parallel session**：一個 session 做 Task 1（TDD：Step 3 紅 → Step 4–5 綠 → Step 6），另一個做 Task 2；兩者完成後於同一 session 執行 Task 3。
- Task 1 內部的 Step 4（`ocr.ts`）與 Step 5（`jev.ts`）有型別相依（`OcrScreen`），須依序進行，不再拆分。
