import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect, Stream } from "effect"
import { toParts, toStreamParts } from "../src/internal/response.ts"
import { hoistRootRef } from "../src/internal/schema.ts"

describe("toParts", () => {
  it("emits text + finish", () => {
    const parts = toParts({
      text: "pong",
      modelId: "claude-test",
      id: "sess-1",
      usage: { inputTokens: 1, outputTokens: 2 }
    })
    assert.equal(parts[0]?.type, "response-metadata")
    assert.equal(parts[1]?.type, "text")
    assert.equal(parts[1]?.type === "text" ? parts[1].text : "", "pong")
    assert.equal(parts[2]?.type, "finish")
    if (parts[2]?.type === "finish") {
      assert.equal(parts[2].usage.inputTokens?.total, 1)
      assert.equal(parts[2].usage.outputTokens?.total, 2)
    }
  })
})

describe("toStreamParts", () => {
  it("emits start/delta/end/finish", async () => {
    const parts = await Effect.runPromise(
      Stream.runCollect(toStreamParts({ text: "hi", id: "1" }))
    )
    assert.deepEqual(
      parts.map((p) => p.type),
      ["response-metadata", "text-start", "text-delta", "text-end", "finish"]
    )
  })
})

describe("hoistRootRef", () => {
  it("inlines a bare root $ref", () => {
    const hoisted = hoistRootRef({
      $ref: "#/$defs/Person",
      $defs: {
        Person: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"]
        }
      }
    }) as Record<string, unknown>
    assert.equal(hoisted["type"], "object")
    assert.ok(hoisted["$defs"])
    assert.equal(hoisted["$ref"], undefined)
  })

  it("leaves already-typed roots alone", () => {
    const root = { type: "object", properties: {} }
    assert.deepEqual(hoistRootRef(root), root)
  })
})
