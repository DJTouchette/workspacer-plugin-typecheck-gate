# Typecheck Gate

Don't let an agent 'finish' with a red typecheck.

A [workspacer](https://github.com/DJTouchette/workspacer) hub plugin (sidecar). Implemented and exercised end-to-end against a headless workspacer hub.

## What it does

When an agent ends a turn (`agent.state_changed` with `hookEvent === "Stop"`), the
sidecar runs your typecheck/lint command in that agent's working directory. If the
command exits non-zero it:

1. calls `claude.gate` (`{ sessionId, on: true }`) to **hold the turn open** so the
   agent can't "finish" red;
2. feeds the error output back to the agent via `agents.sendMessage` so it can fix
   the failures and re-run; and
3. posts a **warn** notification via `notifications.post` — it lands in workspacer's
   in-app notification center (bell + toast) and, per your notification
   preferences, as a clickable OS notification. Clicking it focuses the gated
   agent. The body names the failing command and a best-effort error-line count.
   Notifications are keyed **per session**, so a repeat failure replaces the
   standing warning instead of stacking.

If the check passes on the first try it does nothing (no notification). If this
session had been gated by a previous failure, the gate is released
(`claude.gate { on: false }`) and a **success** notification with the same key
replaces the warning, so the center shows the gate's current truth, not its
history.

Guardrails:

- The check runs asynchronously (`child_process.exec`) so it never blocks the bus
  event loop, with a 180s timeout and a bounded output buffer.
- Each Stop is gated at most once: an in-flight guard plus an 8s per-session
  cooldown coalesce the duplicate/rapid Stop events claudemon can emit.
- Fed-back error output is truncated to its last ~4000 chars.

## Bus wiring

- **Subscribes to:** `agent.state_changed`
- **Calls capabilities:** `claude.gate`, `agents.sendMessage`, `agents.list`, `notifications.post`
  - `claude.gate` only takes `{ sessionId, on }` (a boolean hold) — it can't carry a
    message, so the failing output is delivered to the agent with `agents.sendMessage`.
  - `agents.list` is used only as a fallback to resolve the agent's `cwd` when the
    `agent.state_changed` event doesn't carry one.
- **Emits:** —
- **Settings:**
- `checkCommand` (string, default `npm run typecheck`) — Command that must exit 0 to pass the gate.
- `notify` (boolean, default `true`) — Post the warn/success gate notifications;
  off silences them, but the gate + agent feedback still apply.

## Run it

1. Copy this folder to `~/.config/workspacer/plugins/typecheck-gate/` (or install from GitHub via the workspacer command palette → *Install from GitHub…* → `DJTouchette/workspacer-plugin-typecheck-gate`).
2. Reload plugins in workspacer.
   The hub supervises `node server.js` and injects the bus token.
3. Open the **Typecheck Gate** pane from the command palette.

## Implement

The logic lives in `server.js` → `onEvent(event)`. It filters for
`agent.state_changed` events with `hookEvent === "Stop"`, resolves the agent's
`cwd` (from the event, falling back to `agents.list`), runs `settings.checkCommand`
there, and on failure calls `claude.gate` + `agents.sendMessage` +
`notifications.post` as described above. Per-session `lastRunAt` / `inFlight` /
`gatedSessions` maps provide the dedup, cooldown, and gate-release behavior.

## Layout

```
typecheck-gate/
  plugin.json      # manifest (events + capabilities)
  server.js        # zero-dep Node sidecar; implement onEvent()
  README.md
```

## License

MIT
