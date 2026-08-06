import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { AiError, type Response } from "effect/unstable/ai"
import { malformedOutput, unknownError } from "./errors.ts"
import type { Completion } from "./response.ts"
import type { SpawnCapture } from "./spawn.ts"

const fail = unknownError("ClaudeLanguageModel")
const badOutput = malformedOutput("ClaudeLanguageModel")

class ClaudeUsage extends Schema.Class<ClaudeUsage>("ClaudeUsage")({
  input_tokens: Schema.optional(Schema.Finite),
  output_tokens: Schema.optional(Schema.Finite),
  cache_read_input_tokens: Schema.optional(Schema.Finite)
}) {}

export class ClaudeEnvelope extends Schema.Class<ClaudeEnvelope>("ClaudeEnvelope")({
  is_error: Schema.optional(Schema.Boolean),
  result: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
  session_id: Schema.optional(Schema.String),
  stop_reason: Schema.optional(Schema.String),
  usage: Schema.optional(ClaudeUsage),
  modelUsage: Schema.optional(Schema.Record(Schema.String, Schema.Unknown))
}) {}

const decodeEnvelope = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeEnvelope))

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

const exitDescription = (capture: SpawnCapture, fallback: string | null | undefined) =>
  `claude exited ${capture.exitCode}: ${
    capture.stderr.trim() || fallback || capture.stdout.trim() || "(empty)"
  }`

export const parseClaudeCapture = (
  capture: SpawnCapture,
  method = "generateText"
): Effect.Effect<Completion, AiError.AiError> =>
  Effect.gen(function*() {
    const envelope = yield* decodeEnvelope(capture.stdout).pipe(
      Effect.mapError((cause) =>
        capture.exitCode !== 0
          ? fail(method, exitDescription(capture, null), cause)
          : badOutput(method, "invalid claude JSON envelope", cause)
      )
    )

    // Non-zero exit fails even when the JSON envelope parses cleanly.
    if (capture.exitCode !== 0) {
      return yield* Effect.fail(fail(method, exitDescription(capture, envelope.result)))
    }

    if (envelope.is_error === true) {
      return yield* Effect.fail(fail(method, envelope.result ?? "claude reported an error"))
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
