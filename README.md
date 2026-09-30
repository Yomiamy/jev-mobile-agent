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
| `src/compact-elements.ts` | Compacts the element list for every user, with or without a TypeSafe key: on-screen only, no empty containers, a repeated multi-line (merged) label once; about 60% shorter |
| `src/jev.ts` | Jev element choice behind `mobile_tap` (optional, see below) |

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

## Tap by description with Jev (optional)

With a [TypeSafe](https://docs.typesafe.ai) API key, the server also registers `mobile_tap`. The agent describes the target instead of reading the whole element list; [Jev](https://docs.typesafe.ai/introduction), TypeSafe's System One model, picks the element (the same approach as [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)).

```jsonc
// mobile_tap
{ "device": "Pixel_6", "target": "menu button at the top left" }
// → Tapped @e65 Button "" at 74,202 (confidence 0.88, from accessibility tree)
```

1. Read the accessibility tree and compact it: drop off-screen elements and empty containers, keep a multi-line (merged) label repeated by child nodes only once.
2. Ask Jev which element matches `target` (one Choice question: one option per element, plus NONE).
3. No match or low confidence → add OCR elements and ask once more.
4. Still no confident match → **nothing is tapped**; the closest candidates are returned so the agent can fall back to `mobile_list_elements_on_screen`.
5. If the screen changed between reading and tapping (stale ref), read it again and retry once.

Jev can only pick an observed element, so the model never makes up coordinates. The agent sends one short phrase instead of reading 3,000–7,000 characters of element list per step.

**Setup**: without `TYPESAFE_API_KEY`, `mobile_tap` is not registered and nothing is sent to TypeSafe. `mobile_tap` lives on the `feat/jev-decision` branch. Put the server name **before** `-e`, otherwise `-e` swallows the name as another variable:

```bash
claude mcp add jev-mobile -e TYPESAFE_API_KEY=<your key> -- npx -y github:Yomiamy/jev-mobile-agent#feat/jev-decision
```

For a shared `.mcp.json`, reference the variable instead of committing the key: `"env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" }`. `TYPESAFE_MODEL` overrides the model (default `jev-latest`).

> **Privacy**: `mobile_tap` sends the text of the on-screen elements (and OCR text when used) to TypeSafe. Screens can contain personal data such as account emails; enable it only where that is acceptable.

Limits:

- Icons missing from the accessibility tree cannot be found (OCR reads text only).
- Two identical targets on screen (e.g. the same app icon on the home screen and in the dock) split the probability and are refused; describe the target more precisely, e.g. by position.
- Buttons without a label are picked by position only, with lower confidence (0.60–0.66 in the field test). A `tooltip` / `Semantics(label:)` in the app fixes that.
- The confidence threshold (0.5) is hand-picked and should be tuned on recorded runs.
- Only taps by ref can be rejected when the screen changed (mobilecli reports a ref that is not on the current screen; whether it catches every change depends on how mobilecli numbers refs, which is not confirmed). OCR elements and legacy robots are tapped by coordinates, which are not re-checked.

Design, trade-offs and full test records: [spec](docs/features/2026-10-01-jev-tap.md) · [plan](docs/plans/2026-10-01-jev-tap.md).

## Field test

An 11-step flow on the Flutter app "FindRestaurant" on a Pixel 6 emulator (open app → scroll → open side menu → keyword filter → cancel → my location → wait for reload), each run within the 120-second budget:

| | OCR, agent picks targets | `mobile_tap`, Jev picks targets |
|---|---:|---:|
| Total time | 77 s | 89 s |
| Retries | 0 | 1 (two identical app icons) |
| Tool results returned to the agent (estimate) | ≈ 49,600 chars | ≈ 8,500 chars (−80%) |
| Screenshots | 0 | 0 |

- The side menu items are **entirely absent** from the accessibility tree; OCR found them every time, and Jev picked them with confidence 0.92–0.95.
- OCR and the accessibility tree agree on an element's center to within about 8px.
- The Jev run is not faster because every `mobile_tap` reads the screen again, and reading is slow on this app (see below). Jev itself takes about 0.3 s per request. The tokens are partly moved rather than saved: Jev reads the element list instead of the agent, and its usage is not recorded yet.

### Why reading the screen is slow on Flutter debug builds

For a debuggable Flutter app, mobilecli (1.0.16) does not use the Android accessibility dump. It walks the whole render tree over the Dart VM service, with 10–25 calls per render object, including rows rendered off screen and routes behind the current one. There is no option to turn this off.

| Case | `dump ui` time |
|---|---:|
| Native screen (launcher) | 0.7 s |
| Flutter debug build (VM service walk) | 6.3–10.2 s |

A profile or release build makes mobilecli fall back to the accessibility dump, which should be much faster and also exposes button tooltips as labels; this is not measured yet.

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
