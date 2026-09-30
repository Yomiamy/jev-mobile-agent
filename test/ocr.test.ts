import { expect, test } from "@playwright/test";

import { formatElements } from "../src/format-elements";
import { mergeOcrElements, toScreenElements } from "../src/ocr";
import { ScreenElement } from "../src/robot";

const screen = { width: 400, height: 800 };

test("vision boxes (normalized, bottom-left origin) map onto top-left screen coordinates", () => {
	const [element] = toScreenElements([{ text: "今日推薦", x: 0.1, y: 0.8, width: 0.5, height: 0.05 }], screen);
	expect(element.type).toBe("OcrText");
	expect(element.ref).toBeUndefined();
	expect(element.rect).toEqual({ x: 40, y: 120, width: 200, height: 40 });
});

test("ocr text already in the accessibility tree at the same spot is dropped", () => {
	const login: ScreenElement = { ref: "@e1", type: "Button", label: "Log In", rect: { x: 0, y: 0, width: 200, height: 100 } };
	const ocr = toScreenElements([
		{ text: "login", x: 0.1, y: 0.9, width: 0.2, height: 0.05 }, // inside the button, same words
		{ text: "Log In", x: 0.6, y: 0.5, width: 0.2, height: 0.05 }, // same words, elsewhere
		{ text: "今日推薦", x: 0.1, y: 0.9, width: 0.2, height: 0.05 }, // inside the button, other words
	], screen);

	const merged = mergeOcrElements([login], ocr);
	expect(merged.map(e => e.text ?? e.label)).toEqual(["Log In", "Log In", "今日推薦"]);
});

test("dedupe ignores punctuation that ocr reads differently", () => {
	const row: ScreenElement = { ref: "@e33", type: "ImageView", label: "Range Bistrokaya\nBistros · Bars · Seafood", rect: { x: 0, y: 0, width: 400, height: 200 } };
	const ocr = toScreenElements([{ text: "Bistros•Bars•Seafood", x: 0.1, y: 0.9, width: 0.5, height: 0.03 }], screen);
	expect(mergeOcrElements([row], ocr)).toEqual([row]);
});

test("elements without a ref get their center to tap", () => {
	const [element] = toScreenElements([{ text: "今日推薦", x: 0.1, y: 0.8, width: 0.5, height: 0.05 }], screen);
	const lines = formatElements([element], "text").split("\n");
	expect(lines[1]).toBe("OcrText text=\"今日推薦\" at=40,120 size=200x40 tap=140,140");
});
