export type GamepadEventKind = "button" | "axis";
export type GamepadEventSource = "linux-joystick" | "macos-hid";

export interface GamepadEvent {
	/** Runtime source identifier, useful for multi-platform handlers. */
	source: GamepadEventSource;
	/** Kernel event timestamp in milliseconds (js_event.time). */
	timestampMs: number;
	kind: GamepadEventKind;
	/** Button/axis index from joystick API. */
	index: number;
	/** Human-readable name for known controls. */
	name: string;
	/** Raw value from joystick event. */
	value: number;
	/** Normalized value in [-1, 1] for axes, 0/1 for buttons. */
	normalizedValue: number;
	/** Button press state (button events only). */
	pressed?: boolean;
	/** Whether event is part of initial state replay. */
	isInit: boolean;
	/** Optional terminal key sequence mapping for compatibility input path. */
	mappedKeySequence?: string;
}

export type GamepadEventListener = (event: GamepadEvent) => void;

export interface GamepadInputSource {
	start(emitter: (event: GamepadEvent) => void): void;
	stop(): void;
}
