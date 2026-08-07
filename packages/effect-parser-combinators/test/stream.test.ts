import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect, Schema, Stream } from "effect"
import { char, digit, endOfInput, many, parseStream, streamElements, string, takeUntilChar, takeWhileChar1, UpstreamError } from "../src/index.ts"

describe("streaming parser combinators", () => {
  it("parses continuously across chunk boundaries", () => {
    const hello = Effect.gen(function* () {
      for (const charToRead of "hello") yield* char(charToRead)
      yield* endOfInput
      return "hello" as const
    })
    assert.equal(Effect.runSync(parseStream(Stream.fromIterable(["he", "llo"]), hello)), "hello")
  })

  it("uses bulk string and character-run parsers across chunk boundaries", () => {
    const parser = Effect.gen(function* () {
      yield* string("header:")
      const value = yield* takeWhileChar1((char) => char >= "0" && char <= "9", "digit")
      yield* endOfInput
      return value
    })
    assert.equal(Effect.runSync(parseStream(Stream.fromIterable(["hea", "der:12", "34"]), parser)), "1234")
  })

  it("scans to a delimiter across chunk boundaries", () => {
    const parser = Effect.gen(function* () {
      const value = yield* takeUntilChar("\n")
      yield* char("\n")
      return value
    })
    assert.equal(Effect.runSync(parseStream(Stream.fromIterable(["first", " line\nrest"]), parser)), "first line")
  })

  it("emits elements while releasing consumed input", () => {
    const numberLine = Effect.gen(function* () {
      const digits = yield* many(digit, { atLeast: 1 })
      yield* char("\n")
      return Number(digits.join(""))
    })
    const values = Effect.runSync(
      streamElements(Stream.fromIterable(["1\n2", "\n3\n"]), numberLine).pipe(Stream.runCollect),
    )
    assert.deepEqual([...values], [1, 2, 3])
  })

  it("wraps upstream failures", () => {
    const result = Effect.runSync(Effect.result(parseStream(Stream.fail("upstream-broke"), char("a"))))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") assert.ok(Schema.is(UpstreamError)(result.failure))
  })
})
