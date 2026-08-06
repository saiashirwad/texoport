import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect, Schema } from "effect"
import { attempt, char, digit, endOfInput, many, or_, parse, ParseError, regex } from "../src/index.ts"

const run = <A, E>(input: string, parser: Effect.Effect<A, E, any>) => Effect.runSync(parse(input, parser))

describe("parser combinators", () => {
  it("parses the documented IP address parser", () => {
    class OutOfRange extends Schema.TaggedError<OutOfRange>()("OutOfRange", {
      n: Schema.Finite,
    }) {}

    const byte = Effect.gen(function* () {
      const digits = yield* many(digit, { atLeast: 1 })
      const n = Number(digits.join(""))
      if (n > 255) return yield* new OutOfRange({ n })
      return n
    })
    const ip = Effect.gen(function* () {
      const a = yield* byte
      yield* char(".")
      const b = yield* byte
      yield* char(".")
      const c = yield* byte
      yield* char(".")
      const d = yield* byte
      yield* endOfInput
      return [a, b, c, d] as const
    })

    const parsed = run("192.168.1.1", ip)
    assert.equal(parsed._tag, "Success")
    if (parsed._tag === "Success") assert.deepEqual(parsed.success, [192, 168, 1, 1])
    const outOfRange = run("192.168.256.1", ip)
    assert.equal(outOfRange._tag, "Failure")
  })

  it("commits ordered choice after consumption, unless attempt rewinds", () => {
    const ab = Effect.gen(function* () { yield* char("a"); yield* char("b"); return "ab" as const })
    const ac = Effect.gen(function* () { yield* char("a"); yield* char("c"); return "ac" as const })
    const committed = run("ac", or_(ab, ac))
    assert.equal(committed._tag, "Failure")
    assert.equal(run("ac", or_(attempt(ab), ac))._tag, "Success")
  })

  it("normalizes global regular expressions and reports locations", () => {
    const shared = /\d/g
    const parser = Effect.gen(function* () { yield* regex(shared, "digit"); return yield* regex(shared, "digit") })
    const parsed = run("12", parser)
    assert.equal(parsed._tag, "Success")
    if (parsed._tag === "Success") assert.equal(parsed.success, "2")
    const failed = run("a\nb", Effect.gen(function* () { yield* char("a"); yield* char("\n"); yield* char("c") }))
    assert.equal(failed._tag, "Failure")
    if (failed._tag === "Failure") {
      assert.ok(Schema.is(ParseError)(failed.failure))
      assert.equal(failed.failure.line, 2)
      assert.equal(failed.failure.column, 1)
    }
  })
})
