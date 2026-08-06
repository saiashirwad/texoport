import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect, Schema } from "effect"
import { ClaudeEnvelope, parseClaudeCapture } from "../src/internal/claudeEnvelope.ts"

describe("ClaudeEnvelope", () => {
  it("decodes success JSON", () => {
    const decoded = Schema.decodeUnknownSync(Schema.fromJsonString(ClaudeEnvelope))(JSON.stringify({
      is_error: false,
      result: "pong",
      session_id: "sess-1",
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 10 },
      modelUsage: { "claude-sonnet": { costUSD: 0.01 } }
    }))
    assert.equal(decoded.result, "pong")
    assert.equal(decoded.session_id, "sess-1")
  })

  it("maps a CLI response to a completion", async () => {
    const result = await Effect.runPromise(parseClaudeCapture({
      stdout: JSON.stringify({
        is_error: false,
        result: "hi",
        session_id: "s",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: { m: {} }
      }),
      stderr: "",
      exitCode: 0
    }))
    assert.equal(result.text, "hi")
    assert.equal(result.finishReason, "stop")
  })
})
