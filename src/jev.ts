import { compactElements, currentViewport } from "./compact-elements";
import { isOcrSupported, withOcrElements } from "./ocr";
import { ActionableError, Dimensions, Robot, ScreenElement } from "./robot";

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_OPTIONS = 255;
const NONE = "NONE";
const CANDIDATES_SHOWN = 3;

// ponytail: hand-picked threshold, tune it on recorded runs once there are enough of them
export const MIN_CONFIDENCE = 0.5;

export interface ElementChoice {
	element: ScreenElement | null;
	confidence: number;
	ranked: Array<{ element: ScreenElement; probability: number }>;
}

interface ChoiceAnswer {
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

export const isJevEnabled = (): boolean => !!process.env.TYPESAFE_API_KEY;

// the center of the part of the element inside the screen; compactElements keeps
// partly visible elements, whose full-rect center can lie off screen
export const centerOf = (element: ScreenElement, screen?: Dimensions): { x: number; y: number } => {
	const { x, y, width, height } = element.rect;
	const known = !!screen && screen.width > 0 && screen.height > 0;
	const left = known ? Math.max(x, 0) : x;
	const top = known ? Math.max(y, 0) : y;
	const right = known ? Math.min(x + width, screen.width) : x + width;
	const bottom = known ? Math.min(y + height, screen.height) : y + height;
	return { x: Math.round((left + right) / 2), y: Math.round((top + bottom) / 2) };
};

export const shortType = (type: string): string => type.substring(type.lastIndexOf(".") + 1);

const describe = (element: ScreenElement, screen: Dimensions) => ({
	type: shortType(element.type),
	text: element.text || undefined,
	label: element.label || undefined,
	name: element.name || undefined,
	value: element.value || undefined,
	id: element.identifier || undefined,
	center: centerOf(element, screen),
	size: `${element.rect.width}x${element.rect.height}`,
});

// option "1" is elements[0]; the state carries only what every option shares
export const buildRequest = (target: string, elements: ScreenElement[], screen: Dimensions) => {
	if (elements.length >= MAX_OPTIONS) {
		throw new ActionableError(`Too many elements on screen (${elements.length}) to choose from, use mobile_list_elements_on_screen instead`);
	}

	const criteria: Record<string, object | string> = {};
	elements.forEach((element, i) => {
		criteria[String(i + 1)] = describe(element, screen);
	});
	criteria[NONE] = "No listed element matches the target";

	return {
		model: process.env.TYPESAFE_MODEL || "jev-latest",
		state: { screen: { width: screen.width, height: screen.height } },
		questions: {
			element: {
				type: "choice",
				instructions: {
					target,
					question: "Which on-screen element should be tapped to hit `target`? Element positions are screen pixels from the top-left corner of `screen`.",
				},
				criteria,
			},
		},
	};
};

// the exact option keys buildRequest wrote, so "1.0" or " 1" never map onto an element
const elementForOption = (option: string, elements: ScreenElement[]): ScreenElement | undefined =>
	/^[1-9]\d*$/.test(option) ? elements[Number(option) - 1] : undefined;

export const parseAnswer = (answer: ChoiceAnswer | undefined, elements: ScreenElement[]): ElementChoice => {
	const valid = answer
		&& typeof answer.choice === "string"
		&& (answer.choice === NONE || elementForOption(answer.choice, elements) !== undefined)
		&& Number.isFinite(answer.confidence)
		&& answer.confidence >= 0
		&& answer.confidence <= 1
		&& answer.probabilities !== null
		&& typeof answer.probabilities === "object";
	if (!valid) {
		throw new ActionableError("TypeSafe returned an invalid answer, nothing was tapped");
	}

	const ranked = Object.entries(answer.probabilities)
		.map(([option, probability]) => ({ element: elementForOption(option, elements), probability }))
		.filter((candidate): candidate is { element: ScreenElement; probability: number } =>
			candidate.element !== undefined && Number.isFinite(candidate.probability))
		.sort((a, b) => b.probability - a.probability)
		.slice(0, CANDIDATES_SHOWN);

	return {
		element: answer.choice === NONE ? null : elementForOption(answer.choice, elements) ?? null,
		confidence: answer.confidence,
		ranked,
	};
};

export const isConfident = (choice: ElementChoice): boolean => choice.element !== null && choice.confidence >= MIN_CONFIDENCE;

/**
 * Asks Jev which of the observed elements matches a short description of the
 * tap target. The answer can only point at an observed element, never at
 * coordinates the model made up.
 */
export const chooseElement = async (target: string, elements: ScreenElement[], screen: Dimensions): Promise<ElementChoice> => {
	if (elements.length === 0) {
		return { element: null, confidence: 0, ranked: [] };
	}

	const request = buildRequest(target, elements, screen);
	let body: { answers?: { element?: ChoiceAnswer } };
	try {
		const response = await fetch(TYPESAFE_URL, {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${process.env.TYPESAFE_API_KEY}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(request),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});

		if (!response.ok) {
			throw new ActionableError(`TypeSafe returned HTTP ${response.status}, nothing was tapped`);
		}

		body = await response.json();
	} catch (err: any) {
		if (err instanceof ActionableError) {
			throw err;
		}

		// timeout, network failure or a body that is not json
		throw new ActionableError(`TypeSafe request failed (${err?.message ?? err}), nothing was tapped`);
	}

	return parseAnswer(body?.answers?.element, elements);
};

const MAX_TAP_ATTEMPTS = 2;

const describeElement = (element: ScreenElement, screen: Dimensions): string => {
	const { x, y } = centerOf(element, screen);
	const name = element.text || element.label?.split("\n")[0] || element.name || element.identifier || "";
	return `${element.ref ? `${element.ref} ` : ""}${shortType(element.type)} "${name}" at ${x},${y}`;
};

/**
 * Reads the screen, lets Jev pick the element matching `target` (adding OCR
 * text when the tree has no confident match) and taps it. Taps nothing when
 * unsure; reads the screen once more when the chosen ref went stale.
 */
export const tapByDescription = async (robot: Robot, target: string): Promise<string> => {
	for (let attempt = 1; ; attempt++) {
		const tree = await robot.getElementsOnScreen();
		const screen = await currentViewport(robot, tree);
		let source = "accessibility tree";
		let choice = await chooseElement(target, compactElements(tree, screen), screen);
		if (!isConfident(choice) && isOcrSupported()) {
			source = "accessibility tree + OCR";
			choice = await chooseElement(target, compactElements(await withOcrElements(robot, tree), screen), screen);
		}

		const element = choice.element;
		if (!element || !isConfident(choice)) {
			const closest = choice.ranked.map(c => `${describeElement(c.element, screen)} (${c.probability.toFixed(2)})`).join(", ") || "none";
			throw new ActionableError(`Nothing tapped: no element matches "${target}" confidently (confidence ${choice.confidence.toFixed(2)}, searched ${source}). Closest: ${closest}`);
		}

		try {
			if (element.ref && robot.tapByRef) {
				await robot.tapByRef(element.ref);
			} else {
				const { x, y } = centerOf(element, screen);
				await robot.tap(x, y);
			}
		} catch (err: any) {
			// the screen changed between reading it and tapping, read it again rather than tap a stale target
			if (attempt < MAX_TAP_ATTEMPTS && /not found on current screen/.test(String(err?.message))) {
				continue;
			}

			throw err;
		}

		return `Tapped ${describeElement(element, screen)} (confidence ${choice.confidence.toFixed(2)}, from ${source}${attempt > 1 ? ", after the screen changed" : ""})`;
	}
};
