import { Effect, Option, Scope, Stream } from "effect";
import { UpstreamError } from "./error.ts";
import { getPos, isEof, makeStreamState, ParseState, release } from "./state.ts";

export const parseStream = <A, E, E2, R2>(
  input: Stream.Stream<string, E2, R2>,
  parser: Effect.Effect<A, E, ParseState>,
): Effect.Effect<A, E | UpstreamError, Exclude<R2, Scope.Scope>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(input);
      const state = yield* makeStreamState(pull);
      return yield* parser.pipe(Effect.provideService(ParseState, state));
    }),
  );

export const streamElements = <A, E, E2, R2>(
  input: Stream.Stream<string, E2, R2>,
  element: Effect.Effect<A, E, ParseState>,
): Stream.Stream<A, E | UpstreamError, Exclude<R2, Scope.Scope>> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(input);
      const state = yield* makeStreamState(pull);
      const withState = <X, EX>(effect: Effect.Effect<X, EX, ParseState>) =>
        effect.pipe(Effect.provideService(ParseState, state));
      const step = Effect.gen(function* () {
        if (yield* withState(isEof)) return [[], Option.none()] as const;
        const mark = yield* withState(getPos);
        const value = yield* withState(element);
        if ((yield* withState(getPos)) === mark) {
          return yield* Effect.die(
            new Error("streamElements: element parser succeeded without consuming input"),
          );
        }
        yield* withState(release);
        return [[value], Option.some(undefined)] as const;
      });
      return Stream.paginate(undefined, () => step);
    }),
  );
