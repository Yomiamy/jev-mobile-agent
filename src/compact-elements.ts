import { Dimensions, ScreenElement } from "./robot";

// a control that can be tapped even when it carries no text, e.g. an icon-only button
const INTERACTIVE_TYPE = /Button|EditText|TextField|SearchField|Switch|CheckBox|Radio|Slider/i;

const isKnown = (screen: Dimensions): boolean => screen.width > 0 && screen.height > 0;

const isOnScreen = (element: ScreenElement, screen: Dimensions): boolean => {
	const { x, y, width, height } = element.rect;
	return x < screen.width && y < screen.height && x + width > 0 && y + height > 0;
};

const hasContent = (element: ScreenElement): boolean =>
	!!(element.text || element.label || element.name || element.value || element.identifier) || INTERACTIVE_TYPE.test(element.type);

// flutter merged semantics joins the texts of a subtree with newlines and repeats
// that label on every node below; a native content-desc such as a per-row
// "More options" is one line and names each button on its own
// ponytail: dedup is screen-wide, so two cards with identical merged labels keep it
// only on the first; scope it to the owning subtree if that ever shows up
const isMergedLabel = (label: string): boolean => label.includes("\n");

/**
 * Drops what cannot be tapped or read: elements off screen (below the fold, or a
 * previous route shifted out by a transition) and empty layout containers. A
 * merged label repeated by child nodes is kept once.
 */
export const compactElements = (elements: ScreenElement[], screen: Dimensions): ScreenElement[] => {
	const seen = new Set<string>();
	return elements
		.filter(e => !isKnown(screen) || isOnScreen(e, screen))
		.map(e => {
			if (!e.label || !isMergedLabel(e.label)) {
				return e;
			}

			if (seen.has(e.label)) {
				return { ...e, label: undefined };
			}

			seen.add(e.label);
			return e;
		})
		.filter(hasContent);
};
