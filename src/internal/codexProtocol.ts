/**
 * Pure Codex app-server JSON-RPC framing: decode lines, classify messages,
 * interpret turn notifications, and build outbound tool payloads.
 *
 * Keeps the session loop in codexAppServer free of wire-format details.
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { Tool } from "effect/unstable/ai"
import type { Usage } from "./response.ts"
import { encodeToolResultText, toolMetadata } from "./toolkit.ts"

const decodeLine = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const asRecord = Schema.decodeUnknownResult(
  Schema.Record(Schema.String, Schema.Unknown)
)

const AgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  text: Schema.String
})
const decodeAgentMessageItem = Schema.decodeUnknownResult(AgentMessageItem)

const TokenUsageParams = Schema.Struct({
  tokenUsage: Schema.optional(Schema.Struct({
    last: Schema.optional(Schema.NullOr(Schema.Struct({
      inputTokens: Schema.optional(Schema.Number),
      outputTokens: Schema.optional(Schema.Number),
      totalTokens: Schema.optional(Schema.Number),
      reasoningOutputTokens: Schema.optional(Schema.Number),
      cachedInputTokens: Schema.optional(Schema.Number)
    })))
  }))
})
const decodeTokenUsageParams = Schema.decodeUnknownResult(TokenUsageParams)

const TurnCompletedParams = Schema.Struct({
  turn: Schema.optional(Schema.Struct({
    status: Schema.String,
    error: Schema.optional(Schema.Unknown),
    items: Schema.optional(Schema.Array(Schema.Unknown))
  }))
})
const decodeTurnCompletedParams = Schema.decodeUnknownResult(TurnCompletedParams)

const asRpcId = (value: unknown): string | number | undefined =>
  typeof value === "string" || typeof value === "number" ? value : undefined

const asParams = (value: unknown): Record<string, unknown> => {
  const decoded = asRecord(value)
  return Result.isSuccess(decoded) ? decoded.success : {}
}

export type Inbound =
  | { readonly kind: "rpc-response"; readonly id: string | number; readonly error?: unknown; readonly result?: unknown }
  | { readonly kind: "rpc-request"; readonly id: string | number; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: "notification"; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: "ignore" }

/** Classify one decoded app-server message. */
export const classifyInbound = (msg: Record<string, unknown>): Inbound => {
  const hasId = "id" in msg
  const hasMethod = "method" in msg
  const isResponse = hasId && ("result" in msg || "error" in msg) && !hasMethod
  const id = asRpcId(msg["id"])

  if (isResponse) {
    if (id === undefined) return { kind: "ignore" }
    return {
      kind: "rpc-response",
      id,
      ...("error" in msg ? { error: msg["error"] } : { result: msg["result"] })
    }
  }

  const params = asParams(msg["params"])
  const method = typeof msg["method"] === "string" ? msg["method"] : ""

  if (hasMethod && hasId) {
    if (id === undefined) return { kind: "ignore" }
    return { kind: "rpc-request", id, method, params }
  }

  if (hasMethod) {
    return { kind: "notification", method, params }
  }

  return { kind: "ignore" }
}

/** Parse one stdout line into a record, or ignore blank/malformed lines. */
export const decodeInboundLine = (line: string): Inbound | undefined => {
  if (line.trim().length === 0) return undefined
  const decoded = decodeLine(line)
  if (Result.isFailure(decoded)) return undefined
  const rec = asRecord(decoded.success)
  if (Result.isFailure(rec)) return undefined
  return classifyInbound(rec.success)
}

/** Decode an arbitrary value as a string-keyed record. */
export const decodeRecord = (value: unknown): Record<string, unknown> | undefined => {
  const rec = asRecord(value)
  return Result.isSuccess(rec) ? rec.success : undefined
}

export const threadIdFromStartResult = (threadResult: unknown): string | undefined => {
  const root = decodeRecord(threadResult)
  if (root === undefined) return undefined
  const thread = decodeRecord(root["thread"])
  const id = thread?.["id"]
  return typeof id === "string" ? id : undefined
}

export type TurnSignal =
  | { readonly _tag: "SetText"; readonly text: string }
  | { readonly _tag: "SetUsage"; readonly usage: Usage }
  | { readonly _tag: "Complete"; readonly text?: string | undefined }
  | { readonly _tag: "Fail"; readonly message: string }
  | { readonly _tag: "Ignore" }

const usageFromLast = (last: {
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly totalTokens?: number | undefined
  readonly reasoningOutputTokens?: number | undefined
  readonly cachedInputTokens?: number | undefined
}): Usage => ({
  inputTokens: last.inputTokens,
  outputTokens: last.outputTokens,
  totalTokens: last.totalTokens,
  reasoningTokens: last.reasoningOutputTokens,
  cachedInputTokens: last.cachedInputTokens
})

const lastAgentText = (items: ReadonlyArray<unknown> | undefined): string | undefined => {
  let text: string | undefined
  for (const it of items ?? []) {
    const item = decodeAgentMessageItem(it)
    if (Result.isSuccess(item)) text = item.success.text
  }
  return text
}

/** Pure interpretation of app-server notifications into turn-state signals. */
export const interpretNotification = (
  method: string,
  params: Record<string, unknown>
): TurnSignal => {
  switch (method) {
    case "item/completed": {
      const item = decodeAgentMessageItem(params["item"])
      return Result.isSuccess(item)
        ? { _tag: "SetText", text: item.success.text }
        : { _tag: "Ignore" }
    }
    case "thread/tokenUsage/updated": {
      const parsed = decodeTokenUsageParams(params)
      const last = Result.isSuccess(parsed) ? parsed.success.tokenUsage?.last : undefined
      return last != null
        ? { _tag: "SetUsage", usage: usageFromLast(last) }
        : { _tag: "Ignore" }
    }
    case "turn/completed": {
      const parsed = decodeTurnCompletedParams(params)
      const turn = Result.isSuccess(parsed) ? parsed.success.turn : undefined
      if (turn?.status === "failed") {
        return { _tag: "Fail", message: `codex turn failed: ${JSON.stringify(turn.error)}` }
      }
      const text = lastAgentText(turn?.items)
      return text !== undefined
        ? { _tag: "Complete", text }
        : { _tag: "Complete" }
    }
    case "error":
      return {
        _tag: "Fail",
        message: `codex app-server error notification: ${JSON.stringify(params)}`
      }
    default:
      return { _tag: "Ignore" }
  }
}

export const toDynamicTools = (tools: ReadonlyArray<Tool.Any>) =>
  tools.map((tool) => ({ type: "function" as const, ...toolMetadata(tool) }))

export const toolCallReply = (isFailure: boolean, result: unknown) => ({
  success: !isFailure,
  contentItems: [{ type: "inputText", text: encodeToolResultText(result) }]
})

export const encodeOutbound = (payload: unknown): Uint8Array =>
  new TextEncoder().encode(`${JSON.stringify(payload)}\n`)
