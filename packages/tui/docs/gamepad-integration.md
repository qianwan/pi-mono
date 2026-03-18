# Gamepad Integration Guide (Game Apps)

This guide is for game-like applications that want to consume runtime gamepad events from `@mariozechner/pi-tui`.

It focuses on:

- listening to structured `GamepadEvent`s in app code
- using real hardware reads on Linux/macOS
- avoiding keyboard-emulation-only integrations

## Runtime Model

`ProcessTerminal` exposes app-layer gamepad listeners:

- `addGamepadListener(listener)`
- `removeGamepadListener(listener)`

When at least one listener is registered, `ProcessTerminal` attempts to start a platform runtime source:

- Linux: joystick API (`/dev/input/js*`)
- macOS: HID API via `node-hid` native module

This means your game can integrate directly with gamepad events without routing through keyboard shortcuts.

## Quick Start

```typescript
import { ProcessTerminal, TUI, type GamepadEvent } from "@mariozechner/pi-tui";

const terminal = new ProcessTerminal();
const tui = new TUI(terminal);

const unsubscribe = terminal.addGamepadListener?.((event: GamepadEvent) => {
  // Prefer structured events for gameplay logic
  if (event.kind === "button" && event.pressed && event.name === "cross") {
    console.log("jump");
  }

  if (event.kind === "axis" && event.name === "left-stick-x") {
    // normalizedValue is in [-1, 1]
    console.log("moveX", event.normalizedValue);
  }
});

tui.start();

// Later during teardown:
unsubscribe?.();
tui.stop();
```

## Event Shape

`GamepadEvent` includes both raw and normalized signals:

- `source`: runtime source (`"linux-joystick"` or `"macos-hid"`)
- `kind`: `"button" | "axis"`
- `name`: semantic control name (`cross`, `left-stick-x`, etc.)
- `value`: raw source value
- `normalizedValue`: normalized value (`button: 0/1`, `axis: -1..1` or `0..1` for triggers)
- `pressed`: present for button events
- `mappedKeySequence`: optional keyboard-sequence compatibility mapping

For game apps, prefer `kind/name/normalizedValue` over `mappedKeySequence`.

## Platform Setup

### Linux

If needed, set an explicit joystick device:

```bash
PI_GAMEPAD_DEVICE=/dev/input/js0 your-game-command
```

### macOS

macOS runtime source uses `node-hid`.

Optional explicit HID path override:

```bash
PI_GAMEPAD_HID_PATH=<hid-device-path> your-game-command
```

If you do not set `PI_GAMEPAD_HID_PATH`, runtime selects an enumerated gamepad device automatically.

Avoid pinning stale `DevSrvsID:*` paths across reconnects.

## Optional Keyboard Compatibility Path

If you also want gamepad-to-keyboard emulation for existing key handlers, set:

```bash
PI_GAMEPAD=1 your-game-command
```

Notes:

- listener-based structured events work without `PI_GAMEPAD=1`
- `PI_GAMEPAD=1` additionally feeds mapped key sequences into normal terminal input handling

## Real Hardware Validation

Before app wiring, validate events from the actual controller:

```bash
node packages/tui/scripts/gamepad-monitor.mjs --raw
```

Expected:

- startup shows selected device path and product
- button events (`[btn ]`) and axis events (`[axis]`) stream while interacting

## Recommended Game Integration Pattern

Use a dedicated adapter module in your app, for example:

- `input/gamepad/terminal-source.ts` (subscribe/unsubscribe)
- `input/gamepad/action-mapper.ts` (map events -> game actions)
- `input/gamepad/state.ts` (held buttons, axis deadzones, repeat policy)

Keep raw terminal wiring separated from gameplay action semantics.

## Troubleshooting

- No events at all:
  - verify monitor script receives hardware events first
  - ensure controller is connected before app startup
- macOS open failure (`cannot open device with path ...`):
  - reconnect controller and retry (path may have changed)
  - clear any stale `PI_GAMEPAD_HID_PATH`
  - ensure `node-hid` is installed for your environment
- High axis noise around center:
  - apply deadzone in app action mapper (for example `abs(value) < 0.1 => 0`)

