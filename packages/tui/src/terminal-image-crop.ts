import { crop, PhotonImage } from "@silvia-odwyer/photon-node";
import { encodeITerm2, encodeKitty, getCellDimensions } from "./terminal-image.js";

type ImageProtocol = "kitty" | "iterm2";

type ParsedImageLine = {
	protocol: ImageProtocol;
	base64Data: string;
	maxWidthCells: number;
};

const KITTY_SEGMENT_RE = /\x1b_G([^\x1b]*?);([A-Za-z0-9+/=]*)\x1b\\/g;
const ITERM2_RE = /\x1b\]1337;File=([^:]*):([A-Za-z0-9+/=]+)\x07/;

function parseKittyLine(line: string): ParsedImageLine | null {
	let base64Data = "";
	let maxWidthCells: number | undefined;
	let match = KITTY_SEGMENT_RE.exec(line);
	while (match !== null) {
		const params = match[1] ?? "";
		const payload = match[2] ?? "";
		base64Data += payload;
		if (maxWidthCells === undefined && params) {
			for (const param of params.split(",")) {
				if (!param.startsWith("c=")) continue;
				const value = parseInt(param.slice(2), 10);
				if (!Number.isNaN(value)) {
					maxWidthCells = value;
					break;
				}
			}
		}
		match = KITTY_SEGMENT_RE.exec(line);
	}

	if (!base64Data || maxWidthCells === undefined) return null;
	return { protocol: "kitty", base64Data, maxWidthCells };
}

function parseIterm2Line(line: string): ParsedImageLine | null {
	const match = line.match(ITERM2_RE);
	if (!match) return null;

	const params = match[1] ?? "";
	const base64Data = match[2] ?? "";
	let maxWidthCells: number | undefined;

	for (const param of params.split(";")) {
		if (!param.startsWith("width=")) continue;
		const value = parseInt(param.slice("width=".length), 10);
		if (!Number.isNaN(value)) {
			maxWidthCells = value;
			break;
		}
	}

	if (!base64Data || maxWidthCells === undefined) return null;
	return { protocol: "iterm2", base64Data, maxWidthCells };
}

function parseImageLine(line: string): ParsedImageLine | null {
	if (line.includes("\x1b_G")) {
		return parseKittyLine(line);
	}
	if (line.includes("\x1b]1337;File=")) {
		return parseIterm2Line(line);
	}
	return null;
}

export type ImageCropParams = {
	clipTopRows: number;
	visibleRows: number;
};

export function renderCroppedImageLine(line: string, params: ImageCropParams): string | null {
	if (params.visibleRows <= 0) return null;

	const moveUpMatch = line.match(/^\x1b\[(\d+)A/);
	const lineContent = moveUpMatch ? line.slice(moveUpMatch[0].length) : line;
	const parsed = parseImageLine(lineContent);
	if (!parsed) return null;

	const bytes = Buffer.from(parsed.base64Data, "base64");
	let image: PhotonImage | undefined;
	let cropped: PhotonImage | undefined;

	try {
		image = PhotonImage.new_from_byteslice(new Uint8Array(bytes));
		const originalWidth = image.get_width();
		const originalHeight = image.get_height();

		if (originalWidth <= 0 || originalHeight <= 0) return null;

		const cellDimensions = getCellDimensions();
		const targetWidthPx = parsed.maxWidthCells * cellDimensions.widthPx;
		if (targetWidthPx <= 0) return null;

		const scale = targetWidthPx / originalWidth;
		if (scale <= 0) return null;

		const cropTopPx = Math.max(
			0,
			Math.min(originalHeight, Math.floor((params.clipTopRows * cellDimensions.heightPx) / scale)),
		);
		const cropHeightPx = Math.max(1, Math.ceil((params.visibleRows * cellDimensions.heightPx) / scale));
		const cropBottomPx = Math.min(originalHeight, cropTopPx + cropHeightPx);
		if (cropBottomPx <= cropTopPx) return null;

		cropped = crop(image, 0, cropTopPx, originalWidth, cropBottomPx);
		const croppedBytes = cropped.get_bytes();
		const croppedBase64 = Buffer.from(croppedBytes).toString("base64");

		const moveUp = params.visibleRows > 1 ? `\x1b[${params.visibleRows - 1}A` : "";
		const sequence =
			parsed.protocol === "kitty"
				? encodeKitty(croppedBase64, {
						columns: parsed.maxWidthCells,
						rows: params.visibleRows,
					})
				: encodeITerm2(croppedBase64, {
						width: parsed.maxWidthCells,
						height: params.visibleRows,
						preserveAspectRatio: true,
					});
		return moveUp + sequence;
	} catch {
		return null;
	} finally {
		cropped?.free();
		image?.free();
	}
}
