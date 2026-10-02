import { expect, test } from "@playwright/test";

import { buildRequest, centerOf, chooseElement, isConfident, OcrReader, parseAnswer, tapByDescription } from "../src/jev";
import { OcrObservation, readScreenText } from "../src/ocr";
import { ActionableError, Robot, ScreenElement } from "../src/robot";

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

test("keeps the center of a one pixel sliver at the right and bottom edges on screen", () => {
	const sliver: ScreenElement = { type: "Button", rect: { x: 1079, y: 2399, width: 100, height: 100 } };
	expect(centerOf(sliver, screen)).toEqual({ x: 1079, y: 2399 });
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

	expect(() => parseAnswer({ choice: 2 as any, confidence: 1, probabilities: { "2": 1 } }, elements)).toThrow("invalid answer");
	for (const confidence of [-0.1, 1.5, 2]) {
		expect(() => parseAnswer({ choice: "1", confidence, probabilities: { "1": 1 } }, elements)).toThrow("invalid answer");
	}

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

test.describe("tapByDescription", () => {
	const realFetch = globalThis.fetch;

	test.afterEach(() => {
		globalThis.fetch = realFetch;
	});

	// only the signature and IHDR size are read
	const pngOf = (width: number, height: number): Buffer => {
		const png = Buffer.alloc(24);
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
		png.writeUInt32BE(width, 16);
		png.writeUInt32BE(height, 20);
		return png;
	};

	// answers in turn, cycling; returns the request bodies sent
	const answerInTurn = (...answers: Array<[string, number]>) => {
		const requests: any[] = [];
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			const [choice, confidence] = answers[requests.length % answers.length];
			requests.push(JSON.parse(String(init?.body)));
			return new Response(JSON.stringify({
				answers: { element: { choice, confidence, probabilities: { [choice]: confidence } } },
			}));
		}) as typeof fetch;
		return requests;
	};

	const answerWith = (choice: string, confidence: number) => answerInTurn([choice, confidence]);

	// the real readScreenText (screenshot, orientation, mapping) with vision faked
	const ocrReading = (recognize: () => OcrObservation[]) => {
		let reads = 0;
		const read: OcrReader = robot => {
			reads++;
			return readScreenText(robot, recognize);
		};
		return { read, reads: () => reads };
	};

	// "我的位置" at 108,1140 216x60 on a 1080x2400 portrait screenshot, center 216,1170
	const myLocation: OcrObservation = { text: "我的位置", x: 0.1, y: 0.5, width: 0.2, height: 0.025 };

	const fakeRobot = (overrides: Partial<Robot> = {}) => {
		const taps: string[] = [];
		let dumps = 0;
		let screenshots = 0;
		let orientations = 0;
		const robot = {
			getScreenSize: async () => ({ ...screen, scale: 1 }),
			getOrientation: async () => {
				orientations++;
				return "portrait";
			},
			getElementsOnScreen: async () => {
				dumps++;
				return elements;
			},
			getScreenshot: async () => {
				screenshots++;
				return pngOf(1080, 2400);
			},
			tapByRef: async (ref: string) => {
				taps.push(ref);
			},
			tap: async (x: number, y: number) => {
				taps.push(`${x},${y}`);
			},
			...overrides,
		} as unknown as Robot;
		return { robot, taps, dumps: () => dumps, screenshots: () => screenshots, orientations: () => orientations };
	};

	test("taps the chosen element by ref", async () => {
		answerWith("2", 0.95);
		const { robot, taps } = fakeRobot();
		const result = await tapByDescription(robot, "登出", null);
		expect(taps).toEqual(["@e2"]);
		expect(result).toContain("Tapped @e2 Button \"登出\"");
	});

	test("taps the center of an element without a ref", async () => {
		answerWith("3", 0.95);
		const { robot, taps } = fakeRobot();
		await tapByDescription(robot, "我的位置", null);
		expect(taps).toEqual(["219,1088"]);
	});

	test("taps the visible part of a partly visible element", async () => {
		answerWith("1", 0.95);
		const partial: ScreenElement = { type: "Text", text: "返回", rect: { x: -243, y: 100, width: 289, height: 50 } };
		const { robot, taps } = fakeRobot({ getElementsOnScreen: async () => [partial] });
		await tapByDescription(robot, "返回", null);
		expect(taps).toEqual(["23,125"]);
	});

	test("taps nothing when Jev is not confident", async () => {
		answerWith("1", 0.2);
		const { robot, taps } = fakeRobot();
		const error = await tapByDescription(robot, "設定", null).catch(err => err);
		expect(error).toBeInstanceOf(ActionableError);
		expect(error.message).toContain("Nothing tapped");
		expect(error.message).toContain("searched accessibility tree");
		expect(error.message).toContain("\nElements on screen:\nOne element per line:");
		expect(error.message.split("\n")).toContain("@e2 Button label=\"登出\" at=42,1291 size=996x126");
		expect(taps).toEqual([]);
	});

	test("NONE: lists the elements on screen after the first line, taps nothing", async () => { // tap-failure acceptance 1, 5
		answerWith("NONE", 0.9);
		const { robot, taps } = fakeRobot();
		const error = await tapByDescription(robot, "設定", null).catch(err => err);
		expect(error).toBeInstanceOf(ActionableError);
		const [first, heading, ...list] = error.message.split("\n");
		expect(first).toBe("Nothing tapped: no element matches \"設定\" confidently (confidence 0.90, searched accessibility tree). Closest: none");
		expect(heading).toBe("Elements on screen:");
		expect(list).toContain("@e2 Button label=\"登出\" at=42,1291 size=996x126");
		expect(taps).toEqual([]);
	});

	test("unsure after OCR and tree: OCR text is listed with tap coordinates", async () => { // tap-failure acceptance 3
		answerWith("1", 0.2);
		const { robot, taps } = fakeRobot();
		const ocr = ocrReading(() => [{ ...myLocation, text: "關鍵字過濾" }]);
		const error = await tapByDescription(robot, "設定", ocr.read).catch(err => err);
		expect(error).toBeInstanceOf(ActionableError);
		expect(error.message.split("\n")).toContain("OcrText text=\"關鍵字過濾\" at=108,1140 size=216x60 tap=216,1170");
		expect(taps).toEqual([]);
	});

	test("nothing on screen: says so instead of an empty list", async () => { // tap-failure acceptance 4
		const requests = answerWith("1", 0.95);
		const { robot, taps } = fakeRobot({ getElementsOnScreen: async () => [] });
		const error = await tapByDescription(robot, "設定", ocrReading(() => []).read).catch(err => err);
		expect(error).toBeInstanceOf(ActionableError);
		expect(error.message).toMatch(/Closest: none\nElements on screen: none$/);
		expect(error.message).not.toContain("One element per line");
		expect([requests.length, taps.length]).toEqual([0, 0]);
	});

	test("taps the right half of a landscape screen the robot reports as portrait", async () => {
		// mobilecli with auto-rotate on: portrait 1080x2400 reported, the window root says 2400x1080
		const landscape: ScreenElement[] = [
			{ type: "android.widget.FrameLayout", identifier: "android:id/content", rect: { x: 0, y: 0, width: 2400, height: 1080 } },
			{ type: "OcrText", text: "右側按鈕", rect: { x: 1500, y: 300, width: 200, height: 80 } },
		];
		answerWith("2", 0.95);
		const { robot, taps } = fakeRobot({ getElementsOnScreen: async () => landscape });
		await tapByDescription(robot, "右側按鈕", null);
		expect(taps).toEqual(["1600,340"]);
	});

	test("OCR confident: taps by coordinates without a dump", async () => { // acceptance 1
		answerWith("1", 0.95);
		const { robot, taps, dumps } = fakeRobot();
		const result = await tapByDescription(robot, "我的位置", ocrReading(() => [myLocation]).read);
		expect(taps).toEqual(["216,1170"]);
		expect(dumps()).toBe(0);
		expect(result).toContain("from OCR)");
	});

	test("OCR unsure: dumps once, merges the OCR already read, no second OCR", async () => { // acceptance 2
		const requests = answerInTurn(["1", 0.2], ["2", 0.95]);
		const { robot, taps, dumps, screenshots } = fakeRobot();
		const ocr = ocrReading(() => [{ ...myLocation, text: "關鍵字過濾" }]);
		const result = await tapByDescription(robot, "登出", ocr.read);
		expect(taps).toEqual(["@e2"]);
		expect([ocr.reads(), screenshots(), dumps()]).toEqual([1, 1, 1]);
		expect(Object.values(requests[1].questions.element.criteria).some((c: any) => c.text === "關鍵字過濾")).toBe(true);
		expect(result).toContain("from OCR + accessibility tree");
	});

	test("OCR alone takes the orientation from the screenshot, not the robot", async () => { // acceptance 4
		answerWith("1", 0.95);
		const { robot, taps, dumps, orientations } = fakeRobot({ getScreenshot: async () => pngOf(2400, 1080) });
		// 1500,432 300x108 on 2400x1080; on the unswapped 1080x2400 it would be 675,960
		const button: OcrObservation = { text: "右側按鈕", x: 0.625, y: 0.5, width: 0.125, height: 0.1 };
		await tapByDescription(robot, "右側按鈕", ocrReading(() => [button]).read);
		expect(taps).toEqual(["1650,486"]);
		expect([dumps(), orientations()]).toEqual([0, 0]);
	});

	test("unsure on both: taps nothing and names both sources", async () => { // acceptance 5
		answerWith("1", 0.2);
		const { robot, taps } = fakeRobot();
		const error = await tapByDescription(robot, "設定", ocrReading(() => [myLocation]).read).catch(err => err);
		expect(error).toBeInstanceOf(ActionableError);
		expect(error.message).toContain("searched OCR + accessibility tree");
		expect(taps).toEqual([]);
	});

	test("without OCR support: dump then Jev, no screenshot", async () => { // acceptance 6
		answerWith("2", 0.95);
		const { robot, taps, screenshots } = fakeRobot();
		const result = await tapByDescription(robot, "登出", null);
		expect(taps).toEqual(["@e2"]);
		expect(screenshots()).toBe(0);
		expect(result).toContain("from accessibility tree)");
	});

	test("the default reader skips OCR when the server is not on macOS", async () => { // acceptance 6, default branch
		answerWith("2", 0.95);
		const { robot, taps, screenshots } = fakeRobot();
		const platform = Object.getOwnPropertyDescriptor(process, "platform") as PropertyDescriptor;
		Object.defineProperty(process, "platform", { value: "linux" });
		try {
			const result = await tapByDescription(robot, "登出");
			expect(taps).toEqual(["@e2"]);
			expect(screenshots()).toBe(0);
			expect(result).toContain("from accessibility tree)");
		} finally {
			Object.defineProperty(process, "platform", platform);
		}
	});

	test("a stale ref from the tree fallback reads the screen again from OCR", async () => { // acceptance 7
		answerInTurn(["1", 0.2], ["2", 0.95]);
		let first = true;
		const taps: string[] = [];
		const { robot, dumps } = fakeRobot({
			tapByRef: async (ref: string) => {
				if (first) {
					first = false;
					throw new Error(`ref ${ref} not found on current screen; refs come from the latest 'dump ui'`);
				}

				taps.push(ref);
			},
		});
		const ocr = ocrReading(() => [myLocation]);
		const result = await tapByDescription(robot, "登出", ocr.read);
		expect([ocr.reads(), dumps()]).toEqual([2, 2]);
		expect(taps).toEqual(["@e2"]);
		expect(result).toContain("after the screen changed");
	});

	test("an OCR failure falls back to the tree instead of blocking the tap", async () => { // acceptance 8
		answerWith("2", 0.95);
		const { robot, taps } = fakeRobot();
		const ocr = ocrReading(() => {
			throw new Error("Vision text recognition failed");
		});
		const result = await tapByDescription(robot, "登出", ocr.read);
		expect(taps).toEqual(["@e2"]);
		expect(result).toContain("OCR failed: Vision text recognition failed");
	});
});
