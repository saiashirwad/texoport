import { Effect, Schema } from "effect"
import { locateParseError, ParseError, UpstreamError } from "./error.ts"
import { makeStringState, ParseState } from "./state.ts"

/** Run a parser against a whole string, returning its result instead of failing. */
export const parse = <A, E>(input: string, parser: Effect.Effect<A, E, ParseState>) =>
  Effect.gen(function* () {
    const state = yield* makeStringState(input)
    return yield* parser.pipe(
      Effect.provideService(ParseState, state),
      Effect.catchIf(Schema.is(UpstreamError), (error) => Effect.die(error)),
      Effect.mapError((error) =>
        Schema.is(ParseError)(error) ? locateParseError(input, error) : error,
      ),
    )
  }).pipe(Effect.result)
