# jev-mobile-agent

**English** | [繁體中文](README.zh-TW.md)

Mobile agent testing by jev decision and ocr detection

An MCP server built on [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) that lets AI agents drive Android / iOS devices, emulators and simulators. Every upstream feature is kept; this repo adds an **OCR** layer between the accessibility tree and screenshots, so agents need screenshots far less often to find what to tap.

## Why OCR

Upstream locates elements in only two ways:

1. `mobile_list_elements_on_screen`: reads the accessibility tree and returns refs, coordinates and labels. Fast, cheap, accurate.
2. `mobile_take_screenshot`: when the tree lacks the target, the model eyeballs a screenshot and converts positions by the scale ratio. Slow, token-heavy, and only as accurate as the model's vision.

Many screens never put their text into the accessibility tree: a Flutter `Drawer` without semantics, canvas-drawn UI, text baked into images. Those used to fall straight through to screenshots.

This repo adds OCR in between: **if the text is not in the tree, read text and positions locally with OCR first; take a screenshot only if that still fails.**

```
list_elements_on_screen            ← accessibility tree (default)
        │ target text not found
        ▼
list_elements_on_screen(ocr: true) ← tree + OCR supplement (added here)
        │ target is an icon, OCR cannot read it
        ▼
take_screenshot                    ← model eyeballs it (last resort)
```

## Changes

| File | Change |
|---|---|
| `src/ocr.ts` | The OCR itself: screenshot → macOS Vision → screen coordinates → dedupe against the tree |
| `src/server.ts` | New `ocr` parameter on `mobile_list_elements_on_screen`; an empty tree hints to retry with `ocr: true` |
| `src/format-elements.ts` | Elements without a ref (OCR results, legacy mode) get a center point `tap=x,y` |
| `skills/mobile-automation/SKILL.md` | Tells the agent when to use OCR |

### The `ocr` parameter

```jsonc
// mobile_list_elements_on_screen
{ "device": "Pixel_6", "ocr": true }   // defaults to false
```

OCR results are appended after the tree elements as `OcrText`:

```
@e65 Button at=11,139 size=126x126
@e66 Header text="尋找餐廳" label="尋找餐廳" at=189,162 size=252x79
OcrText text="關鍵字過濾" at=150,623 size=216x48 tap=258,647
OcrText text="我的位置" at=118,1063 size=202x50 tap=219,1088
OcrText text="設定" at=146,1360 size=91x46 tap=192,1383
```

- **`tap=x,y` is the precomputed center**; pass it straight to `mobile_click_on_screen_at_coordinates`. `at=` is the top-left corner, so the model no longer has to compute the center itself.
- **Coordinates are already screen coordinates**: Vision returns boxes normalized to the screenshot, and the screenshot covers the whole screen, so multiplying by the screen size is enough. Screenshot scaling and iOS points vs. pixels do not matter.
- **Dedupe**: an OCR box is dropped when its center lies inside a tree element with the same text (letters and digits only, ignoring `·`/`•`, spaces and the like), so only what the tree lacks remains.
- **OCR elements have no ref** and can only be tapped by coordinates.

### When it is used

The agent decides from the tool description; the server never turns OCR on by itself (`list` is the most frequent call, and running OCR every time would slow everything down):

- The text to tap is missing from the previous listing → list again with `ocr: true`.
- When the accessibility tree is completely empty, the result includes a `Retry with ocr: true` hint.

## Field test

An 11-step flow on the Flutter app "FindRestaurant" on a Pixel 6 emulator (open app → scroll → open side menu → keyword filter → cancel → my location → wait for reload):

- The side menu items are **entirely absent** from the accessibility tree; both times OCR returned the right coordinates on the first try.
- **Zero screenshots**, finished in 77 seconds with no retries.
- OCR and the accessibility tree agree on an element's center to within about 8px.

## Limitations

- **macOS only**: uses the built-in Vision framework (called through `osascript` JXA, so nothing to compile and no new npm dependency). On other platforms `ocr: true` returns an error; everything else is unaffected.
- **Text only, no icons**: icon-only buttons (heart, hamburger menu) still need a screenshot or known coordinates. The real fix is a `tooltip` / `Semantics(label:)` in the app.
- **Noise**: icons, star ratings and low-contrast text may be misread (e.g. `$$` as `$s`). Results are not filtered by confidence, because Vision's confidence cannot tell noise from valid targets; the model picks by meaning.
- **Slower**: each `ocr: true` adds roughly 1–1.5 seconds (including the screenshot).
- Landscape and iOS simulators are not tested yet.

## Installation

### From GitHub (for teams)

Requires read access to this repo. `prepare` builds on install.

```bash
claude mcp add jev-mobile -- npx -y github:Yomiamy/jev-mobile-agent#feat/ocr-list-elements
```

Or commit a `.mcp.json` at your project root so teammates are prompted to enable it when they open the project:

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

**Updating**: npx reuses its cached install and does not pick up new commits on the branch. After pushing a new version, delete the cache and reconnect:

```bash
grep -l 'jev-mobile-agent.git' ~/.npm/_npx/*/package-lock.json   # find the cache dir
rm -rf ~/.npm/_npx/<that-dir>
# then in Claude Code: /mcp → jev-mobile → Reconnect
```

### Local development

```bash
npm ci && npm run build
claude mcp add jev-mobile -- node /path/to/jev-mobile-agent/lib/index.js
```

After changing `src/`, run `npm run build` and reconnect in `/mcp`.

> If the upstream `mobile-mcp` is installed too, both expose the same tool names. Disable one while testing so the agent does not call the wrong version.

## Syncing with upstream

Upstream is tracked through an `upstream` remote and merged in, keeping its history. See `.claude/skills/gen-sync-mobile-mcp/SKILL.md` for the procedure.

## License

Upstream mobile-mcp is licensed under Apache-2.0; its original license is kept in [`LICENSE-mobile-mcp`](LICENSE-mobile-mcp).
