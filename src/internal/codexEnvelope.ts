import * as AiError from "@effect/ai/AiError"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import type { Completion, Usage } from "./response.ts"
import type { SpawnCapture } from "./spawn.ts"

const Number_ = Schema.Number.pipe(Schema.finite())

class CodexUsage extends Schema.Class<CodexUsage>("CodexUsage")({
  input_tokens: Schema.optional(Number_),
  output_tokens: Schema.optional(Number_),
  cached_input_tokens: Schema.optional(Number_),
  reasoning_output_tokens: Schema.optional(Number_)
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

export const CodexEvent = Schema.Union(
  CodexThreadStarted,
  CodexItemCompleted,
  CodexTurnCompleted,
  CodexErrorEvent
)
export type CodexEvent = typeof CodexEvent.Type

const decodeEvent = Schema.decodeUnknownEither(Schema.parseJson(CodexEvent))
const decodeAgentMessage = Schema.decodeUnknownEither(CodexAgentMessage)

const lines = (stdout: string): Array<string> =>
  stdout.split("\n").map((line) => line.trim()).filter((line) => line.length > 0)

const usageOf = (u: CodexUsage): Usage => ({
  inputTokens: u.input_tokens,
  outputTokens: u.output_tokens,
  cachedInputTokens: u.cached_input_tokens,
  reasoningTokens: u.reasoning_output_tokens
})

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

    for (const line of lines(capture.stdout)) {
      const decoded = decodeEvent(line)
      if (Either.isLeft(decoded)) continue
      const event = decoded.right
      raw.push(event)

      switch (event.type) {
        case "thread.started":
          id = event.thread_id
          break
        case "item.completed": {
          const item = decodeAgentMessage(event.item)
          if (Either.isRight(item)) text = item.right.text
          break
        }
        case "turn.completed":
          if (event.usage !== undefined) usage = usageOf(event.usage)
          break
        case "error":
          error = event.message ?? "codex reported an error"
          break
      }
    }

    // An error event fails the turn even if partial text was emitted first.
    if (error !== undefined) {
      return yield* new AiError.UnknownError({
        module: "CodexLanguageModel",
        method,
        description: error
      })
    }

    if (capture.exitCode !== 0) {
      return yield* new AiError.UnknownError({
        module: "CodexLanguageModel",
        method,
        description: `codex exited ${capture.exitCode}: ${
          capture.stderr.trim() || capture.stdout.trim() || "(empty)"
        }`
      })
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
