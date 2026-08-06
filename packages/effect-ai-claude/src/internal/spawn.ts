import type * as Context from "effect/Context"
import type { PlatformError } from "effect/PlatformError"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { AiError } from "effect/unstable/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { unknownError } from "./errors.ts"

export type SpawnerService = Context.Service.Shape<typeof ChildProcessSpawner.ChildProcessSpawner>

export const provideSpawner = <A, E, R>(
  effect: Effect.Effect<A, E, R | ChildProcessSpawner.ChildProcessSpawner>,
  spawner: SpawnerService
): Effect.Effect<A, E, Exclude<R, ChildProcessSpawner.ChildProcessSpawner>> =>
  effect.pipe(Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)))

export interface SpawnInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly stdin: string
  readonly cwd?: string | undefined
  readonly onStderr?: ((chunk: string) => void) | undefined
}

export interface SpawnCapture {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const readText = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
  onChunk?: (chunk: string) => void
): Effect.Effect<string, PlatformError> => {
  const decoded = stream.pipe(Stream.decodeText())
  return Stream.runFold(
    onChunk === undefined
      ? decoded
      : decoded.pipe(Stream.tap((chunk) => Effect.sync(() => onChunk(chunk)))),
    () => "",
    (acc, chunk) => acc + chunk
  )
}

export const spawn = (
  input: SpawnInput
): Effect.Effect<SpawnCapture, PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* ChildProcess.make(input.command, input.args, {
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      stdin: Stream.fromIterable([new TextEncoder().encode(input.stdin)])
    })
    // Drain stdout and stderr concurrently: a full stderr pipe while awaiting
    // stdout EOF would otherwise stall until the caller's timeout.
    const [stdout, stderr] = yield* Effect.all([
      readText(process.stdout),
      readText(process.stderr, input.onStderr)
    ])
    return { stdout, stderr, exitCode: Number(yield* process.exitCode) }
  }))

export interface RunCliInput extends SpawnInput {
  readonly module: string
  readonly method: string
  readonly timeout: Duration.Duration
}

export const runCli = (
  input: RunCliInput
): Effect.Effect<SpawnCapture, AiError.AiError, ChildProcessSpawner.ChildProcessSpawner> => {
  const fail = unknownError(input.module)
  return spawn(input).pipe(
    Effect.timeoutOrElse({
      duration: input.timeout,
      orElse: () =>
        Effect.fail(
          fail(input.method, `${input.command} timed out after ${Duration.toMillis(input.timeout)}ms`)
        )
    }),
    Effect.mapError((error) =>
      AiError.isAiError(error)
        ? error
        : fail(input.method, `failed to spawn ${input.command}`, error)
    )
  )
}
