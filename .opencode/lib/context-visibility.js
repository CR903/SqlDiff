/**
 * Context visibility helpers for the OpenCode 2 plugin API.
 *
 * OpenCode 2 replaced V1's `experimental.chat.messages.transform` hook with
 * `ctx.session.hook("context" | "compaction", ...)`. Those hooks receive the
 * assembled model-request draft: `event.messages` is an array of `@opencode/ai`
 * `Message` values (`{ id?, role, content: ContentPart[] }`), not V1's
 * `{ info, parts }[]` transcript shape.
 *
 * The helpers here inject machine-authored context as an ephemeral synthetic
 * text part at the front of the latest user message. The draft affects only
 * the outgoing model call; stored history and the TUI stay untouched
 * (issue #553).
 */

/**
 * Index of the last user message in a `Message[]` transcript, or -1.
 * The `context` and `compaction` hooks both pass that shape.
 */
export function findLatestUserMessageIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i
  }
  return -1
}

/** Synthetic parts injected by these plugins carry `part.metadata.trellis`. */
function isSyntheticTrellisPart(part) {
  return Boolean(part?.metadata?.trellis)
}

/**
 * Return the first ordinary user-authored text part of a message, skipping
 * synthetic context parts injected by these plugins.
 *
 * Trellis plugins can run in either order, so callers must not mistake an
 * injected context part for the user's prompt.
 */
export function findUserTextPart(message) {
  const content = Array.isArray(message?.content) ? message.content : undefined
  if (!content) return undefined
  return content.find(
    part =>
      part?.type === "text" &&
      !isSyntheticTrellisPart(part) &&
      typeof part.text === "string",
  )
}

/** Text of the latest user message's first ordinary text part ("" when absent). */
export function latestUserPromptText(messages) {
  const index = findLatestUserMessageIndex(messages)
  if (index < 0) return ""
  const part = findUserTextPart(messages[index])
  return typeof part?.text === "string" ? part.text : ""
}

/** True when any assistant message is already in the transcript. */
export function transcriptHasAssistantMessage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(message => message?.role === "assistant")
}

/**
 * Prepend an ephemeral synthetic text part to the latest user message.
 *
 * `kind` namespaces the injection (`sessionStart` / `workflowState`) through
 * `part.metadata.trellis[kind]`, so that:
 *   - each plugin replaces only its own previous part — idempotent when the
 *     draft is reused across tool-driven continuations, and two plugins
 *     injecting into the same message never clobber each other; and
 *   - `findUserTextPart` can skip injected parts when recovering the user's
 *     original prompt.
 *
 * The original message object and its `content` array are left untouched so
 * an injection cannot leak into OpenCode's stored history: the cloned message
 * replaces the array slot.
 */
export function prependEphemeralText(messages, text, kind) {
  if (!Array.isArray(messages)) return false
  if (typeof text !== "string" || !kind) return false
  const index = findLatestUserMessageIndex(messages)
  if (index < 0) return false
  const original = messages[index]
  const content = Array.isArray(original.content) ? original.content.slice() : []
  const existing = content.findIndex(part => part?.metadata?.trellis?.[kind] === true)
  if (existing >= 0) content.splice(existing, 1)
  content.unshift({
    type: "text",
    text,
    metadata: { trellis: { [kind]: true } },
  })
  messages[index] = {
    ...original,
    content,
  }
  return true
}
