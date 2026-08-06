import { Context, Effect, Option, Pull, Ref } from "effect"
import { ParseError, UpstreamError } from "./error.ts"

export interface ParseStateShape {
  readonly buffer: Ref.Ref<string>
  readonly pos: Ref.Ref<number>
  readonly base: Ref.Ref<number>
  readonly fill: Effect.Effect<void, UpstreamError>
  readonly done: Ref.Ref<boolean>
}

export class ParseState extends Context.Service<ParseState, ParseStateShape>()("ParseState") {}

export const makeStringState = (input: string): Effect.Effect<ParseStateShape> =>
  Effect.all({
    buffer: Ref.make(input),
    pos: Ref.make(0),
    base: Ref.make(0),
    fill: Effect.succeed(Effect.void),
    done: Ref.make(true),
  })

export const makeStreamState = <E>(
  pull: Pull.Pull<ReadonlyArray<string>, E>,
): Effect.Effect<ParseStateShape> =>
  Effect.gen(function* () {
    const buffer = yield* Ref.make("")
    const done = yield* Ref.make(false)
    const next = pull.pipe(
      Pull.catchDone(() => Effect.succeed(undefined)),
      Effect.mapError((cause) => new UpstreamError({ cause })),
    )
    const fill: Effect.Effect<void, UpstreamError> = Effect.gen(function* () {
      if (yield* Ref.get(done)) return
      const chunk = yield* next
      if (chunk === undefined) yield* Ref.set(done, true)
      else yield* Ref.update(buffer, (current) => current + chunk.join(""))
    })
    return { buffer, pos: yield* Ref.make(0), base: yield* Ref.make(0), fill, done }
  })

export const getPos = Effect.flatMap(ParseState, ({ pos }) => Ref.get(pos))

export const seek = (pos: number) =>
  Effect.gen(function* () {
    const { pos: cursor, base } = yield* ParseState
    if (pos < (yield* Ref.get(base))) {
      return yield* Effect.die(new Error(`cannot rewind to position ${pos}: input before it was released`))
    }
    yield* Ref.set(cursor, pos)
  })

const remaining = Effect.gen(function* () {
  const { buffer, pos, base } = yield* ParseState
  return (yield* Ref.get(buffer)).slice((yield* Ref.get(pos)) - (yield* Ref.get(base)))
})

export const peek: Effect.Effect<string | undefined, UpstreamError, ParseState> = Effect.gen(
  function* () {
    const { fill, done } = yield* ParseState
    let rest = yield* remaining
    while (rest.length === 0 && !(yield* Ref.get(done))) {
      yield* fill
      rest = yield* remaining
    }
    return rest[0]
  },
)

export const isEof: Effect.Effect<boolean, UpstreamError, ParseState> = Effect.map(
  peek,
  (char) => char === undefined,
)

export const startsWith = (text: string): Effect.Effect<boolean, UpstreamError, ParseState> =>
  Effect.gen(function* () {
    const { fill, done } = yield* ParseState
    while (true) {
      const rest = yield* remaining
      if (rest.length >= text.length) return rest.startsWith(text)
      if (!text.startsWith(rest)) return false
      if (yield* Ref.get(done)) return false
      yield* fill
    }
  })

export const matchRegex = (
  regex: RegExp,
): Effect.Effect<Option.Option<string>, UpstreamError, ParseState> =>
  Effect.gen(function* () {
    const { fill, done } = yield* ParseState
    while (true) {
      const rest = yield* remaining
      regex.lastIndex = 0
      const match = regex.exec(rest)
      const matched = match !== null && match.index === 0
      const exhausted = yield* Ref.get(done)
      if (matched && (match[0].length < rest.length || exhausted)) return Option.some(match[0])
      if (exhausted) return Option.none()
      yield* fill
    }
  })

export const release: Effect.Effect<void, never, ParseState> = Effect.gen(function* () {
  const { buffer, pos, base } = yield* ParseState
  const cursor = yield* Ref.get(pos)
  const bufferBase = yield* Ref.get(base)
  if (cursor > bufferBase) {
    yield* Ref.update(buffer, (current) => current.slice(cursor - bufferBase))
    yield* Ref.set(base, cursor)
  }
})

export const failHere = (expected: string) =>
  Effect.gen(function* () {
    const pos = yield* getPos
    return yield* new ParseError({ pos, expected, found: yield* peek })
  })
