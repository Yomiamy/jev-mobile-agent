import { expect, test } from "@playwright/test";

import { buildRequest, isConfident, parseAnswer } from "../src/jev";
import { ScreenElement } from "../src/robot";

const screen = { width: 1080, height: 2400 };
const elements: ScreenElement[] = [
	{ ref: "@e1", type: "android.widget.Button", rect: { x: 11, y: 139, width: 126, height: 126 } },
	{ ref: "@e2", type: "Button", label: "登出", rect: { x: 42, y: 1291, width: 996, height: 126 } },
	{ type: "OcrText", text: "我的位置", rect: { x: 118, y: 1063, width: 202, height: 50 } },
];

test("one option per element plus NONE, each described with its center", () => {
	const request = buildRequest("登出", elements, screen);
	const criteria = request.questions.element.criteria as Record<string, any>;
	expect(Object.keys(criteria)).toEqual(["1", "2", "3", "NONE"]);
	expect(criteria["1"]).toMatchObject({ type: "Button", center: { x: 74, y: 202 }, size: "126x126" });
	expect(criteria["3"]).toMatchObject({ type: "OcrText", text: "我的位置" });
	expect(request.questions.element.instructions.target).toBe("登出");
});

test("maps the chosen option back to the observed element", () => {
	const choice = parseAnswer({ choice: "3", confidence: 0.9, probabilities: { "1": 0.02, "2": 0.03, "3": 0.93, "NONE": 0.02 } }, elements);
	expect(choice.element).toBe(elements[2]);
	expect(choice.ranked.map(c => c.element)).toEqual([elements[2], elements[1], elements[0]]);
	expect(isConfident(choice)).toBe(true);
});

test("NONE and low confidence do not count as a match", () => {
	const none = parseAnswer({ choice: "NONE", confidence: 0.8, probabilities: { "1": 0.1, "2": 0.05, "3": 0.05, "NONE": 0.8 } }, elements);
	expect(none.element).toBeNull();
	expect(isConfident(none)).toBe(false);

	const unsure = parseAnswer({ choice: "1", confidence: 0.2, probabilities: { "1": 0.4, "2": 0.35, "3": 0.2, "NONE": 0.05 } }, elements);
	expect(isConfident(unsure)).toBe(false);
});

test("rejects an answer that points at no observed element", () => {
	expect(() => parseAnswer({ choice: "9", confidence: 1, probabilities: { "9": 1 } }, elements)).toThrow("invalid answer");
	expect(() => parseAnswer(undefined, elements)).toThrow("invalid answer");
});
