/**
 * Mouse event parsing for SGR (1006) mouse reporting.
 *
 * SGR format: ESC [ < Btn ; Col ; Row (M=press | m=release)
 *
 * Button encoding (low 2 bits of Btn):
 *   0 = left, 1 = middle, 2 = right, 3 = release (only in legacy X10, not SGR)
 * Scroll (bit 6):
 *   64 = scroll-up, 65 = scroll-down
 * Motion (bit 5):
 *   32 = movement while button held
 * Modifiers:
 *   bit 2 (4)  = shift
 *   bit 3 (8)  = alt/meta
 *   bit 4 (16) = ctrl
 */

export interface MouseEvent {
	action: "press" | "release" | "move";
	button: "left" | "right" | "middle" | "scroll-up" | "scroll-down" | "none";
	/** 1-based column in terminal viewport */
	x: number;
	/** 1-based row in terminal viewport */
	y: number;
	modifiers: { shift: boolean; alt: boolean; ctrl: boolean };
	/** Raw escape sequence for debugging */
	raw: string;
}

// SGR mouse sequence: ESC [ < Btn ; Col ; Row (M|m)
const SGR_MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

/**
 * Check if a string is a SGR mouse escape sequence.
 */
export function isMouseSequence(seq: string): boolean {
	return SGR_MOUSE_RE.test(seq);
}

/**
 * Parse a SGR mouse escape sequence into a structured MouseEvent.
 * Returns null if the sequence is not a valid mouse event.
 */
export function parseMouseSequence(seq: string): MouseEvent | null {
	const match = seq.match(SGR_MOUSE_RE);
	if (!match) return null;

	const btn = parseInt(match[1], 10);
	const x = parseInt(match[2], 10);
	const y = parseInt(match[3], 10);
	const suffix = match[4]; // M = press, m = release

	const isMotion = (btn & 32) !== 0;
	const isScroll = (btn & 64) !== 0;
	const isRelease = suffix === "m";

	let action: MouseEvent["action"];
	if (isMotion) {
		action = "move";
	} else if (isRelease) {
		action = "release";
	} else {
		action = "press";
	}

	let button: MouseEvent["button"];
	if (isScroll) {
		button = (btn & 1) === 0 ? "scroll-up" : "scroll-down";
	} else {
		const btnId = btn & 3;
		switch (btnId) {
			case 0:
				button = "left";
				break;
			case 1:
				button = "middle";
				break;
			case 2:
				button = "right";
				break;
			default:
				button = "none";
				break;
		}
	}

	const modifiers = {
		shift: (btn & 4) !== 0,
		alt: (btn & 8) !== 0,
		ctrl: (btn & 16) !== 0,
	};

	return { action, button, x, y, modifiers, raw: seq };
}
