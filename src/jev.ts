import { ActionableError, Dimensions, ScreenElement } from "./robot";

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

export const centerOf = (element: ScreenElement): { x: number; y: number } => ({
	x: Math.round(element.rect.x + element.rect.width / 2),
	y: Math.round(element.rect.y + element.rect.height / 2),
});

export const shortType = (type: string): string => type.substring(type.lastIndexOf(".") + 1);

const describe = (element: ScreenElement) => ({
	type: shortType(element.type),
	text: element.text || undefined,
	label: element.label || undefined,
	name: element.name || undefined,
	value: element.value || undefined,
	id: element.identifier || undefined,
	center: centerOf(element),
	size: `${element.rect.width}x${element.rect.height}`,
});

// option "1" is elements[0]; the state carries only what every option shares
export const buildRequest = (target: string, elements: ScreenElement[], screen: Dimensions) => {
	if (elements.length >= MAX_OPTIONS) {
		throw new ActionableError(`Too many elements on screen (${elements.length}) to choose from, use mobile_list_elements_on_screen instead`);
	}

	const criteria: Record<string, object | string> = {};
	elements.forEach((element, i) => {
		criteria[String(i + 1)] = describe(element);
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
		&& (answer.choice === NONE || elementForOption(answer.choice, elements) !== undefined)
		&& Number.isFinite(answer.confidence)
		&& answer.probabilities !== null
		&& typeof answer.probabilities === "object";
	if (!valid) {
		throw new ActionableError("TypeSafe returned an invalid answer, nothing was tapped");
	}

	const ranked = Object.entries(answer.probabilities)
		.map(([option, probability]) => ({ element: elementForOption(option, elements), probability }))
		.filter((candidate): candidate is { element: ScreenElement; probability: number } => candidate.element !== undefined)
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

	return parseAnswer(body.answers?.element, elements);
};
