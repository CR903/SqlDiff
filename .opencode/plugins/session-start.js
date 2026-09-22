/* global process */
/**
 * Trellis Session Start Plugin (OpenCode 2)
 *
 * Injects compact SessionStart context into the model-request draft that
 * OpenCode sends to the model. Uses `ctx.session.hook("context", ...)` (and
 * `"compaction"` for checkpoint summarization requests, mirroring V1's
 * `experimental.chat.messages.transform`, which ran for both), so TUI / Web /
 * stored history stay untouched (issue #553).
 */

import { TrellisContext, debugLog, isTrellisSubagent } from "../lib/trellis-context.js"
import {
  prependEphemeralText,
  transcriptHasAssistantMessage,
} from "../lib/context-visibility.js"
import { buildSessionContext } from "../lib/session-utils.js"

const FIRST_REPLY_NOTICE_RE = /<first-reply-notice>[\s\S]*?<\/first-reply-notice>\s*/g

function stripFirstReplyNotice(context) {
  return context.replace(FIRST_REPLY_NOTICE_RE, "")
}

// OpenCode 2 plugin shape: default-export `{ id, setup }`. `setup` receives the
// plugin context and registers hooks on the domains that own them; registrations
// live for the plugin's lifetime. See https://opencode.ai/v2/docs/build/plugins.
export default {
  id: "trellis.session-start",
  async setup(plugin) {
    const directory = plugin.location.directory
    const ctx = new TrellisContext(directory)
    debugLog("session", "Plugin loaded, directory:", directory)

    const handler = async (event) => {
      try {
        const platformInput = { sessionID: event.sessionID, agent: event.agent }
        const agent = platformInput.agent || "unknown"
        debugLog("session", "session hook called, agent:", agent)

        if (isTrellisSubagent(platformInput)) {
          debugLog("session", "Skipping trellis subagent turn:", agent)
          return
        }

        if (process.env.TRELLIS_HOOKS === "0" || process.env.TRELLIS_DISABLE_HOOKS === "1") {
          debugLog("session", "Skipping - TRELLIS_HOOKS disabled")
          return
        }

        if (process.env.OPENCODE_NON_INTERACTIVE === "1") {
          debugLog("session", "Skipping - non-interactive mode")
          return
        }

        let context = buildSessionContext(ctx, platformInput)
        if (transcriptHasAssistantMessage(event.messages)) {
          context = stripFirstReplyNotice(context)
        }
        debugLog("session", "Built context, length:", context.length)
        prependEphemeralText(event.messages, context, "sessionStart")
      } catch (error) {
        debugLog("session", "Error in session hook:", error.message, error.stack)
      }
    }

    // The agent loop and checkpoint summarization are separate request kinds in
    // OpenCode 2; register both so behavior matches V1's per-request transform.
    await plugin.session.hook("context", handler)
    await plugin.session.hook("compaction", handler)
  },
}
