# Typecheck Gate

Don't let an agent 'finish' with a red typecheck.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). **Runnable scaffold** — it loads, connects to the hub bus, and shows live activity; the real logic is stubbed with clear TODOs.

## What it does

When an agent reaches Stop, runs your typecheck/lint command and uses `claude.gate` to hold the turn open (with the errors) if it fails — so 'done' actually means green.

## Bus wiring

- **Subscribes to:** `agent.state_changed`
- **Calls capabilities:** `claude.gate`, `notifications.post`
- **Emits:** —
- **Settings:**
- `checkCommand` (string) — Command that must exit 0 to pass the gate.

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/typecheck-gate/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-typecheck-gate`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Typecheck Gate** pane from the command palette.

## Implement

Edit `server.js` → `onEvent(event)`. Subscribed topics arrive there; use `call('method', params)` for capabilities and `publish('command.x', data)` for commands. `settings` holds the host-injected config above.

## Layout

```
typecheck-gate/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
