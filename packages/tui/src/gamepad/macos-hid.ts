import { createRequire } from "node:module";
import type { GamepadEvent, GamepadInputSource } from "./types.js";

const cjsRequire = createRequire(import.meta.url);

interface HidDeviceInfo {
	path?: string;
	vendorId?: number;
	productId?: number;
	usagePage?: number;
	usage?: number;
	interface?: number;
	product?: string;
}

interface HidDeviceLike {
	on(event: "data", listener: (data: Buffer) => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	close(): void;
	setNonBlocking?(enabled: boolean): void;
}

interface HidModuleLike {
	devices(): HidDeviceInfo[];
	HID: new (path: string, options?: { nonExclusive?: boolean }) => HidDeviceLike;
}

const VENDOR_SONY = 0x054c;
const PRODUCT_DUALSENSE_USB = 0x0ce6;
const PRODUCT_DUALSENSE_EDGE = 0x0df2;

function loadHidModule(): HidModuleLike | undefined {
	try {
		return cjsRequire("node-hid") as HidModuleLike;
	} catch {
		return undefined;
	}
}

function mapButtonName(button: number): string {
	switch (button) {
		case 0:
			return "cross";
		case 1:
			return "circle";
		case 2:
			return "square";
		case 3:
			return "triangle";
		case 4:
			return "l1";
		case 5:
			return "r1";
		case 6:
			return "l2";
		case 7:
			return "r2";
		case 8:
			return "create";
		case 9:
			return "options";
		case 10:
			return "l3";
		case 11:
			return "r3";
		case 12:
			return "ps";
		case 13:
			return "touchpad";
		case 14:
			return "dpad-left";
		case 15:
			return "dpad-right";
		case 16:
			return "dpad-up";
		case 17:
			return "dpad-down";
		default:
			return `button-${button}`;
	}
}

function mapAxisName(axis: number): string {
	switch (axis) {
		case 0:
			return "left-stick-x";
		case 1:
			return "left-stick-y";
		case 2:
			return "right-stick-x";
		case 3:
			return "right-stick-y";
		case 4:
			return "l2-analog";
		case 5:
			return "r2-analog";
		default:
			return `axis-${axis}`;
	}
}

function mapButtonToKey(button: number): string | undefined {
	switch (button) {
		case 0:
			return "\r";
		case 1:
			return "\x1b";
		case 2:
			return "\t";
		case 3:
			return "\x1b[Z";
		case 4:
			return "\x1b[5~";
		case 5:
			return "\x1b[6~";
		case 9:
			return "\x1b";
		case 14:
			return "\x1b[D";
		case 15:
			return "\x1b[C";
		case 16:
			return "\x1b[A";
		case 17:
			return "\x1b[B";
		default:
			return undefined;
	}
}

function normalizeSignedByte(value: number): number {
	return Math.max(-1, Math.min(1, (value - 128) / 127));
}

function normalizeUnsignedByte(value: number): number {
	return Math.max(0, Math.min(1, value / 255));
}

function pickReportOffset(data: Uint8Array): number | undefined {
	// USB report commonly starts with 0x01 and payload from index 0.
	if (data.length >= 11 && data[0] === 0x01) return 0;
	// Bluetooth report commonly starts with 0x31 and payload from index 1.
	if (data.length >= 12 && data[0] === 0x31) return 1;
	return undefined;
}

function isGamepadUsage(device: HidDeviceInfo): boolean {
	return device.usagePage === 0x01 && (device.usage === 0x04 || device.usage === 0x05);
}

function isLikelyDualSense(device: HidDeviceInfo): boolean {
	if (device.vendorId !== VENDOR_SONY) return false;
	if (device.productId === PRODUCT_DUALSENSE_USB) return true;
	if (device.productId === PRODUCT_DUALSENSE_EDGE) return true;
	return (device.product || "").toLowerCase().includes("dualsense");
}

function selectDevice(devices: HidDeviceInfo[], preferredPath?: string): HidDeviceInfo | undefined {
	if (preferredPath) {
		return devices.find((device) => device.path === preferredPath);
	}

	const gamepadDevices = devices.filter((device) => device.path && isGamepadUsage(device));
	if (gamepadDevices.length === 0) return undefined;

	return gamepadDevices.find((device) => isLikelyDualSense(device)) || gamepadDevices[0];
}

export class MacOSHidInputSource implements GamepadInputSource {
	private emitter?: (event: GamepadEvent) => void;
	private device?: HidDeviceLike;
	private buttonState = new Map<number, boolean>();
	private axisState = new Map<number, number>();

	constructor(private devicePath?: string) {}

	start(emitter: (event: GamepadEvent) => void): void {
		this.emitter = emitter;
		const hid = loadHidModule();
		if (!hid) return;

		const selected = selectDevice(hid.devices(), this.devicePath);
		if (!selected?.path) return;

		try {
			this.device = new hid.HID(selected.path, { nonExclusive: true });
		} catch {
			try {
				this.device = new hid.HID(selected.path);
			} catch {
				this.device = undefined;
				return;
			}
		}

		try {
			this.device.setNonBlocking?.(true);
		} catch {
			// Some node-hid builds throw in native callback; non-blocking is optional.
		}

		this.device.on("data", (buffer) => {
			this.handleReport(buffer);
		});
		this.device.on("error", () => this.stop());
	}

	stop(): void {
		if (this.device) {
			try {
				this.device.close();
			} catch {
				// no-op
			}
			this.device = undefined;
		}
		this.buttonState.clear();
		this.axisState.clear();
	}

	private handleReport(buffer: Buffer): void {
		if (!this.emitter) return;

		const data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
		const offset = pickReportOffset(data);
		if (offset === undefined) return;

		const timestampMs = Date.now();
		const leftX = data[offset + 1] ?? 128;
		const leftY = data[offset + 2] ?? 128;
		const rightX = data[offset + 3] ?? 128;
		const rightY = data[offset + 4] ?? 128;
		const l2 = data[offset + 5] ?? 0;
		const r2 = data[offset + 6] ?? 0;
		const buttons0 = data[offset + 8] ?? 0;
		const buttons1 = data[offset + 9] ?? 0;
		const buttons2 = data[offset + 10] ?? 0;

		this.emitAxis(0, leftX, normalizeSignedByte(leftX), timestampMs);
		this.emitAxis(1, leftY, normalizeSignedByte(leftY), timestampMs);
		this.emitAxis(2, rightX, normalizeSignedByte(rightX), timestampMs);
		this.emitAxis(3, rightY, normalizeSignedByte(rightY), timestampMs);
		this.emitAxis(4, l2, normalizeUnsignedByte(l2), timestampMs);
		this.emitAxis(5, r2, normalizeUnsignedByte(r2), timestampMs);

		const dpad = buttons0 & 0x0f;
		this.emitButton(14, dpad === 6 || dpad === 7 || dpad === 8, timestampMs);
		this.emitButton(15, dpad === 2 || dpad === 3 || dpad === 4, timestampMs);
		this.emitButton(16, dpad === 0 || dpad === 1 || dpad === 7, timestampMs);
		this.emitButton(17, dpad === 4 || dpad === 5 || dpad === 6, timestampMs);

		this.emitButton(2, (buttons0 & (1 << 4)) !== 0, timestampMs); // square
		this.emitButton(0, (buttons0 & (1 << 5)) !== 0, timestampMs); // cross
		this.emitButton(1, (buttons0 & (1 << 6)) !== 0, timestampMs); // circle
		this.emitButton(3, (buttons0 & (1 << 7)) !== 0, timestampMs); // triangle

		this.emitButton(4, (buttons1 & (1 << 0)) !== 0, timestampMs); // l1
		this.emitButton(5, (buttons1 & (1 << 1)) !== 0, timestampMs); // r1
		this.emitButton(6, (buttons1 & (1 << 2)) !== 0, timestampMs); // l2 button
		this.emitButton(7, (buttons1 & (1 << 3)) !== 0, timestampMs); // r2 button
		this.emitButton(8, (buttons1 & (1 << 4)) !== 0, timestampMs); // create
		this.emitButton(9, (buttons1 & (1 << 5)) !== 0, timestampMs); // options
		this.emitButton(10, (buttons1 & (1 << 6)) !== 0, timestampMs); // l3
		this.emitButton(11, (buttons1 & (1 << 7)) !== 0, timestampMs); // r3
		this.emitButton(12, (buttons2 & (1 << 0)) !== 0, timestampMs); // ps
		this.emitButton(13, (buttons2 & (1 << 1)) !== 0, timestampMs); // touchpad
	}

	private emitAxis(index: number, value: number, normalizedValue: number, timestampMs: number): void {
		if (!this.emitter) return;
		const previous = this.axisState.get(index);
		if (previous === value) return;
		this.axisState.set(index, value);

		this.emitter({
			source: "macos-hid",
			timestampMs,
			kind: "axis",
			index,
			name: mapAxisName(index),
			value,
			normalizedValue,
			isInit: false,
		});
	}

	private emitButton(index: number, pressed: boolean, timestampMs: number): void {
		if (!this.emitter) return;
		const previous = this.buttonState.get(index);
		if (previous === pressed) return;
		this.buttonState.set(index, pressed);

		this.emitter({
			source: "macos-hid",
			timestampMs,
			kind: "button",
			index,
			name: mapButtonName(index),
			value: pressed ? 1 : 0,
			normalizedValue: pressed ? 1 : 0,
			pressed,
			isInit: false,
			mappedKeySequence: pressed ? mapButtonToKey(index) : undefined,
		});
	}
}

export function createMacOSHidInputSource(options?: {
	force?: boolean;
	devicePath?: string;
}): MacOSHidInputSource | undefined {
	if (process.platform !== "darwin") return undefined;
	if (!options?.force && process.env.PI_GAMEPAD !== "1") return undefined;

	const devicePath = options?.devicePath || process.env.PI_GAMEPAD_HID_PATH;
	return new MacOSHidInputSource(devicePath);
}
