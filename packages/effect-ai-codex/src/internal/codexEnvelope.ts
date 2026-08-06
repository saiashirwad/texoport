import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import type { AiError } from "effect/unstable/ai"
import { unknownError } from "./errors.ts"
import type { Completion, Usage } from "./response.ts"
import type { SpawnCapture } from "./spawn.ts"

const fail = unknownError("CodexLanguageModel")

class CodexUsage extends Schema.Class<CodexUsage>("CodexUsage")({
  input_tokens: Schema.optional(Schema.Finite),
  output_tokens: Schema.optional(Schema.Finite),
  cached_input_tokens: Schema.optional(Schema.Finite),
  reasoning_output_tokens: Schema.optional(Schema.Finite)
}) {}

class CodexThreadStarted extends Schema.Class<CodexThreadStarted>("CodexThreadStarted")({
  type: Schema.Literal("thread.started"),
  thread_id: Schema.optional(Schema.String)
}) {}

class CodexAgentMessage extends Schema.Class<CodexAgentMessage>("CodexAgentMessage")({
  type: Schema.Literal("agent_message"),
  text: Schema.String,
  id: Schema.optional(Schema.String)
}) {}

class CodexItemCompleted extends Schema.Class<CodexItemCompleted>("CodexItemCompleted")({
  type: Schema.Literal("item.completed"),
  item: Schema.Unknown
}) {}

class CodexTurnCompleted extends Schema.Class<CodexTurnCompleted>("CodexTurnCompleted")({
  type: Schema.Literal("turn.completed"),
  usage: Schema.optional(CodexUsage)
}) {}

class CodexErrorEvent extends Schema.Class<CodexErrorEvent>("CodexErrorEvent")({
  type: Schema.Literal("error"),
  message: Schema.optional(Schema.String)
}) {}

export const CodexEvent = Schema.Union([
  CodexThreadStarted,
  CodexItemCompleted,
  CodexTurnCompleted,
  CodexErrorEvent
])
export type CodexEvent = typeof CodexEvent.Type

const decodeEvent = Schema.decodeUnknownResult(Schema.fromJsonString(CodexEvent))
const decodeAgentMessage = Schema.decodeUnknownResult(CodexAgentMessage)

export const parseCodexCapture = (
  capture: SpawnCapture,
  method = "generateText"
): Effect.Effect<Completion, AiError.AiError> =>
  Effect.gen(function*() {
    let text = ""
    let id: string | undefined
    let usage: Usage | undefined
    let error: string | undefined
    const raw: Array<CodexEvent> = []

    for (const line of capture.stdout.split("\n")) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      const decoded = decodeEvent(trimmed)
      if (Result.isFailure(decoded)) continue
      const event = decoded.success
      raw.push(event)

      switch (event.type) {
        case "thread.started":
          id = event.thread_id
          break
        case "item.completed": {
          const item = decodeAgentMessage(event.item)
          if (Result.isSuccess(item)) text = item.success.text
          break
        }
        case "turn.completed":
          if (event.usage !== undefined) {
            usage = {
              inputTokens: event.usage.input_tokens,
              outputTokens: event.usage.output_tokens,
              cachedInputTokens: event.usage.cached_input_tokens,
              reasoningTokens: event.usage.reasoning_output_tokens
            }
          }
          break
        case "error":
          error = event.message ?? "codex reported an error"
          break
      }
    }

    // Error event fails the turn even if partial text was emitted first.
    if (error !== undefined) {
      return yield* Effect.fail(fail(method, error))
    }

    if (capture.exitCode !== 0) {
      return yield* Effect.fail(
        fail(
          method,
          `codex exited ${capture.exitCode}: ${
            capture.stderr.trim() || capture.stdout.trim() || "(empty)"
          }`
        )
      )
    }

    return {
      text,
      id,
      finishReason: "stop" as const,
      usage,
      providerKey: "codex",
      raw
    }
  })
