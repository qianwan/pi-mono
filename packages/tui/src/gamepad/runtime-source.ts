import { createLinuxJoystickInputSource } from "./linux-joystick.js";
import { createMacOSHidInputSource } from "./macos-hid.js";
import type { GamepadInputSource } from "./types.js";

export function createRuntimeGamepadInputSource(options?: { force?: boolean }): GamepadInputSource | undefined {
	if (process.platform === "linux") {
		return createLinuxJoystickInputSource({ force: options?.force });
	}

	if (process.platform === "darwin") {
		return createMacOSHidInputSource({ force: options?.force });
	}

	return undefined;
}
