import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Effect, Schema } from "effect"
import {
  anyOfStrings,
  attempt,
  between,
  char,
  count,
  digit,
  endOfInput,
  lookAhead,
  many,
  manyUntil,
  notFollowedBy,
  oneOfChars,
  optional,
  or_,
  parse,
  ParseError,
  regex,
  sepBy,
  string,
  takeUntilChar,
  takeWhileChar1,
} from "../src/index.ts"

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
    assert.equal(
      run("xa", Effect.gen(function* () { yield* char("x"); return yield* regex(/^a/, "a") }))._tag,
      "Success",
    )
    const failed = run("a\nb", Effect.gen(function* () { yield* char("a"); yield* char("\n"); yield* char("c") }))
    assert.equal(failed._tag, "Failure")
    if (failed._tag === "Failure") {
      assert.ok(Schema.is(ParseError)(failed.failure))
      assert.equal(failed.failure.line, 2)
      assert.equal(failed.failure.column, 1)
    }
  })

  it("matches strings and bulk character runs without per-character parser composition", () => {
    const identifier = takeWhileChar1((char) => /[a-z]/.test(char), "identifier")
    const parser = Effect.gen(function* () {
      yield* string("let ")
      const name = yield* identifier
      yield* endOfInput
      return name
    })
    const parsed = run("let alphabet", parser)
    assert.equal(parsed._tag, "Success")
    if (parsed._tag === "Success") assert.equal(parsed.success, "alphabet")
  })

  it("ports parserator's choice, lookahead, repetition, and delimited-list helpers", () => {
    const item = anyOfStrings("false", "true")
    const list = between(char("["), sepBy(item, char(",")), char("]"))
    const parsed = run("[true,false]", list)
    assert.equal(parsed._tag, "Success")
    if (parsed._tag === "Success") assert.deepEqual(parsed.success, ["true", "false"])

    const guarded = Effect.gen(function* () {
      yield* lookAhead(string("ab"))
      yield* char("a")
      yield* notFollowedBy(char("c"), "'c'")
      return yield* count(char("b"), 1)
    })
    assert.equal(run("ab", guarded)._tag, "Success")
    assert.equal(run("ac", guarded)._tag, "Failure")
    assert.equal(run("x", optional(char("a")))._tag, "Success")
  })

  it("scans to a delimiter and parses repeated values through a terminator", () => {
    const field = Effect.gen(function* () {
      const value = yield* takeUntilChar("|")
      yield* char("|")
      return value
    })
    const fieldResult = run("value|rest", field)
    assert.equal(fieldResult._tag, "Success")
    if (fieldResult._tag === "Success") assert.equal(fieldResult.success, "value")
    assert.equal(run("value", field)._tag, "Failure")

    const values = run("1,2,]", manyUntil(digit, char("]")))
    assert.equal(values._tag, "Failure")
    const commaSeparated = manyUntil(
      Effect.gen(function* () {
        const value = yield* digit
        yield* optional(char(","))
        return value
      }),
      char("]"),
    )
    const parsed = run("1,2,]", commaSeparated)
    assert.equal(parsed._tag, "Success")
    if (parsed._tag === "Success") assert.deepEqual(parsed.success, ["1", "2"])
  })

  it("reports invalid combinator arguments as Effect failures instead of throwing", () => {
    const result = run("", oneOfChars(""))
    assert.equal(result._tag, "Failure")
    if (result._tag === "Failure") {
      assert.ok(Schema.is(ParseError)(result.failure))
      assert.equal(result.failure.expected, "oneOfChars requires at least one character")
    }
  })
})
