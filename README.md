# jev-mobile-mcp

**English** | [繁體中文](README.zh-TW.md)

Mobile agent testing by jev decision and ocr detection

An MCP server built on [mobile-next/mobile-mcp](https://github.com/mobile-next/mobile-mcp) that lets AI agents drive Android / iOS devices, emulators and simulators. Every upstream feature is kept; this repo adds an **OCR** layer between the accessibility tree and screenshots, so agents need screenshots far less often to find what to tap.

## Why OCR

Upstream locates elements in only two ways:

1. `mobile_list_elements_on_screen`: reads the accessibility tree and returns refs, coordinates and labels. Fast, cheap, accurate.
2. `mobile_take_screenshot`: when the tree lacks the target, the model eyeballs a screenshot and converts positions by the scale ratio. Slow, token-heavy, and only as accurate as the model's vision.

Many screens never put their text into the accessibility tree: a Flutter `Drawer` without semantics, canvas-drawn UI, text baked into images. Those used to fall straight through to screenshots.

This repo adds OCR on two paths, so a screenshot becomes the last resort:

**`mobile_tap` (with a TypeSafe key): OCR first.** OCR costs about 1–1.5 s, while reading the tree of a Flutter debug build costs 6–10 s, so the tree is read only when OCR is not enough.

```
mobile_tap(target)
        │
        ▼
OCR (screenshot + Vision)          ← read first; Jev picks the text
        │ no confident match
        ▼
tree + OCR merged                  ← tree read only now; Jev asked again
        │ still no confident match
        ▼
nothing tapped, candidates + element list returned → agent picks one and clicks it
```

**`mobile_list_elements_on_screen`: tree first, OCR on request.** `list` is the most frequent call, so OCR is never turned on by the server.

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
| `src/compact-elements.ts` | Compacts the element list for every user, with or without a TypeSafe key: inside the current viewport only (see [Screen bounds and rotation](#screen-bounds-and-rotation)), no empty containers, a repeated multi-line (merged) label once; about 60% shorter |
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
- **Coordinates are already screen coordinates**: Vision returns boxes normalized to the screenshot, and the screenshot covers the whole screen, so multiplying by the current viewport is enough. Screenshot scaling and iOS points vs. pixels do not matter, and a rotated screen maps correctly (see [Screen bounds and rotation](#screen-bounds-and-rotation)).
- **Dedupe**: an OCR box is dropped when its center lies inside a tree element with the same text (letters and digits only, ignoring `·`/`•`, spaces and the like), so only what the tree lacks remains.
- **OCR elements have no ref** and can only be tapped by coordinates.

### When it is used

The agent decides from the tool description; the server never turns OCR on by itself for `list` (it is the most frequent call, and running OCR every time would slow everything down). `mobile_tap` is different: it reads OCR first on every tap (see below). For `list`:

- The text to tap is missing from the previous listing → list again with `ocr: true`.
- When the accessibility tree is completely empty, the result includes a `Retry with ocr: true` hint.

Design, trade-offs and full test records: [spec](docs/features/2026-10-01-ocr-list-elements.md) · [plan](docs/plans/2026-10-01-ocr-list-elements.md).

### Screen bounds and rotation

The element list keeps only what lies inside the current viewport, and OCR maps its boxes onto the same viewport. The viewport is decided in this order:

1. **The window root in the dump**: an element at `0,0` whose size equals the screen size or its swap, such as `android:id/content` or Flutter's root box.
2. The orientation the robot reports, used to turn the reported size the right way.
3. The reported size as is.

The robot's orientation is only a fallback because it is not reliable: on a Pixel 6 emulator with auto-rotate on, Chrome in landscape (`ROTATION_270`, 2400x1080) is still reported as `portrait` 1080x2400 by mobilecli. Trusting it dropped all 36 elements past x=1080; with the window root all of them are kept.

## Tap by description with Jev (optional)

With a [TypeSafe](https://docs.typesafe.ai) API key, the server also registers `mobile_tap`. The agent describes the target instead of reading the whole element list; [Jev](https://docs.typesafe.ai/introduction), TypeSafe's System One model, picks the element (the same approach as [jev-ultrafast](https://github.com/browser-use/jev-ultrafast)).

```jsonc
// mobile_tap
{ "device": "Pixel_6", "target": "menu button at the top left" }
// → Tapped @e65 Button "" at 74,202 (confidence 0.62, from OCR + accessibility tree)
{ "device": "Pixel_6", "target": "關鍵字過濾" }
// → Tapped OcrText "關鍵字過濾" at 257,663 (confidence 0.81, from OCR)
```

1. Take a screenshot, read its text with OCR and ask Jev which text matches `target` (one Choice question: one option per element, plus NONE). The orientation comes from the screenshot itself. OCR is cheap (about 1–1.5 s), while reading the accessibility tree takes 6–10 s on a Flutter debug build (see below).
2. No match or low confidence → read the accessibility tree and compact it (drop off-screen elements and empty containers, keep a multi-line (merged) label repeated by child nodes only once), merge in the OCR elements from step 1 and ask once more. OCR does not run a second time.
3. When the server does not run on macOS (no OCR), or the screenshot or OCR fails, go straight to step 2 with the accessibility tree only.
4. Still no confident match → **nothing is tapped**; the closest candidates are returned together with the element list Jev chose from (the same format as `mobile_list_elements_on_screen`, OCR text included), so the agent can pick a ref or `tap=` coordinates for `mobile_click_on_screen_at_coordinates` without reading the screen again.
5. If the screen changed between reading and tapping (stale ref), read it again, including the viewport, and retry once.

An element with a ref is tapped by ref; one without (an OCR element) is tapped at the center of its visible part, kept inside the viewport. Jev can only pick an observed element, so the model never makes up coordinates. The agent sends one short phrase instead of reading 3,000–7,000 characters of element list per step.

**Setup**: without `TYPESAFE_API_KEY`, `mobile_tap` is not registered and nothing is sent to TypeSafe. Put the server name **before** `-e`, otherwise `-e` swallows the name as another variable:

```bash
claude mcp add jev-mobile-mcp -e TYPESAFE_API_KEY=<your key> -- npx -y github:Yomiamy/jev-mobile-mcp#main
```

For a shared `.mcp.json`, reference the variable instead of committing the key: `"env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" }`. `TYPESAFE_MODEL` overrides the model (default `jev-latest`).

> **Privacy**: every `mobile_tap` sends the on-screen text read by OCR to TypeSafe, and the text of the accessibility tree elements too when the tree is read. Screens can contain personal data such as account emails; enable it only where that is acceptable.

Limits:

- Icons missing from the accessibility tree cannot be found (OCR reads text only).
- Icon targets and native screens (the launcher's tree reads in 0.7 s) pay about 1–1.5 s more per tap: OCR runs first, is unsure, and then the tree is read.
- A text target that OCR alone matches confidently is tapped by coordinates, even when the tree has a ref for it (e.g. a dialog's "取消"), so it loses the stale-ref protection below.
- Two identical targets on screen (e.g. the same app icon on the home screen and in the dock) split the probability and are refused; describe the target more precisely, e.g. by position.
- Buttons without a label are picked by position only, with lower confidence (0.60–0.66 in the field test). A `tooltip` / `Semantics(label:)` in the app fixes that.
- The confidence threshold (0.5) is hand-picked and should be tuned on recorded runs.
- Only taps by ref can be rejected when the screen changed (mobilecli reports a ref that is not on the current screen; whether it catches every change depends on how mobilecli numbers refs, which is not confirmed). OCR elements and legacy robots are tapped by coordinates, which are not re-checked.

Design, trade-offs and full test records: [spec](docs/features/2026-10-01-jev-tap.md) · [plan](docs/plans/2026-10-01-jev-tap.md).

## Field test

A 10-step flow on the Flutter app "FindRestaurant" on a Pixel 9a emulator (Android 17): terminate all apps → tap the app on the launcher → wait for load → scroll 100 px → open side menu → "關鍵字過濾" → "取消" → open side menu → "我的位置" → wait for reload. Budget 300 s per run, at most 2 retries per step. Five runs per server, each run in a fresh Claude Code subagent (Opus 5.5) so context does not accumulate across runs.

| | upstream mobile-mcp 1.0.8 ³ | jev-mobile-mcp |
|---|---:|---:|
| Passed | 5 / 5 | 5 / 5 |
| Avg time | 137.2 s | 70.0 s (−49%) |
| Avg model requests per run (Claude API) ² | 23.6 | 16 (−32%) |
| Avg input-equivalent tokens per run ¹ | 295.3k | 166.3k (−44%) |
| Steady state, runs 3–5 ¹ | 202k–336k | 141k–152k |
| Avg output tokens per run | 1,575 | 517 (−67%) |
| Retries, all runs | 2 (launcher tap, dialog "取消") | 0 |

¹ From the `usage` of every model request in the subagent transcript, priced relative to plain input: cache read × 0.1 + cache write × 1.25 + input. Raw totals are much larger (1.2–2.6 M tokens per run) because every request resends the whole context, about 63k of which is fixed overhead (system prompt, tool definitions, project rules) before the first step. Runs that write that context to the cache (run 1 of each server, and upstream run 4) are higher.

² One request to the Claude Messages API, i.e. one model turn; counted as distinct assistant messages in the transcript. Not the number of MCP tool calls or device actions: one request can issue several tool calls, and one `mobile_batch_commands` can run many device steps.

³ Upstream 1.0.8, installed as the Claude Code plugin (`/plugin install mobile-mcp@mobile-mcp`), run on 2026-10-03. The jev-mobile-mcp column was measured earlier and not rerun.

- **Where the saving comes from**: the four text targets ("FindRestaurant", "關鍵字過濾", "取消", "我的位置") were each tapped by one `mobile_tap` (OCR, confidence 0.91–0.99), with no screenshot to locate them first. Fewer model requests means fewer resends of the context, which dominates the cost.
- **Why upstream took longer**: on this Flutter screen `mobile_list_elements_on_screen` usually did not show the open side menu, so the agent took screenshots and tapped coordinates read off them; screenshots often still showed the previous screen and had to be taken again. Every run also listed the 22–25 installed apps and terminated each one, since there is no tool for listing running apps.
- **Launcher tap**: with upstream, the agent tapped the icon by ref; the first tap was ignored in 1 of 5 runs and worked when retried at the icon's coordinates. `mobile_tap` hit the label below the icon (923,1524) and launched the app on the first tap every time. Observed, root cause not verified.
- **Wrong element by ref**: in upstream run 3, tapping the dialog's "取消" by ref (`@e77`) opened the Flutter Inspector instead of closing the dialog; the retry at screenshot coordinates worked. Root cause not verified.
- **The hamburger button** has no label, so both servers tapped it by coordinates or ref.
- **Not a strictly equal comparison**: the jev-mobile-mcp prompt gave the hamburger button's coordinates, the upstream prompt did not, and the two columns were measured at different times; part of the difference may come from that.

#### Per-run data

upstream mobile-mcp 1.0.8 ³:

| Run | Time | Model requests | Cache read | Cache write | Output | Input-equivalent ¹ | Retries |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 97 s | 25 | 2,157,105 | 86,116 | 1,378 | 323.4k | 0 |
| 2 | 219 s | 24 | 2,380,586 | 53,523 | 2,656 | 305.0k | 0 |
| 3 | 189 s | 28 | 2,543,598 | 43,925 | 1,298 | 309.3k | 2 (launcher tap; "取消" by ref opened the Flutter Inspector) |
| 4 | 93 s | 22 | 1,977,021 | 110,959 | 1,229 | 336.4k | 0 |
| 5 | 88 s | 19 | 1,592,625 | 34,286 | 1,312 | 202.2k | 0 |

jev-mobile-mcp:

| Run | Time | Model requests | Cache read | Cache write | Output | Input-equivalent ¹ | Retries |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 | 70 s | 16 | 1,179,745 | 85,262 | 475 | 224.6k | 0 |
| 2 | 78 s | 17 | 1,331,514 | 23,022 | 619 | 162.0k | 0 |
| 3 | 77 s | 16 | 1,242,288 | 21,766 | 485 | 151.5k | 0 |
| 4 | 61 s | 15 | 1,155,368 | 20,749 | 511 | 141.5k | 0 |
| 5 | 64 s | 16 | 1,243,856 | 21,952 | 494 | 151.9k | 0 |

Plain input was 30–56 tokens per run and is left out.

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
- **Rotation**: landscape is tested on an Android emulator only; iOS simulators are not tested yet. Without a full-screen window root in the dump (an app that is not edge-to-edge, split screen, legacy WDA which filters root types out), the viewport falls back to the reported orientation, which mobilecli and the legacy Android robot (`user_rotation`) can get wrong.

## Installation

### From GitHub (for teams)

Requires read access to this repo. `prepare` builds on install.

```bash
claude mcp add jev-mobile-mcp -- npx -y github:Yomiamy/jev-mobile-mcp#main
```

Or commit a `.mcp.json` at your project root so teammates are prompted to enable it when they open the project:

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

**Updating**: npx reuses its cached install and does not pick up new commits on the branch. After pushing a new version, delete the cache and reconnect:

```bash
grep -l 'jev-mobile-mcp.git' ~/.npm/_npx/*/package-lock.json   # find the cache dir
rm -rf ~/.npm/_npx/<that-dir>
# then in Claude Code: /mcp → jev-mobile-mcp → Reconnect
```

### Local development

```bash
npm ci && npm run build
claude mcp add jev-mobile-mcp -- node /path/to/jev-mobile-mcp/lib/index.js
```

After changing `src/`, run `npm run build` and reconnect in `/mcp`.

> If the upstream `mobile-mcp` is installed too, both expose the same tool names. Disable one while testing so the agent does not call the wrong version.

## Syncing with upstream

Upstream is tracked through an `upstream` remote and merged in, keeping its history. See `.claude/skills/gen-sync-mobile-mcp/SKILL.md` for the procedure.

## License

Upstream mobile-mcp is licensed under Apache-2.0; its original license is kept in [`LICENSE-mobile-mcp`](LICENSE-mobile-mcp).
