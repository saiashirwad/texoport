import { Effect, Option, Schema } from "effect"
import { ParseError } from "./error.ts"
import { failHere, getPos, matchRegex, peek, seek } from "./state.ts"

export const satisfy = (predicate: (char: string) => boolean, expected: string) =>
  Effect.gen(function* () {
    const char = yield* peek
    if (char === undefined || !predicate(char)) return yield* failHere(expected)
    yield* seek((yield* getPos) + 1)
    return char
  })

export const char = (expected: string) => satisfy((actual) => actual === expected, JSON.stringify(expected))

export const digit = satisfy((char) => char >= "0" && char <= "9", "digit")

export const regex = (regex: RegExp, expected: string) => {
  const normalized = new RegExp(regex.source, regex.flags.replace(/[gy]/g, ""))
  return Effect.gen(function* () {
    const pos = yield* getPos
    const match = yield* matchRegex(normalized)
    if (Option.isNone(match)) return yield* failHere(expected)
    yield* seek(pos + match.value.length)
    return match.value
  })
}

export const endOfInput = Effect.gen(function* () {
  if ((yield* peek) !== undefined) return yield* failHere("end of input")
})

export const or_ = <A, E, R, B, E2, R2>(p: Effect.Effect<A, E, R>, q: Effect.Effect<B, E2, R2>) =>
  Effect.gen(function* () {
    const mark = yield* getPos
    const first = yield* Effect.result(p)
    if (first._tag === "Success") return first.success
    if (!Schema.is(ParseError)(first.failure)) return yield* Effect.fail(first.failure)
    if ((yield* getPos) > mark) return yield* first.failure
    yield* seek(mark)
    const second = yield* Effect.result(q)
    if (second._tag === "Success") return second.success
    if (!Schema.is(ParseError)(second.failure)) return yield* Effect.fail(second.failure)
    return yield* second.failure.pos >= first.failure.pos ? second.failure : first.failure
  })

export const attempt = <A, E, R>(parser: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mark = yield* getPos
    const result = yield* Effect.result(parser)
    if (result._tag === "Success") return result.success
    if (Schema.is(ParseError)(result.failure)) yield* seek(mark)
    return yield* Effect.fail(result.failure)
  })

export const many = <A, E, R>(parser: Effect.Effect<A, E, R>, options?: { atLeast?: number }) =>
  Effect.gen(function* () {
    const values: Array<A> = []
    const atLeast = options?.atLeast ?? 0
    for (let index = 0; index < atLeast; index++) values.push(yield* parser)
    while (true) {
      const mark = yield* getPos
      const result = yield* Effect.result(parser)
      if (result._tag === "Failure") {
        if (!Schema.is(ParseError)(result.failure)) return yield* Effect.fail(result.failure)
        if ((yield* getPos) > mark) return yield* result.failure
        yield* seek(mark)
        return values
      }
      if ((yield* getPos) === mark) {
        return yield* Effect.die(new Error("many: parser succeeded without consuming input"))
      }
      values.push(result.success)
    }
  })
