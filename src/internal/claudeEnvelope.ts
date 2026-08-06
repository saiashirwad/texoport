import * as AiError from "@effect/ai/AiError"
import type * as Response from "@effect/ai/Response"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { Completion } from "./response.ts"
import type { SpawnCapture } from "./spawn.ts"

const Number_ = Schema.Number.pipe(Schema.finite())

class ClaudeUsage extends Schema.Class<ClaudeUsage>("ClaudeUsage")({
  input_tokens: Schema.optional(Number_),
  output_tokens: Schema.optional(Number_),
  cache_read_input_tokens: Schema.optional(Number_)
}) {}

export class ClaudeEnvelope extends Schema.Class<ClaudeEnvelope>("ClaudeEnvelope")({
  is_error: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  result: Schema.optional(Schema.Union(Schema.String, Schema.Null)),
  session_id: Schema.optional(Schema.String),
  stop_reason: Schema.optional(Schema.String),
  usage: Schema.optional(ClaudeUsage),
  modelUsage: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown }))
}) {}

const decodeEnvelope = Schema.decodeUnknown(Schema.parseJson(ClaudeEnvelope))

const finishReason = (reason: string | undefined): Response.FinishReason => {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop"
    case "max_tokens":
      return "length"
    case "tool_use":
      return "tool-calls"
    default:
      return "unknown"
  }
}

export const parseClaudeCapture = (
  capture: SpawnCapture,
  method = "generateText"
): Effect.Effect<Completion, AiError.AiError> =>
  Effect.gen(function*() {
    const envelope = yield* decodeEnvelope(capture.stdout).pipe(
      Effect.mapError((cause) =>
        capture.exitCode !== 0
          ? new AiError.UnknownError({
            module: "ClaudeLanguageModel",
            method,
            description: `claude exited ${capture.exitCode}: ${
              capture.stderr.trim() || capture.stdout.trim() || "(empty)"
            }`,
            cause
          })
          : new AiError.MalformedOutput({
            module: "ClaudeLanguageModel",
            method,
            description: "invalid claude JSON envelope",
            cause
          })
      )
    )

    // A non-zero exit is a failure even when the JSON envelope parses cleanly.
    if (capture.exitCode !== 0) {
      return yield* new AiError.UnknownError({
        module: "ClaudeLanguageModel",
        method,
        description: `claude exited ${capture.exitCode}: ${
          capture.stderr.trim() || envelope.result || "(empty)"
        }`
      })
    }

    if (envelope.is_error) {
      return yield* new AiError.UnknownError({
        module: "ClaudeLanguageModel",
        method,
        description: envelope.result ?? "claude reported an error"
      })
    }

    return {
      text: envelope.result ?? "",
      id: envelope.session_id,
      modelId: envelope.modelUsage !== undefined ? Object.keys(envelope.modelUsage)[0] : undefined,
      finishReason: finishReason(envelope.stop_reason),
      usage: envelope.usage === undefined
        ? undefined
        : {
          inputTokens: envelope.usage.input_tokens,
          outputTokens: envelope.usage.output_tokens,
          cachedInputTokens: envelope.usage.cache_read_input_tokens
        },
      providerKey: "claude",
      raw: envelope
    }
  })
