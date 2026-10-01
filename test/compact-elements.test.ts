import { expect, test } from "@playwright/test";

import { compactElements, currentViewport } from "../src/compact-elements";
import { Robot, ScreenElement } from "../src/robot";

const screen = { width: 1080, height: 2400 };
const row = "熊燒Bar\n193 m\n3則評論";

const el = (e: Partial<ScreenElement> & { rect: ScreenElement["rect"] }): ScreenElement => ({ type: "Text", ...e });

test("drops elements outside the screen, including a previous route shifted off to the left", () => {
	const kept = compactElements([
		el({ ref: "@e1", text: "visible", rect: { x: 0, y: 100, width: 100, height: 50 } }),
		el({ ref: "@e2", text: "below the fold", rect: { x: 0, y: 2500, width: 100, height: 50 } }),
		el({ ref: "@e3", text: "previous route", rect: { x: -300, y: 100, width: 250, height: 50 } }),
		el({ ref: "@e4", text: "partly visible", rect: { x: -243, y: 100, width: 289, height: 50 } }),
	], screen);
	expect(kept.map(e => e.ref)).toEqual(["@e1", "@e4"]);
});

test("keeps the right half of a landscape screen, drops it in portrait", () => {
	const right = el({ ref: "@e1", text: "right side in landscape", rect: { x: 1500, y: 300, width: 200, height: 80 } });
	expect(compactElements([right], { width: 2400, height: 1080 })).toEqual([right]);
	expect(compactElements([right], screen)).toEqual([]);
});

test("drops elements below the short edge in landscape", () => {
	const low = el({ ref: "@e1", text: "off screen", rect: { x: 100, y: 1500, width: 200, height: 80 } });
	expect(compactElements([low], { width: 2400, height: 1080 })).toEqual([]);
});

test.describe("currentViewport", () => {
	const robotWith = (size: { width: number; height: number }, orientation?: string) => ({
		getScreenSize: async () => ({ ...size, scale: 1 }),
		getOrientation: async () => {
			if (!orientation) {
				throw new Error("unsupported");
			}

			return orientation;
		},
	}) as unknown as Robot;

	const dims = async (r: Robot) => {
		const { width, height } = await currentViewport(r);
		return [width, height];
	};

	test("swaps a portrait report in landscape and a landscape report in portrait", async () => {
		expect(await dims(robotWith({ width: 1080, height: 2400 }, "landscape"))).toEqual([2400, 1080]);
		expect(await dims(robotWith({ width: 2400, height: 1080 }, "portrait"))).toEqual([1080, 2400]);
	});

	test("keeps a size that already matches the orientation", async () => {
		expect(await dims(robotWith({ width: 2400, height: 1080 }, "landscape"))).toEqual([2400, 1080]);
		expect(await dims(robotWith({ width: 1080, height: 2400 }, "portrait"))).toEqual([1080, 2400]);
	});

	test("treats a raw WDA landscape value as landscape", async () => {
		expect(await dims(robotWith({ width: 1080, height: 2400 }, "uia_device_orientation_landscaperight"))).toEqual([2400, 1080]);
	});

	test("uses the reported size when the orientation is unavailable", async () => {
		expect(await dims(robotWith({ width: 1080, height: 2400 }))).toEqual([1080, 2400]);
	});
});

test("drops empty containers but keeps icon-only buttons", () => {
	const kept = compactElements([
		el({ ref: "@e1", type: "ConstrainedBox", rect: { x: 0, y: 0, width: 1080, height: 2400 } }),
		el({ ref: "@e2", type: "Button", rect: { x: 11, y: 139, width: 126, height: 126 } }),
		el({ ref: "@e3", type: "android.widget.ImageButton", rect: { x: 900, y: 139, width: 126, height: 126 } }),
	], screen);
	expect(kept.map(e => e.ref)).toEqual(["@e2", "@e3"]);
});

test("keeps a merged label repeated by child nodes only once, children keep their own text", () => {
	const kept = compactElements([
		el({ ref: "@e1", type: "Image", label: row, rect: { x: 26, y: 616, width: 289, height: 289 } }),
		el({ ref: "@e2", text: "熊燒Bar", label: row, rect: { x: 341, y: 616, width: 619, height: 76 } }),
		el({ ref: "@e3", label: row, rect: { x: 822, y: 694, width: 245, height: 42 } }),
	], screen);
	// @e3 only carried the repeated label, nothing is left to show
	expect(kept.map(e => [e.ref, e.text, e.label])).toEqual([
		["@e1", undefined, row],
		["@e2", "熊燒Bar", undefined],
	]);
});

test("keeps single-line labels that repeat, such as a per-row native button", () => {
	const kept = compactElements([
		el({ ref: "@e1", type: "android.widget.ImageButton", label: "More options", rect: { x: 950, y: 300, width: 100, height: 100 } }),
		el({ ref: "@e2", type: "android.widget.ImageButton", label: "More options", rect: { x: 950, y: 600, width: 100, height: 100 } }),
		el({ ref: "@e3", type: "android.view.View", label: "Delete", rect: { x: 100, y: 300, width: 100, height: 100 } }),
		el({ ref: "@e4", type: "android.view.View", label: "Delete", rect: { x: 100, y: 600, width: 100, height: 100 } }),
	], screen);
	expect(kept.map(e => [e.ref, e.label])).toEqual([
		["@e1", "More options"],
		["@e2", "More options"],
		["@e3", "Delete"],
		["@e4", "Delete"],
	]);
});

test("keeps everything on screen when the screen size is unknown", () => {
	const offscreen = el({ ref: "@e1", text: "far", rect: { x: 5000, y: 5000, width: 10, height: 10 } });
	expect(compactElements([offscreen], { width: 0, height: 0 })).toEqual([offscreen]);
});
