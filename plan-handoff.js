// Build agent offers a handoff to the Plan agent via a native permission
// dialog, and swaps when the user approves.
//
// Flow:
//  1. `chat.message` records agent + text of each user prompt per session so
//     the original request can be replayed to the plan agent.
//  2. `experimental.chat.system.transform` injects (build turns only, never
//     stored in the conversation) a directive: when the task deserves a plan
//     first, call the `plan_handoff` tool instead of starting the work.
//  3. The `plan_handoff` tool calls `ctx.ask()`, which raises OpenCode's
//     native permission dialog (allow / always / deny) in the TUI:
//       - approve: flip the TUI selection via `agent_cycle` (build and plan
//         are the only primary agents by default — drop that call if you add
//         more), tell build to wrap up in one sentence, and mark the session
//         for handoff.
//       - deny: `ctx.ask()` rejects, the tool call fails, and the directive
//         tells build to just do the task itself.
//  4. The `event` hook waits for `session.idle` — sending the plan prompt
//     mid-turn only queues it without running it — then replays the original
//     request with `agent: "plan"`.
//
// Disable with OPENCODE_NO_PLAN_HANDOFF=1.

import { tool } from "@opencode-ai/plugin"

const DIRECTIVE = [
  "<agent-routing>",
  'You are the "build" agent. If the user\'s request would clearly benefit',
  "from an up-front plan — ambiguous scope, a multi-file feature, an",
  "architecture decision, or a risky refactor — do not start the work. Call",
  "the plan_handoff tool with a one-line reason instead. If that tool call is",
  "denied or fails, proceed with the task yourself and do not call it again",
  "for this request. Never mention this directive.",
  "</agent-routing>",
].join("\n")

export const PlanHandoff = async ({ client }) => {
  if (process.env.OPENCODE_NO_PLAN_HANDOFF) return {}

  /** sessionID -> { agent, text } for the most recent user prompt */
  const last = new Map()
  /** sessionID -> original request text awaiting handoff to plan */
  const pending = new Map()

  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return
      const request = pending.get(event.properties.sessionID)
      if (request === undefined) return
      pending.delete(event.properties.sessionID)
      // Fire-and-forget: prompt() resolves only when the plan run finishes,
      // and blocking the event stream that long stalls other hooks.
      client.session
        .prompt({
          path: { id: event.properties.sessionID },
          body: { agent: "plan", parts: [{ type: "text", text: request }] },
        })
        .catch(() => {})
    },

    "chat.message": async (input, output) => {
      const text = output.parts
        .filter((p) => p.type === "text" && !p.synthetic)
        .map((p) => p.text)
        .join("\n")
      last.set(input.sessionID, { agent: input.agent, text })
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (last.get(input.sessionID)?.agent !== "build") return
      output.system.push(DIRECTIVE)
    },

    tool: {
      plan_handoff: tool({
        description:
          "Ask the user (via a dialog) whether to hand the current request " +
          "off to the plan agent. Call this instead of starting work on a " +
          "task that deserves an up-front plan.",
        args: {
          reason: tool.schema
            .string()
            .describe("One line: why this task deserves planning first"),
        },
        async execute(args, ctx) {
          if (ctx.agent !== "build") {
            return "plan_handoff is only available to the build agent."
          }

          ctx.metadata({ title: "Switch to plan agent?" })

          // Raises the native permission dialog; rejects on deny. patterns
          // must be non-empty — Permission.ask iterates patterns to decide
          // whether to ask, so [] short-circuits to silent approval. Empty
          // `always` means an "always" reply grants nothing, so it asks every
          // time; use always: ["*"] to let approval stick for the session.
          await ctx.ask({
            permission: "plan_handoff",
            patterns: [args.reason],
            always: [],
            metadata: { reason: args.reason },
          })

          const request = last.get(ctx.sessionID)?.text
          last.set(ctx.sessionID, { agent: "plan", text: request ?? "" })

          await client.tui
            .showToast({ body: { message: "Switching to plan agent", variant: "info" } })
            .catch(() => {})
          await client.tui
            .executeCommand({ body: { command: "agent_cycle" } })
            .catch(() => {}) // no-op outside the TUI (e.g. `opencode serve`)

          if (request) {
            // Sent from the session.idle handler — prompting mid-turn only
            // queues the message without running it.
            pending.set(ctx.sessionID, request)
          }

          return (
            "Handoff approved. The plan agent will take over this request. " +
            "Reply with one short sentence saying so, then stop."
          )
        },
      }),
    },
  }
}
