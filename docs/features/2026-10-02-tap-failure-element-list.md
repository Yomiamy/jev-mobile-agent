# 功能規格：mobile_tap 失敗時附上元素清單

- **分支**：未建立（建議 `feat/tap-failure-element-list`）
- **狀態**：STAGE 0a 規格，尚未實作
- **前置**：`mobile_tap`（[2026-10-01-jev-tap.md](2026-10-01-jev-tap.md)）與 OCR-first（[2026-10-01-ocr-first-tap.md](2026-10-01-ocr-first-tap.md)）已在 `main`

## 1. 問題

`mobile_tap` 沒把握時不點擊，只在 `ActionableError` 附前 3 名候選（`src/jev.ts` `CANDIDATES_SHOWN = 3`、`tapByDescription` 的 `Nothing tapped` 訊息），工具說明（`src/server.ts` `mobile_tap` description）又要 agent「fall back to mobile_list_elements_on_screen then」。於是 agent 的失敗路徑是：

```
mobile_tap → Nothing tapped（3 名候選）
  → mobile_list_elements_on_screen   ← 重讀畫面
  → mobile_click_on_screen_at_coordinates
```

中間那次 `list` 是白付的：

- **多一次 dump**：Flutter debug build 上 `dump ui` 每次 6.3–10.2 秒（jev-tap 規格 §7）。而 `mobile_tap` 失敗前**剛剛**才 dump 過同一個畫面。
- **多一次模型請求**：agent 要多一輪 tool call 才拿得到清單。

失敗路徑必定經過 `chooseFromTree`（OCR 無把握退回、OCR 失敗、server 不在 macOS 三種情況皆然；OCR 單獨那一步只在有把握時回傳），那裡已算出 `elements = compactElements(mergeOcrElements(tree, ocr), screen)`，只是沒放進 `Reading` 回傳就丟了。

## 2. 使用者故事

身為以 `mobile_tap` 操作 app 的 agent，當 `mobile_tap` 找不到有把握的目標時，我希望錯誤訊息直接附上整個畫面的精簡元素清單，讓我能從中挑一個 ref 或座標交給 `mobile_click_on_screen_at_coordinates`，不必再呼叫 `mobile_list_elements_on_screen` 多等一次 dump。

## 3. 範圍

**做**
1. `Nothing tapped` 錯誤在既有的 `Closest: ...` 之後，附上本次判斷所用的完整元素清單，格式為 `formatElements(elements, "text")`，即與 `mobile_list_elements_on_screen` 預設輸出相同（標頭行 + 每元素一行，有 ref 印 ref、無 ref 印 `tap=x,y`）。
2. `mobile_tap` description 改為：沒把握時不點擊，回傳候選與畫面元素清單，**從中挑一個**交給 `mobile_click_on_screen_at_coordinates`；只有畫面已經變了才需要 `mobile_list_elements_on_screen`。
3. 單元測試驗證失敗訊息含清單。

**不做**
- 修改 `mobile_list_elements_on_screen` 的行為或輸出。
- 修改 `CANDIDATES_SHOWN`。
- 修改成功路徑、Jev 的選擇邏輯、`MIN_CONFIDENCE`。
- 失敗後自動重試或自動點候選。
- 其他錯誤附清單：TypeSafe HTTP 失敗、逾時、invalid answer、元素數 ≥ 255（`Too many elements`）。這些錯誤在 `chooseElement` 內拋出，不經 `Nothing tapped` 路徑，維持現況。

## 4. 行為規格

### 4.1 訊息格式

```
Nothing tapped: no element matches "<target>" confidently (confidence 0.31, searched OCR + accessibility tree). Closest: @e12 Button "設定" at 540,1200 (0.31), ...
Elements on screen:
One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [tap=x,y when no ref] [focused] [selected] [checked] [disabled]
@e3 Button label="Open navigation menu" at=0,63 size=147x147
OcrText text="關鍵字過濾" at=60,820 size=240x52 tap=180,846
...
```

第一行與現況逐字相同（既有測試與 agent 的解讀不受影響），清單接在其後。分隔標題的確切字樣由實作計畫決定。

### 4.2 邊界情況

| 情況 | 行為 |
|---|---|
| 清單為空（dump 與 OCR 都沒有可用元素；`chooseElement` 對空陣列直接回 NONE、`ranked` 為空） | 不輸出只剩標頭行的空清單，改為明講畫面上沒有元素（例如 `Elements on screen: none`）。不加「改用 `ocr: true`」提示——macOS 上 OCR 已經跑過 |
| OCR 元素（`type: "OcrText"`，無 ref） | 沿用 `formatElements`：印 `OcrText text="..." at=x,y size=WxH tap=x,y`，agent 以 `tap=` 座標點擊。與 `list` 的 `ocr: true` 呈現一致 |
| server 在 macOS | 清單包含合併後的 OCR 元素，比 `list` 預設（`ocr: false`）多出 `OcrText`。格式相同、內容較豐富；這是「與 list 輸出相同」的唯一差異，屬預期 |
| OCR 失敗或 server 不在 macOS | 清單只有樹的元素，等同 `list` 預設輸出 |
| 第 2 次嘗試（stale ref 重讀後）才失敗 | 附上第 2 次讀到的清單（即最後一次 dump） |
| 非 mobilecli robot（legacy `android.ts`／`ios.ts`） | 元素本來就沒有 ref，全部印 `tap=`；與 `list` 相同 |

### 4.3 ref 相容性（實查結論：相容）

- ref 由 mobilecli 在 `dump ui` 時產生（`src/mobile-device.ts` `flattenUIElement` 原樣搬運 `element.ref`），本 repo 不快取、不改寫。
- `mobile_click_on_screen_at_coordinates` 以 `robot.tapByRef(ref)` → `mobilecli io tap <ref>` 點擊，ref 依「最新一次 dump」解析（測試中的錯誤訊息：`refs come from the latest 'dump ui'`）。
- 失敗訊息中的清單來自 `chooseFromTree` 剛做的那次 dump，就是**最新一次 dump**；`mobile_tap` 自己的成功路徑也是在同樣條件下以 `tapByRef` 點擊。因此清單 ref 與 click 工具相容，語意等同「`list` 後立即 click」。
- 失效條件與 `list` 相同：畫面改變，或之後任何工具（另一次 `mobile_tap`、`list`）重新 dump。不新增風險。

## 5. 代價：失敗訊息變長

精簡後的清單在 FindRestaurant 首頁實測約 3,090–3,129 字元（jev-tap 規格 §6），加上 OCR 元素再多一些。

| 情況 | 現況 | 本案 |
|---|---|---|
| 失敗後 agent 改用 `list` → click（本案目標情境） | 失敗訊息 + `list` 輸出約 3,000 字元 + 一次 dump（6–10 秒）+ 一次模型請求 | 失敗訊息含約 3,000 字元清單；省掉 dump 與一次請求。字元數約持平 |
| 失敗後 agent 只改寫描述再 `mobile_tap` | 失敗訊息（數百字元） | 每次失敗多約 3,000 字元，純成本 |

取捨：主要情境下 token 持平、省 6–10 秒與一輪請求；改寫描述重試的情境每次多約 3,000 字元。失敗屬少數路徑，接受此代價。

## 6. 與既有規格的關係

- [2026-10-01-ocr-first-tap.md](2026-10-01-ocr-first-tap.md) §5.1（資料流「無把握 → 拋 ActionableError（附 source 與前 3 名候選）」）與 §5.4（「行為同現況（拒絕並附候選，agent 需改寫描述）」）：本案在其後**追加**清單，候選與 source 不變。
- [2026-10-01-jev-tap.md](2026-10-01-jev-tap.md) 目標 3「沒把握就不點，回傳最接近的候選，讓 agent 退回 `list`」：改為「回傳候選與清單，agent 直接挑」；`list` 只在畫面已變時需要。

## 7. 驗收標準

1. **失敗訊息含清單**（單元測試）：假 robot 的樹含有 ref 元素，Jev 回 NONE 時拋出的錯誤訊息包含 `Nothing tapped`、既有 `Closest:` 段落，以及該元素以 `formatElements` text 格式產生的那一行（含 `@eN` 與 `at=`），且不呼叫 `tap`／`tapByRef`。
2. **低信心同樣附清單**（單元測試）：Jev 選中元素但信心 < `MIN_CONFIDENCE` 時，訊息同樣含清單。
3. **OCR 元素以座標呈現**（單元測試）：OCR 無把握退回樹後仍失敗時，清單含 `OcrText ... tap=x,y` 行，且無 ref。
4. **空清單**（單元測試）：樹與 OCR 皆無元素時，訊息明講沒有元素，不出現只有標頭行的清單。
5. **第一行不變**（既有測試）：既有對 `Nothing tapped`、`searched ...`、`Closest` 的斷言全部照舊通過。
6. **description 更新**：`mobile_tap` description 不再要求失敗後 `mobile_list_elements_on_screen`，改為從回傳的候選或清單挑選，畫面已變才 list。
7. **不動 list**：`mobile_list_elements_on_screen` 的既有測試不需修改即通過；所有既有測試與 `npm run lint` 通過。

## 8. 已知限制與風險

| 項目 | 說明 |
|---|---|
| 改寫描述重試時變貴 | 每次失敗多約 3,000 字元（§5） |
| `tap=` 與 `Closest` 座標可能不同 | `formatElements` 的 `tap=` 取整個 rect 中心；`Closest` 用 `centerOf`，裁到畫面內。部分在畫面外的元素兩者不同，`tap=` 甚至可能落在畫面外。這是 `list` 既有行為，本案不修，但同一則訊息內會並列兩種座標 |
| 清單與 `list` 預設不完全相同 | macOS 上多了 `OcrText` 元素（§4.2），agent 不會在 `list` 預設輸出看到它們 |
| 失敗後畫面又變 | 與 `list` → click 相同：ref 失效時 click 報 `not found on current screen`，agent 需重新 list |
