# jev-mobile-agent

[English](README.md) | **繁體中文**

Mobile agent testing by jev decision and ocr detection

基於 [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) 的 MCP server，讓 AI agent 操作 Android / iOS 裝置、模擬器。上游功能全數保留，本 repo 在「無障礙樹」與「截圖」之間加了一層 **OCR**，減少 agent 必須看截圖才能找到點擊目標的次數。

## 為什麼需要 OCR

上游的元件定位只有兩條路：

1. `mobile_list_elements_on_screen`：讀無障礙樹，回傳 ref、座標與 label。快、便宜、準。
2. `mobile_take_screenshot`：樹裡找不到時，把截圖丟給模型目測，再依縮放比例換算座標。慢、耗 token、準度看模型視覺能力。

問題是很多畫面的文字根本不在無障礙樹裡——Flutter `Drawer` 沒輸出 semantics、canvas 繪製的 UI、文字嵌在圖片裡。這時只能退到截圖。

本 repo 在兩者之間補上 OCR：**樹裡找不到文字，先在本機用 OCR 讀出文字與座標，還找不到才截圖。**

```
list_elements_on_screen            ← 無障礙樹（預設）
        │ 找不到目標文字
        ▼
list_elements_on_screen(ocr: true) ← 無障礙樹 + OCR 補充（本 repo 新增）
        │ 目標是圖示、OCR 也讀不到
        ▼
take_screenshot                    ← 模型目測（最後手段）
```

## 改動內容

| 檔案 | 內容 |
|---|---|
| `src/ocr.ts` | OCR 本體：截圖 → macOS Vision 辨識 → 換算成螢幕座標 → 與無障礙樹去重 |
| `src/server.ts` | `mobile_list_elements_on_screen` 新增 `ocr` 參數；樹為空時提示改用 `ocr: true` |
| `src/format-elements.ts` | 沒有 ref 的元素（OCR 結果、legacy 模式）輸出中心點 `tap=x,y` |
| `skills/mobile-automation/SKILL.md` | 告訴 agent 何時該用 OCR |
| `src/compact-elements.ts` | 精簡元素清單（只留畫面內、去掉空容器、重複 label 只留一次），長度約減少 60% |
| `src/jev.ts` | `mobile_tap` 背後的 Jev 元素選擇（選用，見下方） |

### `ocr` 參數

```jsonc
// mobile_list_elements_on_screen
{ "device": "Pixel_6", "ocr": true }   // 預設 false
```

OCR 結果以 `OcrText` 附加在無障礙樹元素之後：

```
@e65 Button at=11,139 size=126x126
@e66 Header text="尋找餐廳" label="尋找餐廳" at=189,162 size=252x79
OcrText text="關鍵字過濾" at=150,623 size=216x48 tap=258,647
OcrText text="我的位置" at=118,1063 size=202x50 tap=219,1088
OcrText text="設定" at=146,1360 size=91x46 tap=192,1383
```

- **`tap=x,y` 是已算好的中心點**，直接傳給 `mobile_click_on_screen_at_coordinates`。`at=` 是左上角，不必讓模型自己算中心。
- **座標已是螢幕座標**：Vision 回傳相對於截圖的正規化座標，截圖涵蓋整個螢幕，乘上螢幕尺寸即可，不受截圖縮放與 iOS point / pixel 差異影響。
- **去重**：OCR 框中心落在某個無障礙元素內、且文字相同（只比對字母與數字，忽略 `·`/`•`、空白等差異）時丟棄，只留下樹裡沒有的東西。
- **OCR 元素沒有 ref**，只能用座標點擊。

### 何時會觸發

由 agent 依工具說明判斷，server 不自動開啟（`list` 是最常呼叫的工具，每次都跑 OCR 會拖慢所有操作）：

- 上一次 list 找不到要點的文字 → 帶 `ocr: true` 重新 list。
- 無障礙樹完全為空時，回傳內容會附上 `Retry with ocr: true` 提示。

## 用 Jev 依描述點擊（選用）

設定 [TypeSafe](https://docs.typesafe.ai) API key 後，server 會多註冊一個 `mobile_tap`。agent 只要描述要點什麼，不必讀完整的元素清單，由 TypeSafe 的 System One 模型 [Jev](https://docs.typesafe.ai/introduction) 選出元素（做法同 [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)）。

```jsonc
// mobile_tap
{ "device": "Pixel_6", "target": "左上角的選單按鈕" }
// → Tapped @e65 Button "" at 74,202 (confidence 0.88, from accessibility tree)
```

1. 讀取無障礙樹並精簡：去掉畫面外的元素與空容器，子節點重複的 label 只留一次。
2. 問 Jev 哪個元素符合 `target`（一個 Choice 問題：每個元素一個選項，外加 NONE）。
3. 找不到或信心不足 → 加上 OCR 元素再問一次。
4. 仍然沒有把握 → **不點擊**，回傳最接近的候選，讓 agent 改用 `mobile_list_elements_on_screen`。
5. 讀取與點擊之間畫面變了（ref 失效）→ 重新讀取並重試一次。

Jev 只能從實際觀察到的元素中挑選，模型不會編造座標。agent 每一步只送一句短描述，不必讀 3,000–7,000 字元的元素清單。

在 FindRestaurant 上，5 個目標全部點對（包含靠位置找到的純圖示按鈕，以及靠 OCR 找到的側選單項目）；畫面上不存在的那個目標被拒絕，而不是亂猜。

**設定**：沒有 `TYPESAFE_API_KEY` 時不會註冊這個工具，一切維持原樣。

```bash
claude mcp add -e TYPESAFE_API_KEY=<你的 key> jev-mobile -- npx -y github:Yomiamy/jev-mobile-agent#feat/ocr-list-elements
```

`TYPESAFE_MODEL` 可覆寫使用的模型（預設 `jev-latest`）。

> **隱私**：`mobile_tap` 會把畫面上元素的文字（使用 OCR 時連同 OCR 文字）送到 TypeSafe。畫面可能含有帳號 email 等個人資料，請只在可接受的情境啟用。

限制：不在無障礙樹裡的圖示找不到（OCR 只讀文字）。信心門檻 0.5 是手動訂的，應依實測紀錄調整。每次點擊的時間大多花在 `dump ui`（某些畫面要好幾秒），而不是 Jev（每次請求約 0.3 秒）。

## 實測

以 Flutter app「FindRestaurant」在 Pixel 6 模擬器上跑 11 步流程（開 app → 捲動 → 開側選單 → 關鍵字過濾 → 取消 → 我的位置 → 等待重新載入）：

- 側選單項目在無障礙樹中**完全不存在**，兩次都靠 OCR 一次取得正確座標並點中。
- 全程 **0 次截圖**，77 秒完成，無重試。
- OCR 與無障礙樹對同一元素的中心點誤差約 8px。

## 限制

- **僅支援 macOS**：使用系統內建的 Vision framework（經 `osascript` JXA 呼叫，無需編譯、不增加 npm 相依）。其他平台傳 `ocr: true` 會回錯誤，其餘功能不受影響。
- **只讀文字，不認圖示**：只有圖示的按鈕（愛心、漢堡選單）仍需截圖或靠座標。根本解法是在 app 端補 `tooltip` / `Semantics(label:)`。
- **會有雜訊**：圖示、星等、低對比文字可能被誤讀（例如 `$$` 讀成 `$s`）。不以 confidence 過濾，因為 Vision 的 confidence 分辨不出雜訊與有效目標，交給模型依語意挑選。
- **較慢**：每次 `ocr: true` 約多 1–1.5 秒（含截圖）。
- 橫向畫面與 iOS 模擬器尚未實測。

## 安裝

### 從 GitHub 安裝（團隊使用）

需要本 repo 的讀取權限。`prepare` 會在安裝時自動 build。

```bash
claude mcp add jev-mobile -- npx -y github:Yomiamy/jev-mobile-agent#feat/ocr-list-elements
```

或在專案根目錄提交 `.mcp.json`，讓團隊開啟專案時自動提示啟用：

```json
{
  "mcpServers": {
    "jev-mobile": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:Yomiamy/jev-mobile-agent#feat/ocr-list-elements"]
    }
  }
}
```

**更新版本**：npx 會沿用已安裝的快取，不會自動抓分支上的新 commit。push 新版後需刪除快取再重新連線：

```bash
grep -l 'jev-mobile-agent.git' ~/.npm/_npx/*/package-lock.json   # 找出快取目錄
rm -rf ~/.npm/_npx/<該目錄>
# 接著在 Claude Code 執行 /mcp → jev-mobile → Reconnect
```

### 本機開發

```bash
npm ci && npm run build
claude mcp add jev-mobile -- node /path/to/jev-mobile-agent/lib/index.js
```

改完 `src/` 後 `npm run build`，再到 `/mcp` 重新連線即可生效。

> 若同時裝了上游的 `mobile-mcp`，兩者工具名稱相同，建議在測試時停用其中一個，避免 agent 呼叫到錯的版本。

## 與上游同步

上游以 `upstream` remote 追蹤、以 merge 合流，保留上游歷史。同步流程見 `.claude/skills/gen-sync-mobile-mcp/SKILL.md`。

## 授權

上游 mobile-mcp 以 Apache-2.0 授權，原始授權條款保留於 [`LICENSE-mobile-mcp`](LICENSE-mobile-mcp)。
