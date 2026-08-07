import { Effect, Function, Schema } from "effect"
import { locateParseError, ParseError } from "./error.ts"
import { makeStringState, ParseState } from "./state.ts"

/** Run a parser against a whole string. */
export const parse: {
  <A, E>(input: string): (parser: Effect.Effect<A, E, ParseState>) => Effect.Effect<A, E, never>
  <A, E>(parser: Effect.Effect<A, E, ParseState>, input: string): Effect.Effect<A, E, never>
} = Function.dual(2, <A, E>(parser: Effect.Effect<A, E, ParseState>, input: string) =>
  Effect.gen(function* () {
    const state = yield* makeStringState(input)
    return yield* parser.pipe(
      Effect.provideService(ParseState, state),
      Effect.mapError((error) =>
        Schema.is(ParseError)(error) ? locateParseError(input, error) : error,
      ),
    )
  }),
)
