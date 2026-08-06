import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect, Either, Schema } from "effect"
import { ClaudeEnvelope, parseClaudeCapture } from "../src/internal/claudeEnvelope.ts"
import { CodexEvent, parseCodexCapture } from "../src/internal/codexEnvelope.ts"
import {
  classifyInbound,
  interpretNotification,
  threadIdFromStartResult
} from "../src/internal/codexProtocol.ts"
import { asToolParams } from "../src/internal/toolkit.ts"

describe("ClaudeEnvelope", () => {
  it("decodes success JSON", () => {
    const decoded = Schema.decodeUnknownSync(Schema.parseJson(ClaudeEnvelope))(JSON.stringify({
      is_error: false,
      result: "pong",
      session_id: "sess-1",
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 10 },
      modelUsage: { "claude-sonnet": { costUSD: 0.01 } },
      extra_cli_field: true
    }))
    assert.equal(decoded.result, "pong")
    assert.equal(decoded.session_id, "sess-1")
    assert.equal(decoded.usage?.input_tokens, 2)
  })

  it("parseClaudeCapture maps envelope → completion", async () => {
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
    assert.equal(result.modelId, "m")
    assert.equal(result.finishReason, "stop")
  })

  it("fails on is_error", async () => {
    const exit = await Effect.runPromiseExit(parseClaudeCapture({
      stdout: JSON.stringify({ is_error: true, result: "rate limited" }),
      stderr: "",
      exitCode: 1
    }))
    assert.equal(exit._tag, "Failure")
  })
})

describe("CodexEvent", () => {
  it("decodes event variants", () => {
    const thread = Schema.decodeUnknownSync(Schema.parseJson(CodexEvent))(
      JSON.stringify({ type: "thread.started", thread_id: "t1" })
    )
    assert.equal(thread.type, "thread.started")
    assert.equal(thread.thread_id, "t1")

    const item = Schema.decodeUnknownSync(Schema.parseJson(CodexEvent))(
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "pong" }
      })
    )
    assert.equal(item.type, "item.completed")
  })

  it("folds JSONL into text", async () => {
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_0", type: "agent_message", text: "pong" }
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 5, output_tokens: 1, cached_input_tokens: 2 }
      })
    ].join("\n")

    const result = await Effect.runPromise(parseCodexCapture({ stdout, stderr: "", exitCode: 0 }))
    assert.equal(result.text, "pong")
    assert.equal(result.id, "t1")
    assert.equal(result.usage?.inputTokens, 5)
    assert.equal(result.usage?.cachedInputTokens, 2)
  })

  it("skips malformed lines", async () => {
    const stdout = [
      "not-json",
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "ok" } })
    ].join("\n")
    const result = await Effect.runPromise(parseCodexCapture({ stdout, stderr: "", exitCode: 0 }))
    assert.equal(result.text, "ok")
  })

  it("rejects null JSON", () => {
    assert.ok(Either.isLeft(Schema.decodeUnknownEither(Schema.parseJson(CodexEvent))("null")))
  })
})

describe("codexProtocol", () => {
  it("classifies rpc response / request / notification", () => {
    assert.equal(
      classifyInbound({ id: 1, result: { ok: true } }).kind,
      "rpc-response"
    )
    assert.equal(
      classifyInbound({ id: 2, method: "item/tool/call", params: { tool: "x" } }).kind,
      "rpc-request"
    )
    assert.equal(
      classifyInbound({ method: "turn/completed", params: { turn: { status: "completed" } } }).kind,
      "notification"
    )
    assert.equal(classifyInbound({ noise: true }).kind, "ignore")
  })

  it("interprets turn notifications into signals", () => {
    assert.deepEqual(
      interpretNotification("item/completed", {
        item: { type: "agentMessage", text: "hi" }
      }),
      { _tag: "SetText", text: "hi" }
    )
    assert.equal(
      interpretNotification("turn/completed", { turn: { status: "failed", error: "boom" } })._tag,
      "Fail"
    )
    assert.equal(
      interpretNotification("turn/completed", {
        turn: {
          status: "completed",
          items: [{ type: "agentMessage", text: "done" }]
        }
      })._tag,
      "Complete"
    )
  })

  it("extracts thread.id from thread/start result", () => {
    assert.equal(threadIdFromStartResult({ thread: { id: "t-1" } }), "t-1")
    assert.equal(threadIdFromStartResult({ thread: {} }), undefined)
    assert.equal(threadIdFromStartResult(null), undefined)
  })
})

describe("asToolParams", () => {
  it("keeps plain objects and rejects arrays/primitives", () => {
    assert.deepEqual(asToolParams({ a: 1 }), { a: 1 })
    assert.deepEqual(asToolParams([1, 2]), {})
    assert.deepEqual(asToolParams("x"), {})
    assert.deepEqual(asToolParams(null), {})
  })
})
