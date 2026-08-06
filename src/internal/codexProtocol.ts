import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { Tool } from "effect/unstable/ai"
import type { Usage } from "./response.ts"
import { encodeToolResultText, toolMetadata } from "./toolkit.ts"

const decodeLine = Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Unknown))
const asRecord = Schema.decodeUnknownResult(Schema.Record(Schema.String, Schema.Unknown))

const decodeAgentMessageItem = Schema.decodeUnknownResult(Schema.Struct({
  type: Schema.Literal("agentMessage"),
  text: Schema.String
}))

const decodeTokenUsageParams = Schema.decodeUnknownResult(Schema.Struct({
  tokenUsage: Schema.optional(Schema.Struct({
    last: Schema.optional(Schema.NullOr(Schema.Struct({
      inputTokens: Schema.optional(Schema.Number),
      outputTokens: Schema.optional(Schema.Number),
      totalTokens: Schema.optional(Schema.Number),
      reasoningOutputTokens: Schema.optional(Schema.Number),
      cachedInputTokens: Schema.optional(Schema.Number)
    })))
  }))
}))

const decodeTurnCompletedParams = Schema.decodeUnknownResult(Schema.Struct({
  turn: Schema.optional(Schema.Struct({
    status: Schema.String,
    error: Schema.optional(Schema.Unknown),
    items: Schema.optional(Schema.Array(Schema.Unknown))
  }))
}))

export type Inbound =
  | { readonly kind: "rpc-response"; readonly id: string | number; readonly error?: unknown; readonly result?: unknown }
  | { readonly kind: "rpc-request"; readonly id: string | number; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: "notification"; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: "ignore" }

export const classifyInbound = (msg: Record<string, unknown>): Inbound => {
  const hasId = "id" in msg
  const hasMethod = "method" in msg
  const id = typeof msg["id"] === "string" || typeof msg["id"] === "number" ? msg["id"] : undefined

  if (hasId && ("result" in msg || "error" in msg) && !hasMethod) {
    if (id === undefined) return { kind: "ignore" }
    return {
      kind: "rpc-response",
      id,
      ...("error" in msg ? { error: msg["error"] } : { result: msg["result"] })
    }
  }

  const paramsResult = asRecord(msg["params"])
  const params = Result.isSuccess(paramsResult) ? paramsResult.success : {}
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

export const decodeInboundLine = (line: string): Inbound | undefined => {
  if (line.trim().length === 0) return undefined
  const decoded = decodeLine(line)
  if (Result.isFailure(decoded)) return undefined
  const rec = asRecord(decoded.success)
  if (Result.isFailure(rec)) return undefined
  return classifyInbound(rec.success)
}

export const decodeRecord = (value: unknown): Record<string, unknown> | undefined => {
  const rec = asRecord(value)
  return Result.isSuccess(rec) ? rec.success : undefined
}

export const threadIdFromStartResult = (threadResult: unknown): string | undefined => {
  const root = decodeRecord(threadResult)
  if (root === undefined) return undefined
  const id = decodeRecord(root["thread"])?.["id"]
  return typeof id === "string" ? id : undefined
}

export type TurnSignal =
  | { readonly _tag: "SetText"; readonly text: string }
  | { readonly _tag: "SetUsage"; readonly usage: Usage }
  | { readonly _tag: "Complete"; readonly text?: string | undefined }
  | { readonly _tag: "Fail"; readonly message: string }
  | { readonly _tag: "Ignore" }

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
      if (last == null) return { _tag: "Ignore" }
      return {
        _tag: "SetUsage",
        usage: {
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
          totalTokens: last.totalTokens,
          reasoningTokens: last.reasoningOutputTokens,
          cachedInputTokens: last.cachedInputTokens
        }
      }
    }
    case "turn/completed": {
      const parsed = decodeTurnCompletedParams(params)
      const turn = Result.isSuccess(parsed) ? parsed.success.turn : undefined
      if (turn?.status === "failed") {
        return { _tag: "Fail", message: `codex turn failed: ${JSON.stringify(turn.error)}` }
      }
      let text: string | undefined
      for (const it of turn?.items ?? []) {
        const item = decodeAgentMessageItem(it)
        if (Result.isSuccess(item)) text = item.success.text
      }
      return text !== undefined ? { _tag: "Complete", text } : { _tag: "Complete" }
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
