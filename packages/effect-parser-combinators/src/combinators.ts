import { Effect, Option, Schema } from "effect"
import { ParseError, UpstreamError } from "./error.ts"
import { failHere, getPos, matchRegex, ParseState, peek, seek, startsWith, takeUntil, takeWhile } from "./state.ts"

const invalidConfiguration = (message: string) =>
  Effect.fail(new ParseError({ pos: 0, expected: message, found: undefined }))

export const satisfy = (predicate: (char: string) => boolean, expected: string) =>
  Effect.flatMap(peek, (char) =>
    char === undefined || !predicate(char)
      ? failHere(expected)
      : Effect.flatMap(getPos, (pos) => Effect.as(seek(pos + 1), char)),
  )

export const char = (expected: string) => satisfy((actual) => actual === expected, JSON.stringify(expected))

export const digit = satisfy((char) => char >= "0" && char <= "9", "digit")

export const alphabet = satisfy(
  (char) => (char >= "a" && char <= "z") || (char >= "A" && char <= "Z"),
  "letter",
)

export const anyChar = satisfy(() => true, "any character")

export const notChar = (excluded: string) => {
  if (excluded.length !== 1) {
    return invalidConfiguration("notChar expects a single character")
  }
  return satisfy((actual) => actual !== excluded, `any character except ${JSON.stringify(excluded)}`)
}

export const oneOfChars = (chars: string) => {
  if (chars.length === 0) {
    return invalidConfiguration("oneOfChars requires at least one character")
  }
  return satisfy((actual) => chars.includes(actual), `one of ${JSON.stringify(chars)}`)
}

/** Match an exact string in one state transition, including across stream chunks. */
export const string = <const T extends string>(expected: T) =>
  Effect.flatMap(startsWith(expected), (matches) =>
    matches
      ? Effect.flatMap(getPos, (pos) => Effect.as(seek(pos + expected.length), expected))
      : failHere(JSON.stringify(expected)),
  )

/** Match the longest candidate at the current input position. */
export const anyOfStrings = <const T extends ReadonlyArray<string>>(...candidates: T) => {
  if (candidates.length === 0) {
    return invalidConfiguration("anyOfStrings requires at least one candidate")
  }
  const longestFirst = [...candidates].sort((a, b) => b.length - a.length)
  const expected = `one of ${candidates.map((candidate) => JSON.stringify(candidate)).join(", ")}`
  const loop = (index: number): Effect.Effect<T[number], ParseError | UpstreamError, ParseState> => {
    const candidate = longestFirst[index]
    if (candidate === undefined) return failHere(expected)
    return Effect.flatMap(startsWith(candidate), (matches) =>
      matches
        ? Effect.flatMap(getPos, (pos) => Effect.as(seek(pos + candidate.length), candidate as T[number]))
        : loop(index + 1),
    )
  }
  return Effect.suspend(() => loop(0))
}

/** Consume the longest prefix for which `predicate` holds. */
export const takeWhileChar = (predicate: (char: string) => boolean) => takeWhile(predicate)

/** Like `takeWhileChar`, but require at least one character. */
export const takeWhileChar1 = (predicate: (char: string) => boolean, expected: string) =>
  Effect.flatMap(takeWhile(predicate), (value) => value.length === 0 ? failHere(expected) : Effect.succeed(value))

/**
 * Consume input up to, but not including, `delimiter`. The delimiter is left
 * unread so callers can parse it separately. Fails after consuming the
 * remainder when the delimiter is absent.
 */
export const takeUntilChar = (delimiter: string) => {
  if (delimiter.length !== 1) {
    return invalidConfiguration("takeUntilChar expects a single character")
  }
  return Effect.flatMap(takeUntil(delimiter), (value) =>
    Option.isSome(value) ? Effect.succeed(value.value) : failHere(JSON.stringify(delimiter)),
  )
}

export const whitespace = oneOfChars(" \t\n\r")
export const skipWhitespace = Effect.as(takeWhileChar((char) => " \t\n\r".includes(char)), undefined)

export const regex = (regex: RegExp, expected: string) => {
  const normalized = new RegExp(regex.source, `${regex.flags.replace(/[gy]/g, "")}y`)
  return Effect.flatMap(getPos, (pos) =>
    Effect.flatMap(matchRegex(normalized), (match) =>
      Option.isNone(match)
        ? failHere(expected)
        : Effect.as(seek(pos + match.value.length), match.value),
    ),
  )
}

export const endOfInput = Effect.flatMap(peek, (char) =>
  char === undefined ? Effect.void : failHere("end of input"),
)

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
  Effect.flatMap(getPos, (mark) =>
    Effect.flatMap(Effect.result(parser), (result) => {
      if (result._tag === "Success") return Effect.succeed(result.success)
      return Schema.is(ParseError)(result.failure)
        ? Effect.andThen(seek(mark), () => Effect.fail(result.failure))
        : Effect.fail(result.failure)
    }),
  )

/** Run a parser without consuming input when it succeeds. */
export const lookAhead = <A, E, R>(parser: Effect.Effect<A, E, R>) =>
  Effect.flatMap(getPos, (mark) =>
    Effect.flatMap(Effect.result(parser), (result) =>
      Effect.andThen(seek(mark), () => result._tag === "Success" ? Effect.succeed(result.success) : Effect.fail(result.failure)),
    ),
  )

/** Succeed when `parser` does not match at the current position. */
export const notFollowedBy = <A, E, R>(parser: Effect.Effect<A, E, R>, expected = "input not to match") =>
  Effect.gen(function* () {
    const mark = yield* getPos
    const result = yield* Effect.result(parser)
    yield* seek(mark)
    if (result._tag === "Success") return yield* failHere(expected)
    if (!Schema.is(ParseError)(result.failure)) return yield* Effect.fail(result.failure)
  })

/** Try a parser and return `undefined` when it fails without consuming input. */
export const optional = <A, E, R>(parser: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const mark = yield* getPos
    const result = yield* Effect.result(parser)
    if (result._tag === "Success") return result.success as A | undefined
    if (!Schema.is(ParseError)(result.failure)) return yield* Effect.fail(result.failure)
    if ((yield* getPos) > mark) return yield* result.failure
    yield* seek(mark)
    return undefined
  })

export const many = <A, E, R>(parser: Effect.Effect<A, E, R>, options?: { atLeast?: number }) =>
  Effect.suspend(() => {
    const atLeast = options?.atLeast ?? 0
    return Effect.flatMap(Effect.forEach(Array.from({ length: atLeast }), () => parser), (values) => {
      let complete = false
      let failed = false
      let failure: unknown
      const loop = Effect.whileLoop({
        while: () => !complete,
        body: () =>
          Effect.flatMap(getPos, (mark) =>
            Effect.flatMap(Effect.result(parser), (result) => {
              if (result._tag === "Success") {
                return Effect.flatMap(getPos, (pos) => {
                  if (pos === mark) {
                    return failHere("many: parser must consume input")
                  }
                  values.push(result.success)
                  return Effect.void
                })
              }
              if (!Schema.is(ParseError)(result.failure)) {
                failed = true
                failure = result.failure
                complete = true
                return Effect.void
              }
              return Effect.flatMap(getPos, (pos) => {
                if (pos > mark) {
                  failed = true
                  failure = result.failure
                  complete = true
                  return Effect.void
                }
                complete = true
                return seek(mark)
              })
            }),
          ),
        step: () => undefined,
      })
      return Effect.andThen(loop, () => failed ? Effect.fail(failure) : Effect.succeed(values))
    })
  })

/** Parse elements until `terminator` succeeds, consuming the terminator. */
export const manyUntil = <A, E, R, B, E2, R2>(
  element: Effect.Effect<A, E, R>,
  terminator: Effect.Effect<B, E2, R2>,
) =>
  Effect.gen(function* () {
    const values: Array<A> = []
    while (true) {
      const mark = yield* getPos
      const end = yield* Effect.result(terminator)
      if (end._tag === "Success") return values
      if (!Schema.is(ParseError)(end.failure)) return yield* Effect.fail(end.failure)
      if ((yield* getPos) > mark) return yield* end.failure
      yield* seek(mark)

      const value = yield* element
      if ((yield* getPos) === mark) {
        return yield* failHere("manyUntil: element parser must consume input")
      }
      values.push(value)
    }
  })

export const count = <A, E, R>(parser: Effect.Effect<A, E, R>, n: number) =>
  !Number.isSafeInteger(n) || n < 0
    ? invalidConfiguration("count: n must be a non-negative integer")
    : Effect.forEach(Array.from({ length: n }), () => parser)

export const between = <A, E, R, B, E2, R2, C, E3, R3>(
  open: Effect.Effect<A, E, R>,
  parser: Effect.Effect<B, E2, R2>,
  close: Effect.Effect<C, E3, R3>,
) =>
  Effect.gen(function* () {
    yield* open
    const value = yield* parser
    yield* close
    return value
  })

export const sepBy1 = <A, E, R, S, E2, R2>(
  parser: Effect.Effect<A, E, R>,
  separator: Effect.Effect<S, E2, R2>,
) =>
  Effect.gen(function* () {
    const values = [yield* parser]
    while (true) {
      const mark = yield* getPos
      const separatorResult = yield* Effect.result(separator)
      if (separatorResult._tag === "Failure") {
        if (!Schema.is(ParseError)(separatorResult.failure)) return yield* Effect.fail(separatorResult.failure)
        if ((yield* getPos) > mark) return yield* separatorResult.failure
        yield* seek(mark)
        return values
      }
      values.push(yield* parser)
    }
  })

export const sepBy = <A, E, R, S, E2, R2>(
  parser: Effect.Effect<A, E, R>,
  separator: Effect.Effect<S, E2, R2>,
) =>
  Effect.gen(function* () {
    const firstMark = yield* getPos
    const firstResult = yield* Effect.result(parser)
    if (firstResult._tag === "Failure") {
      if (!Schema.is(ParseError)(firstResult.failure)) return yield* Effect.fail(firstResult.failure)
      if ((yield* getPos) > firstMark) return yield* firstResult.failure
      yield* seek(firstMark)
      return [] as Array<A>
    }
    const values: Array<A> = [firstResult.success]
    while (true) {
      const mark = yield* getPos
      const separatorResult = yield* Effect.result(separator)
      if (separatorResult._tag === "Failure") {
        if (!Schema.is(ParseError)(separatorResult.failure)) return yield* Effect.fail(separatorResult.failure)
        if ((yield* getPos) > mark) return yield* separatorResult.failure
        yield* seek(mark)
        return values
      }
      values.push((yield* parser) as A)
    }
  })
