import { execFileSync } from "node:child_process";

import { currentViewport } from "./compact-elements";
import { PNG } from "./png";
import { ActionableError, Dimensions, Robot, ScreenElement, ScreenElementRect } from "./robot";

// a text box as vision reports it: normalized to the image, origin at bottom-left
export interface OcrObservation {
	text: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

const OCR_TIMEOUT_MS = 30_000;

// macos vision through jxa, so there is nothing to compile or install. reads the image from stdin.
const VISION_SCRIPT = `
ObjC.import("Vision");
function run() {
	const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
	const request = $.VNRecognizeTextRequest.alloc.init;
	request.setRecognitionLevel(0);
	request.setUsesLanguageCorrection(true);
	request.setRecognitionLanguages($(["zh-Hant", "zh-Hans", "ja-JP", "ko-KR", "en-US"]));
	const handler = $.VNImageRequestHandler.alloc.initWithDataOptions(data, $({}));
	const error = Ref();
	if (!handler.performRequestsError($([request]), error)) {
		throw new Error("Vision text recognition failed");
	}
	const results = request.results;
	const out = [];
	for (let i = 0; i < results.count; i++) {
		const observation = results.objectAtIndex(i);
		const box = observation.boundingBox;
		out.push({
			text: observation.topCandidates(1).objectAtIndex(0).string.js,
			x: box.origin.x,
			y: box.origin.y,
			width: box.size.width,
			height: box.size.height,
		});
	}
	return JSON.stringify(out);
}
`;

const recognizeText = (image: Buffer): OcrObservation[] => {
	const output = execFileSync("osascript", ["-l", "JavaScript", "-e", VISION_SCRIPT], {
		input: image,
		timeout: OCR_TIMEOUT_MS,
		maxBuffer: 16 * 1024 * 1024,
	});
	return JSON.parse(output.toString()) as OcrObservation[];
};

// the screenshot covers the whole screen, so normalized boxes map straight onto screen coordinates
export const toScreenElements = (observations: OcrObservation[], screen: Dimensions): ScreenElement[] =>
	observations.map(o => ({
		type: "OcrText",
		text: o.text,
		rect: {
			x: Math.round(o.x * screen.width),
			y: Math.round((1 - o.y - o.height) * screen.height),
			width: Math.round(o.width * screen.width),
			height: Math.round(o.height * screen.height),
		},
	}));

// compare letters and digits only, ocr reads "·" as "•" and drops or adds spaces
const normalize = (value: string): string => value.replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

const containsPoint = (rect: ScreenElementRect, x: number, y: number): boolean =>
	x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;

// the accessibility tree already has this text at this spot, the ocr copy adds nothing
const isCovered = (ocr: ScreenElement, elements: ScreenElement[]): boolean => {
	const x = ocr.rect.x + ocr.rect.width / 2;
	const y = ocr.rect.y + ocr.rect.height / 2;
	const text = normalize(ocr.text ?? "");
	return elements.some(e =>
		containsPoint(e.rect, x, y) &&
		[e.text, e.label, e.name, e.value].some(v => v && normalize(v).includes(text)));
};

export const mergeOcrElements = (elements: ScreenElement[], ocrElements: ScreenElement[]): ScreenElement[] =>
	[...elements, ...ocrElements.filter(o => !isCovered(o, elements))];

export const isOcrSupported = (): boolean => process.platform === "darwin";

// the screenshot is the screen as it is now; robots can report portrait for a landscape screen
const screenshotViewport = (size: Dimensions, screenshot: Buffer): Dimensions => {
	const { width, height } = new PNG(screenshot).getDimensions();
	return (width > height) === (size.width > size.height) ? size : { ...size, width: size.height, height: size.width };
};

export interface OcrScreen {
	elements: ScreenElement[];
	screen: Dimensions;
}

/**
 * Reads text off a screenshot without the accessibility tree. The orientation
 * comes from the screenshot itself, the robot's orientation is not asked.
 */
export const readScreenText = async (robot: Robot, recognize = recognizeText): Promise<OcrScreen> => {
	const screenshot = await robot.getScreenshot({ format: "png" });
	const screen = screenshotViewport(await robot.getScreenSize(), screenshot);
	if (screen.width <= 0 || screen.height <= 0) {
		throw new ActionableError("Screen size is unknown, cannot map OCR results onto screen coordinates");
	}

	return { elements: toScreenElements(recognize(screenshot), screen), screen };
};

/**
 * Appends text read off a screenshot to the accessibility tree elements, for
 * screens whose text never reaches the tree (canvas, flutter without
 * semantics, text baked into images). Text already in the tree is dropped.
 */
export const withOcrElements = async (robot: Robot, elements: ScreenElement[]): Promise<ScreenElement[]> => {
	if (!isOcrSupported()) {
		throw new ActionableError("OCR is only supported when the server runs on macOS");
	}

	// the screenshot is taken in the current orientation, map onto that, not the reported size
	const screen = await currentViewport(robot, elements);
	if (screen.width <= 0 || screen.height <= 0) {
		throw new ActionableError("Screen size is unknown, cannot map OCR results onto screen coordinates");
	}

	const screenshot = await robot.getScreenshot({ format: "png" });
	return mergeOcrElements(elements, toScreenElements(recognizeText(screenshot), screen));
};
