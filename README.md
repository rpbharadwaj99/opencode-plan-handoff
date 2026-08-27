# opencode-plan-handoff

OpenCode's build agent offers a handoff to the Plan agent via a native
permission dialog, and swaps on approval.

## Files

- `plan-handoff.js` — drop into `~/.config/opencode/plugin/`. Registers a
  `plan_handoff` tool; a system-prompt directive (build turns only) tells the
  model to call it instead of starting plan-worthy work. The tool's `ctx.ask()`
  raises OpenCode's native permission dialog; on approval it flips the TUI via
  `agent_cycle` and replays the original request to the plan agent once the
  session goes idle (prompting mid-turn only queues).
- `opencode.jsonc` — merge into `~/.config/opencode/opencode.jsonc`. The
  `"plan_handoff": "ask"` permission is required: build's default ruleset
  starts with a wildcard `"*": "allow"` that would silently approve the
  dialog. User config rules are evaluated last, so this pin wins.

Disable with `OPENCODE_NO_PLAN_HANDOFF=1`. Tested on OpenCode 1.18.23.

OpenCode is pre-wiring a native `plan_enter` tool for this exact flow
(`tool/plan-enter.txt` + permissions exist; tool not shipped as of 1.18.23,
even on dev). When it lands, delete this plugin and use the native tool.
