import * as fs from "node:fs";
import type { GamepadEvent } from "./types.js";

const JS_EVENT_BUTTON = 0x01;
const JS_EVENT_AXIS = 0x02;
const JS_EVENT_INIT = 0x80;
const AXIS_THRESHOLD = 16_384;

type EventEmitter = (event: GamepadEvent) => void;

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
		case 6:
			return "hat-x";
		case 7:
			return "hat-y";
		default:
			return `axis-${axis}`;
	}
}

function mapButtonToKey(button: number): string | undefined {
	switch (button) {
		case 0: // Cross
			return "\r";
		case 1: // Circle
			return "\x1b";
		case 2: // Square
			return "\t";
		case 3: // Triangle
			return "\x1b[Z";
		case 4: // L1
			return "\x1b[5~";
		case 5: // R1
			return "\x1b[6~";
		case 9: // Options
			return "\x1b";
		case 14: // D-pad left (button mapping on some drivers)
			return "\x1b[D";
		case 15: // D-pad right
			return "\x1b[C";
		case 16: // D-pad up
			return "\x1b[A";
		case 17: // D-pad down
			return "\x1b[B";
		default:
			return undefined;
	}
}

/**
 * Linux joystick API input source (/dev/input/js*).
 * Emits normalized gamepad events and optional key mapping hints.
 */
export class LinuxJoystickInputSource {
	private stream?: fs.ReadStream;
	private pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	private axisState = new Map<number, -1 | 0 | 1>();
	private emitter?: EventEmitter;

	constructor(private devicePath: string = "/dev/input/js0") {}

	start(emitter: EventEmitter): void {
		this.emitter = emitter;
		try {
			this.stream = fs.createReadStream(this.devicePath, { highWaterMark: 64 });
		} catch {
			return;
		}

		this.stream.on("data", (chunk) => {
			if (typeof chunk === "string") return;
			this.handleChunk(chunk);
		});
		this.stream.on("error", () => this.stop());
		this.stream.on("close", () => this.stop());
	}

	stop(): void {
		if (this.stream) {
			this.stream.destroy();
			this.stream = undefined;
		}
		this.pending = new Uint8Array(0);
		this.axisState.clear();
	}

	private handleChunk(chunk: Uint8Array<ArrayBufferLike>): void {
		if (this.pending.length === 0) {
			this.pending = chunk;
		} else {
			const merged = new Uint8Array(this.pending.length + chunk.length);
			merged.set(this.pending, 0);
			merged.set(chunk, this.pending.length);
			this.pending = merged;
		}

		while (this.pending.length >= 8) {
			const event = this.pending.subarray(0, 8);
			this.pending = this.pending.subarray(8);
			this.processEvent(event);
		}
	}

	private processEvent(event: Uint8Array<ArrayBufferLike>): void {
		if (!this.emitter) return;

		const view = new DataView(event.buffer, event.byteOffset, event.byteLength);
		const timestampMs = view.getUint32(0, true);
		const value = view.getInt16(4, true);
		const rawType = view.getUint8(6);
		const index = view.getUint8(7);
		const type = rawType & ~JS_EVENT_INIT;
		const isInit = (rawType & JS_EVENT_INIT) !== 0;

		if (type === JS_EVENT_BUTTON) {
			const pressed = value === 1;
			const eventData: GamepadEvent = {
				source: "linux-joystick",
				timestampMs,
				kind: "button",
				index,
				name: mapButtonName(index),
				value,
				normalizedValue: pressed ? 1 : 0,
				pressed,
				isInit,
				mappedKeySequence: pressed ? mapButtonToKey(index) : undefined,
			};
			this.emitter(eventData);
			return;
		}

		if (type !== JS_EVENT_AXIS) return;

		let mappedKeySequence: string | undefined;
		if (index === 6 || index === 7) {
			const prev = this.axisState.get(index) ?? 0;
			let next: -1 | 0 | 1 = 0;
			if (value <= -AXIS_THRESHOLD) next = -1;
			else if (value >= AXIS_THRESHOLD) next = 1;

			if (next !== prev) {
				this.axisState.set(index, next);
				if (next !== 0) {
					if (index === 6) {
						mappedKeySequence = next < 0 ? "\x1b[D" : "\x1b[C";
					} else {
						mappedKeySequence = next < 0 ? "\x1b[A" : "\x1b[B";
					}
				}
			}
		}

		const eventData: GamepadEvent = {
			source: "linux-joystick",
			timestampMs,
			kind: "axis",
			index,
			name: mapAxisName(index),
			value,
			normalizedValue: Math.max(-1, Math.min(1, value / 32767)),
			isInit,
			mappedKeySequence,
		};
		this.emitter(eventData);
	}
}

export function createLinuxJoystickInputSource(options?: {
	force?: boolean;
	devicePath?: string;
}): LinuxJoystickInputSource | undefined {
	if (process.platform !== "linux") return undefined;
	if (!options?.force && process.env.PI_GAMEPAD !== "1") return undefined;
	return new LinuxJoystickInputSource(options?.devicePath || process.env.PI_GAMEPAD_DEVICE || "/dev/input/js0");
}
