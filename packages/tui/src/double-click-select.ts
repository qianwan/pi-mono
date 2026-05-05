/**
 * Double-click smart selection strategies.
 *
 * Priority: bracket pair > URL > file path > word (with Chinese segmentation).
 */

import { getSegmenter, visibleWidth } from "./utils.js";

const BRACKET_PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
const CLOSE_TO_OPEN: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
const MAX_BRACKET_SCAN_LINES = 500;

/** Characters valid in file paths: word chars, slashes, dots, hyphens, tilde, @, + */
function isPathChar(ch: string): boolean {
	return /[\w.\-/~@+]/.test(ch);
}

/** Characters valid in code tokens: word chars, dots, hyphens */
function isCodeTokenChar(ch: string): boolean {
	return /[\w.-]/.test(ch);
}

/** Characters valid in URLs: ASCII printable non-space (0x21-0x7E) */
function isUrlChar(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return code >= 0x21 && code <= 0x7e;
}

export interface SelectionRange {
	startRow: number;
	startCol: number;
	endRow: number;
	endCol: number;
}

/**
 * Convert a 0-based screen column to a 0-based string character index.
 * Fullwidth characters (CJK, etc.) occupy 2 screen columns but 1 string index.
 */
export function screenColToIndex(line: string, screenCol: number): number {
	let col = 0;
	for (const { segment, index } of getSegmenter().segment(line)) {
		const w = visibleWidth(segment);
		if (col + w > screenCol) return index;
		col += w;
	}
	return line.length;
}

/**
 * Convert a 0-based string character index to a 0-based screen column.
 */
export function indexToScreenCol(line: string, index: number): number {
	return visibleWidth(line.slice(0, index));
}

type GetLine = (row: number) => string;

// Singleton word segmenter with Chinese support
let _wordSegmenter: Intl.Segmenter | null = null;
function getWordSegmenter(): Intl.Segmenter {
	if (!_wordSegmenter) {
		_wordSegmenter = new Intl.Segmenter("zh", { granularity: "word" });
	}
	return _wordSegmenter;
}

/**
 * Determine the selection range for a double-click at (row, col).
 * Coordinates are 0-based. `getLine` returns plain text (no ANSI).
 */
export function doubleClickSelect(
	getLine: GetLine,
	totalLines: number,
	row: number,
	col: number,
): SelectionRange | null {
	if (row < 0 || row >= totalLines) return null;
	const line = getLine(row);
	if (col < 0 || col >= line.length) return null;
	const ch = line[col]!;

	// 1. Bracket pair
	const bracket = selectBracketPair(getLine, totalLines, row, col, ch);
	if (bracket) return bracket;

	// 2. URL
	const url = selectUrl(line, row, col);
	if (url) return url;

	// 3. File path
	const path = selectPath(line, row, col);
	if (path) return path;

	// 4. Code token (hyphenated/dotted identifiers like `double-click-select.ts`)
	const token = selectCodeToken(line, row, col);
	if (token) return token;

	// 5. Word (with Chinese segmentation)
	return selectWord(line, row, col);
}

// ---------------------------------------------------------------------------
// Bracket pair matching
// ---------------------------------------------------------------------------

function selectBracketPair(
	getLine: GetLine,
	totalLines: number,
	row: number,
	col: number,
	ch: string,
): SelectionRange | null {
	if (ch in BRACKET_PAIRS) {
		// Opening bracket: search forward for closing
		const closing = BRACKET_PAIRS[ch]!;
		const match = scanForward(getLine, totalLines, row, col, ch, closing);
		if (match) return { startRow: row, startCol: col, endRow: match.row, endCol: match.col + 1 };
	}
	if (ch in CLOSE_TO_OPEN) {
		// Closing bracket: search backward for opening
		const opening = CLOSE_TO_OPEN[ch]!;
		const match = scanBackward(getLine, row, col, opening, ch);
		if (match) return { startRow: match.row, startCol: match.col, endRow: row, endCol: col + 1 };
	}
	return null;
}

function scanForward(
	getLine: GetLine,
	totalLines: number,
	startRow: number,
	startCol: number,
	open: string,
	close: string,
): { row: number; col: number } | null {
	let depth = 0;
	const maxRow = Math.min(totalLines, startRow + MAX_BRACKET_SCAN_LINES);
	for (let r = startRow; r < maxRow; r++) {
		const line = getLine(r);
		const startC = r === startRow ? startCol : 0;
		for (let c = startC; c < line.length; c++) {
			const ch = line[c];
			if (ch === open) depth++;
			else if (ch === close) {
				depth--;
				if (depth === 0) return { row: r, col: c };
			}
		}
	}
	return null;
}

function scanBackward(
	getLine: GetLine,
	startRow: number,
	startCol: number,
	open: string,
	close: string,
): { row: number; col: number } | null {
	let depth = 0;
	const minRow = Math.max(0, startRow - MAX_BRACKET_SCAN_LINES);
	for (let r = startRow; r >= minRow; r--) {
		const line = getLine(r);
		const startC = r === startRow ? startCol : line.length - 1;
		for (let c = startC; c >= 0; c--) {
			const ch = line[c];
			if (ch === close) depth++;
			else if (ch === open) {
				depth--;
				if (depth === 0) return { row: r, col: c };
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// URL selection
// ---------------------------------------------------------------------------

const URL_SCHEME_RE = /^(https?|ftp):\/\//;

function selectUrl(line: string, row: number, col: number): SelectionRange | null {
	// Expand left through ASCII printable chars (stops at CJK punctuation, whitespace)
	let left = col;
	while (left > 0 && isUrlChar(line[left - 1]!)) left--;

	const token = line.slice(left);
	if (!URL_SCHEME_RE.test(token)) return null;

	// Expand right through ASCII printable chars
	let right = col;
	while (right < line.length - 1 && isUrlChar(line[right + 1]!)) right++;
	right++; // exclusive end

	// Trim trailing punctuation that likely isn't part of the URL
	while (right > left) {
		const last = line[right - 1]!;
		if (last === "." || last === "," || last === ";") {
			right--;
		} else if (last === ")" && !balanced(line, left, right, "(", ")")) {
			right--;
		} else if (last === "]" && !balanced(line, left, right, "[", "]")) {
			right--;
		} else {
			break;
		}
	}

	return { startRow: row, startCol: left, endRow: row, endCol: right };
}

/** Check if open/close brackets are balanced within line[start..end). */
function balanced(line: string, start: number, end: number, open: string, close: string): boolean {
	let depth = 0;
	for (let i = start; i < end; i++) {
		if (line[i] === open) depth++;
		else if (line[i] === close) depth--;
	}
	return depth === 0;
}

// ---------------------------------------------------------------------------
// Path selection
// ---------------------------------------------------------------------------

function selectPath(line: string, row: number, col: number): SelectionRange | null {
	// Expand through path-valid characters only
	let left = col;
	while (left > 0 && isPathChar(line[left - 1]!)) left--;
	let right = col;
	while (right < line.length - 1 && isPathChar(line[right + 1]!)) right++;
	right++; // exclusive end

	const token = line.slice(left, right);

	// Must contain / and not be a URL (already handled above)
	if (!token.includes("/")) return null;
	if (URL_SCHEME_RE.test(token)) return null;

	return { startRow: row, startCol: left, endRow: row, endCol: right };
}

// ---------------------------------------------------------------------------
// Code token selection (hyphenated/dotted identifiers)
// ---------------------------------------------------------------------------

/**
 * Select the full whitespace-delimited token if it contains connectors
 * (hyphens between word chars, or dots followed by word chars) that would
 * cause Intl.Segmenter to split it. Handles filenames like `foo-bar.ts`,
 * CSS classes like `my-component`, etc.
 */
function selectCodeToken(line: string, row: number, col: number): SelectionRange | null {
	// Expand through code-token-valid characters only
	let left = col;
	while (left > 0 && isCodeTokenChar(line[left - 1]!)) left--;
	let right = col;
	while (right < line.length - 1 && isCodeTokenChar(line[right + 1]!)) right++;
	right++;

	const token = line.slice(left, right);

	// Only match tokens with hyphens between word chars or internal dots followed by word chars
	const hasHyphenConnector = /\w-\w/.test(token);
	const hasDotConnector = /\w\.\w/.test(token);
	if (!hasHyphenConnector && !hasDotConnector) return null;

	return { startRow: row, startCol: left, endRow: row, endCol: right };
}

// ---------------------------------------------------------------------------
// Word selection (Chinese + Latin)
// ---------------------------------------------------------------------------

function selectWord(line: string, row: number, col: number): SelectionRange | null {
	const segmenter = getWordSegmenter();
	for (const seg of segmenter.segment(line)) {
		const start = seg.index;
		const end = start + seg.segment.length;
		if (col >= start && col < end) {
			return { startRow: row, startCol: start, endRow: row, endCol: end };
		}
	}
	// Fallback: select the single character
	return { startRow: row, startCol: col, endRow: row, endCol: col + 1 };
}
