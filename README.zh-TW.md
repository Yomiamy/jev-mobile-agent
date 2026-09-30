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
