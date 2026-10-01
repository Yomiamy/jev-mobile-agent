import { Dimensions, Robot, ScreenElement } from "./robot";

// a control that can be tapped even when it carries no text, e.g. an icon-only button
const INTERACTIVE_TYPE = /Button|EditText|TextField|SearchField|Switch|CheckBox|Radio|Slider/i;

const isKnown = (screen: Dimensions): boolean => screen.width > 0 && screen.height > 0;

// elements come in the current orientation; bound x by the width and y by the
// height of that orientation. below the fold and a route shifted off to the left
// are dropped, a partly visible element stays
const isOnScreen = (element: ScreenElement, screen: Dimensions): boolean => {
	const { x, y, width, height } = element.rect;
	return x < screen.width && y < screen.height && x + width > 0 && y + height > 0;
};

// the window root spans the whole display in its current orientation, e.g.
// android:id/content or flutter's root box at 0,0
const rootViewport = (elements: ScreenElement[], size: Dimensions): Dimensions | undefined => {
	const short = Math.min(size.width, size.height);
	const long = Math.max(size.width, size.height);
	const root = elements.find(({ rect }) => rect.x === 0 && rect.y === 0 &&
		((rect.width === short && rect.height === long) || (rect.width === long && rect.height === short)));
	return root && { width: root.rect.width, height: root.rect.height };
};

/**
 * The screen size in the current orientation. Robots report either the fixed
 * portrait size (adb `wm size`) or the rotated one, and their orientation can
 * come from the rotation lock setting rather than the display (mobilecli reports
 * portrait for a landscape Chrome with auto-rotate on). So the window root in
 * the dump decides; the reported orientation is only the fallback when the dump
 * has no root, and the reported size when that cannot be read either.
 */
export const currentViewport = async (robot: Robot, elements: ScreenElement[]): Promise<Dimensions> => {
	const size = await robot.getScreenSize();
	const root = rootViewport(elements, size);
	if (root) {
		return root;
	}

	let landscape: boolean;
	try {
		// legacy WDA passes through raw values such as "uia_device_orientation_landscaperight"
		landscape = /landscape/i.test(String(await robot.getOrientation()));
	} catch {
		return size;
	}

	const wide = size.width > size.height;
	return wide === landscape ? size : { ...size, width: size.height, height: size.width };
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
