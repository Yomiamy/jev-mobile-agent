import { expect, test } from "@playwright/test";

import { buildRequest, chooseElement, isConfident, parseAnswer } from "../src/jev";
import { ActionableError, ScreenElement } from "../src/robot";

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

test("rejects malformed answers instead of crashing", () => {
	for (const choice of ["1.0", " 1", "0x1", "0"]) {
		expect(() => parseAnswer({ choice, confidence: 1, probabilities: { "1": 1 } }, elements)).toThrow("invalid answer");
	}

	expect(() => parseAnswer({ choice: "1", confidence: NaN, probabilities: { "1": 1 } }, elements)).toThrow("invalid answer");
	expect(() => parseAnswer({ choice: "1", confidence: 1, probabilities: null as any }, elements)).toThrow("invalid answer");

	const choice = parseAnswer({ choice: "2", confidence: 0.9, probabilities: { "1": "x" as any, "2": 0.9 } }, elements);
	expect(choice.ranked.map(c => c.element)).toEqual([elements[1]]);
});

test.describe("chooseElement request failures tap nothing", () => {
	const realFetch = globalThis.fetch;
	test.afterEach(() => {
		globalThis.fetch = realFetch;
	});

	const expectFailure = async (fetchImpl: typeof fetch, message: string) => {
		globalThis.fetch = fetchImpl;
		const error = await chooseElement("登出", elements, screen).catch(err => err);
		expect(error).toBeInstanceOf(ActionableError);
		expect(error.message).toContain(message);
		expect(error.message).toContain("nothing was tapped");
	};

	test("timeout", async () => {
		await expectFailure(async () => {
			throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
		}, "timeout");
	});

	test("network failure", async () => {
		await expectFailure(async () => {
			throw new TypeError("fetch failed");
		}, "fetch failed");
	});

	test("HTTP error status", async () => {
		await expectFailure(async () => new Response("busy", { status: 503 }), "HTTP 503");
	});

	test("json null body", async () => {
		await expectFailure(async () => new Response("null", { status: 200 }), "invalid answer");
	});

	test("body that is not json", async () => {
		await expectFailure(async () => new Response("<html>", { status: 200 }), "TypeSafe request failed");
	});
});
