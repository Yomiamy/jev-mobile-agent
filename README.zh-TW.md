# jev-mobile-mcp

[English](README.md) | **繁體中文**

Mobile agent testing by jev decision and ocr detection

基於 [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) 的 MCP server，讓 AI agent 操作 Android / iOS 裝置、模擬器。上游功能全數保留，本 repo 在「無障礙樹」與「截圖」之間加了一層 **OCR**，減少 agent 必須看截圖才能找到點擊目標的次數。

## 為什麼需要 OCR

上游的元件定位只有兩條路：

1. `mobile_list_elements_on_screen`：讀無障礙樹，回傳 ref、座標與 label。快、便宜、準。
2. `mobile_take_screenshot`：樹裡找不到時，把截圖丟給模型目測，再依縮放比例換算座標。慢、耗 token、準度看模型視覺能力。

問題是很多畫面的文字根本不在無障礙樹裡——Flutter `Drawer` 沒輸出 semantics、canvas 繪製的 UI、文字嵌在圖片裡。這時只能退到截圖。

本 repo 在兩條路徑上加入 OCR，讓截圖變成最後手段：

**`mobile_tap`（有 TypeSafe key 時）：先 OCR。** OCR 約 1–1.5 秒，在 Flutter debug build 上讀無障礙樹卻要 6–10 秒，所以只有 OCR 不夠時才讀樹。

```
mobile_tap(target)
        │
        ▼
OCR（截圖 + Vision）               ← 先讀，由 Jev 挑文字
        │ 沒有把握的結果
        ▼
無障礙樹 + OCR 合併                ← 這時才讀樹，再問 Jev 一次
        │ 仍然沒有把握
        ▼
不點擊，回傳候選 → agent 改走下方路徑
```

**`mobile_list_elements_on_screen`：先讀樹，OCR 需明確要求。** `list` 是最常呼叫的工具，server 不會自動開啟 OCR。

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
| `src/compact-elements.ts` | 精簡元素清單，有沒有 TypeSafe key 都會生效：只留目前畫面範圍內的元素（見[畫面範圍與旋轉](#畫面範圍與旋轉)）、去掉空容器、重複的多行（合併）label 只留一次，長度約減少 60% |
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
- **座標已是螢幕座標**：Vision 回傳相對於截圖的正規化座標，截圖涵蓋整個螢幕，乘上目前的畫面範圍即可，不受截圖縮放與 iOS point / pixel 差異影響，螢幕旋轉後也能正確換算（見[畫面範圍與旋轉](#畫面範圍與旋轉)）。
- **去重**：OCR 框中心落在某個無障礙元素內、且文字相同（只比對字母與數字，忽略 `·`/`•`、空白等差異）時丟棄，只留下樹裡沒有的東西。
- **OCR 元素沒有 ref**，只能用座標點擊。

### 何時會觸發

由 agent 依工具說明判斷，server 不會替 `list` 自動開啟（`list` 是最常呼叫的工具，每次都跑 OCR 會拖慢所有操作）。`mobile_tap` 則不同，每次點擊都先跑 OCR（見下方）。`list` 的觸發時機：

- 上一次 list 找不到要點的文字 → 帶 `ocr: true` 重新 list。
- 無障礙樹完全為空時，回傳內容會附上 `Retry with ocr: true` 提示。

設計、方案取捨與完整測試紀錄：[規格](docs/features/2026-10-01-ocr-list-elements.md) · [計畫](docs/plans/2026-10-01-ocr-list-elements.md)。

### 畫面範圍與旋轉

元素清單只保留目前畫面範圍內的元素，OCR 也換算到同一個範圍。畫面範圍依以下順序決定：

1. **dump 中的視窗根元素**：位於 `0,0`、寬高等於螢幕尺寸或其對調的元素，例如 `android:id/content`、Flutter 的根元素。
2. robot 回報的螢幕方向，用來把回報的尺寸轉到正確方向。
3. 直接使用 robot 回報的尺寸。

robot 回報的方向只當退路，因為它不可靠：在 Pixel 6 模擬器上開啟自動旋轉、把 Chrome 轉成橫向（`ROTATION_270`，2400x1080）時，mobilecli 仍回報 `portrait`、1080x2400。只信任這個回報時，x ≥ 1080 的 36 個元素全被刪掉；改用視窗根元素判斷後全部保留。

## 用 Jev 依描述點擊（選用）

設定 [TypeSafe](https://docs.typesafe.ai) API key 後，server 會多註冊一個 `mobile_tap`。agent 只要描述要點什麼，不必讀完整的元素清單，由 TypeSafe 的 System One 模型 [Jev](https://docs.typesafe.ai/introduction) 選出元素（做法同 [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)）。

```jsonc
// mobile_tap
{ "device": "Pixel_6", "target": "左上角的選單按鈕" }
// → Tapped @e65 Button "" at 74,202 (confidence 0.62, from OCR + accessibility tree)
{ "device": "Pixel_6", "target": "關鍵字過濾" }
// → Tapped OcrText "關鍵字過濾" at 257,663 (confidence 0.81, from OCR)
```

1. 先截圖跑 OCR，問 Jev 哪個文字符合 `target`（一個 Choice 問題：每個元素一個選項，外加 NONE）。畫面方向由截圖本身判斷。OCR 很便宜（約 1–1.5 秒），在 Flutter debug build 上讀無障礙樹卻要 6–10 秒（見下方）。
2. 找不到或信心不足 → 讀取無障礙樹並精簡（去掉畫面外的元素與空容器，子節點重複的多行（合併）label 只留一次），與第 1 步已讀到的 OCR 元素合併後再問一次，不會再跑第二次 OCR。
3. server 不在 macOS 上執行（沒有 OCR），或截圖／OCR 失敗時，直接走第 2 步、只讀無障礙樹。
4. 仍然沒有把握 → **不點擊**，回傳最接近的候選，讓 agent 改用 `mobile_list_elements_on_screen`。
5. 讀取與點擊之間畫面變了（ref 失效）→ 重新讀取畫面與畫面範圍，再重試一次。

有 ref 的元素用 ref 點擊；沒有 ref 的元素（OCR 元素）點擊它可見部分的中心，並保證落在畫面範圍內。Jev 只能從實際觀察到的元素中挑選，模型不會編造座標。agent 每一步只送一句短描述，不必讀 3,000–7,000 字元的元素清單。

**設定**：沒有 `TYPESAFE_API_KEY` 時不會註冊 `mobile_tap`，也不會送出任何資料到 TypeSafe。server 名稱必須放在 `-e` **前面**，否則 `-e` 會把名稱也當成環境變數吃掉：

```bash
claude mcp add jev-mobile-mcp -e TYPESAFE_API_KEY=<你的 key> -- npx -y github:Yomiamy/jev-mobile-mcp#main
```

共用的 `.mcp.json` 不要寫入 key，改為引用環境變數：`"env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" }`。`TYPESAFE_MODEL` 可覆寫使用的模型（預設 `jev-latest`）。

> **隱私**：`mobile_tap` 每次點擊都會把 OCR 讀到的畫面文字送到 TypeSafe，需要讀無障礙樹時連同元素文字一起送出。畫面可能含有帳號 email 等個人資料，請只在可接受的情境啟用。

限制：

- 不在無障礙樹裡的圖示找不到（OCR 只讀文字）。
- 圖示目標與原生畫面（launcher 讀樹只要 0.7 秒）每次點擊會多花約 1–1.5 秒：OCR 先跑一次沒把握，才去讀樹。
- 文字目標只靠 OCR 就有把握時，改用座標點擊，即使樹裡有 ref（例如對話框的「取消」）也一樣，因此沒有下方 ref 失效的保護。
- 畫面上有兩個相同的目標（例如桌面和 dock 上同一個 app 圖示）時，機率會被分散而拒絕點擊；請把描述寫得更具體，例如加上位置。
- 沒有 label 的按鈕只能靠位置判斷，信心偏低（實測 0.60–0.66）。在 app 端補上 `tooltip` / `Semantics(label:)` 即可改善。
- 信心門檻 0.5 是手動訂的，應依實測紀錄調整。
- 只有用 ref 點擊時，畫面變了才可能被擋下（mobilecli 會回報不在目前畫面上的 ref；但它是否能抓到每一種變化，取決於 mobilecli 怎麼編號 ref，這點尚未確認）。OCR 元素和 legacy robot 是用座標點擊，點擊前不會重新確認。

設計、方案取捨與完整測試紀錄：[規格](docs/features/2026-10-01-jev-tap.md) · [計畫](docs/plans/2026-10-01-jev-tap.md)。

## 實測

以 Flutter app「FindRestaurant」在 Pixel 6 模擬器上跑 11 步流程（開 app → 捲動 → 開側選單 → 關鍵字過濾 → 取消 → 我的位置 → 等待重新載入），兩種方式都在 120 秒限制內完成：

| | OCR，由 agent 選目標 | `mobile_tap`，由 Jev 選目標 |
|---|---:|---:|
| 總耗時 | 77 秒 | 89 秒 |
| 重試 | 0 | 1（兩個相同的 app 圖示） |
| 回傳給 agent 的工具結果（估算） | ≈ 49,600 字元 | ≈ 8,500 字元（−80%） |
| 截圖 | 0 | 0 |

- 側選單項目在無障礙樹中**完全不存在**，每次都靠 OCR 找到，Jev 選中它們的信心為 0.92–0.95。
- OCR 與無障礙樹對同一元素的中心點誤差約 8px。
- 旋轉：開啟自動旋轉、Chrome 轉成橫向時，畫面範圍為 2400x1080，x ≥ 1080 的元素全部保留在清單中；直向的 FindRestaurant 仍為 1080x2400。
- 用 Jev 並沒有比較快，因為每次 `mobile_tap` 都要重新讀取畫面，而這個 app 讀取畫面很慢（見下方）。Jev 本身每次請求約 0.3 秒。token 有一部分是轉移而不是省下：改由 Jev 讀元素表，而 Jev 端的用量目前還沒記錄。

### Flutter debug build 為什麼讀取畫面很慢

對可除錯的 Flutter app，mobilecli（1.0.16）不使用 Android 的無障礙 dump，而是透過 Dart VM service 走訪整棵 render tree：每個 render object 要 10–25 次呼叫，而且連畫面外預先渲染的列、背後的前一頁都會走訪。沒有任何選項可以關閉這條路徑。

| 情況 | `dump ui` 耗時 |
|---|---:|
| 原生畫面（launcher） | 0.7 秒 |
| Flutter debug build（VM service 走訪） | 6.3–10.2 秒 |

改用 profile 或 release build 時，mobilecli 會改走無障礙 dump，應該會快很多，而且會把按鈕的 tooltip 帶出來當 label；這點還沒實際量測。

## 限制

- **僅支援 macOS**：使用系統內建的 Vision framework（經 `osascript` JXA 呼叫，無需編譯、不增加 npm 相依）。其他平台傳 `ocr: true` 會回錯誤，其餘功能不受影響。
- **只讀文字，不認圖示**：只有圖示的按鈕（愛心、漢堡選單）仍需截圖或靠座標。根本解法是在 app 端補 `tooltip` / `Semantics(label:)`。
- **會有雜訊**：圖示、星等、低對比文字可能被誤讀（例如 `$$` 讀成 `$s`）。不以 confidence 過濾，因為 Vision 的 confidence 分辨不出雜訊與有效目標，交給模型依語意挑選。
- **較慢**：每次 `ocr: true` 約多 1–1.5 秒（含截圖）。
- **螢幕旋轉**：橫向只在 Android 模擬器上實測過，iOS 模擬器尚未實測。dump 中找不到全螢幕的視窗根元素時（非 edge-to-edge 的 App、分割畫面、legacy WDA 已濾掉根類型），會退回 robot 回報的方向，而 mobilecli 與 legacy Android robot（`user_rotation`）回報的方向都可能錯誤。

## 安裝

### 從 GitHub 安裝（團隊使用）

需要本 repo 的讀取權限。`prepare` 會在安裝時自動 build。

```bash
claude mcp add jev-mobile-mcp -- npx -y github:Yomiamy/jev-mobile-mcp#main
```

或在專案根目錄提交 `.mcp.json`，讓團隊開啟專案時自動提示啟用：

```json
{
  "mcpServers": {
    "jev-mobile-mcp": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:Yomiamy/jev-mobile-mcp#main"]
    }
  }
}
```

**更新版本**：npx 會沿用已安裝的快取，不會自動抓分支上的新 commit。push 新版後需刪除快取再重新連線：

```bash
grep -l 'jev-mobile-mcp.git' ~/.npm/_npx/*/package-lock.json   # 找出快取目錄
rm -rf ~/.npm/_npx/<該目錄>
# 接著在 Claude Code 執行 /mcp → jev-mobile-mcp → Reconnect
```

### 本機開發

```bash
npm ci && npm run build
claude mcp add jev-mobile-mcp -- node /path/to/jev-mobile-mcp/lib/index.js
```

改完 `src/` 後 `npm run build`，再到 `/mcp` 重新連線即可生效。

> 若同時裝了上游的 `mobile-mcp`，兩者工具名稱相同，建議在測試時停用其中一個，避免 agent 呼叫到錯的版本。

## 與上游同步

上游以 `upstream` remote 追蹤、以 merge 合流，保留上游歷史。同步流程見 `.claude/skills/gen-sync-mobile-mcp/SKILL.md`。

## 授權

上游 mobile-mcp 以 Apache-2.0 授權，原始授權條款保留於 [`LICENSE-mobile-mcp`](LICENSE-mobile-mcp)。
