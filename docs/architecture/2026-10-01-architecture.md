# jev-mobile-mcp 架構說明

（截至 2026-10-01）

fork 自 [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) 的 MCP server，讓 AI agent 操作 Android／iOS 裝置。上游以 `upstream` remote 追蹤、以 merge 同步。本文件描述本 repo 在上游之上的結構與差異。

## 1. 分層

```
MCP client（Claude 等 agent）
        │  MCP 工具呼叫（stdio / Streamable HTTP）
        ▼
src/server.ts              工具註冊與參數驗證（zod）
        │
        ▼
Robot 介面（src/robot.ts）
  ├─ MobileDevice（src/mobile-device.ts）     預設：所有指令轉給 mobilecli
  └─ legacy（MOBILEMCP_LEGACY_ROBOT=1）
       ├─ AndroidRobot（src/android.ts）      adb + uiautomator
       └─ IosRobot（src/ios.ts → src/webdriver-agent.ts）  WDA
        │
        ▼
裝置／模擬器
```

## 2. 讀取畫面的三層感知

agent 找點擊目標的順序：

| 層 | 工具 | 來源 | 特性 |
|---|---|---|---|
| 1 | `mobile_list_elements_on_screen` | 無障礙樹（mobilecli `dump ui`） | 快、便宜、有 ref |
| 2 | `mobile_list_elements_on_screen({ ocr: true })` | 無障礙樹 ＋ macOS Vision OCR | 補上樹中沒有的文字；本 repo 新增 |
| 3 | `mobile_take_screenshot` | 截圖由模型目測 | 最後手段 |

由 agent 依工具說明判斷何時改用下一層；無障礙樹完全為空時，`list` 的回傳會提示改用 `ocr: true`。

## 3. 本 repo 新增的模組

| 檔案 | 職責 |
|---|---|
| `src/ocr.ts` | 原尺寸截圖 → `osascript` JXA 呼叫 Vision → 正規化座標乘上螢幕尺寸換成 `OcrText` 元素 → 去掉樹中已有的文字後合併 |
| `src/format-elements.ts`（修改） | 沒有 ref 的元素（OCR、legacy robot）輸出中心點 `tap=x,y` |

## 4. 主要資料流：`mobile_list_elements_on_screen`

```
robot.getElementsOnScreen()           mobilecli dump ui → 攤平成 ScreenElement[]
  └─ ocr: true → withOcrElements()    getScreenSize() + getScreenshot() + Vision → 合併
formatElements(elements, format)      text：一行一個元素；json：陣列
```

## 5. 外部相依與已知特性

| 相依 | 用途 | 已知特性 |
|---|---|---|
| mobilecli | 預設路徑的所有裝置操作 | `dump ui` 在部分畫面一次需數秒；會列出畫面外的元素 |
| macOS Vision | OCR | 僅 macOS；只讀文字，不認圖示 |
| 上游 mobile-mcp | 基底程式 | 以 merge 同步；本 repo 盡量不改上游檔案以降低衝突 |
