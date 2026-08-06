import type { PlatformError } from "effect/PlatformError"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { AiError } from "effect/unstable/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { unknownError } from "./errors.ts"

export interface SpawnInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly stdin: string
  readonly cwd?: string | undefined
  /** Called with each decoded stderr chunk as it arrives (debug tee). */
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
  const tapped = onChunk === undefined
    ? decoded
    : decoded.pipe(Stream.tap((chunk) => Effect.sync(() => onChunk(chunk))))
  return Stream.runFold(tapped, () => "", (acc, chunk) => acc + chunk)
}

export const spawn = (
  input: SpawnInput
): Effect.Effect<SpawnCapture, PlatformError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(Effect.gen(function*() {
    const stdinBytes = new TextEncoder().encode(input.stdin)
    const process = yield* ChildProcess.make(input.command, input.args, {
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      stdin: Stream.fromIterable([stdinBytes])
    })
    // Drain stdout and stderr concurrently: a child that fills the stderr pipe
    // while we await stdout EOF would otherwise stall until the caller's timeout.
    const [stdout, stderr] = yield* Effect.all([
      readText(process.stdout),
      readText(process.stderr, input.onStderr)
    ])
    const exitCode = yield* process.exitCode
    return { stdout, stderr, exitCode: Number(exitCode) }
  }))

export interface RunCliInput extends SpawnInput {
  readonly module: string
  readonly method: string
  readonly timeout: Duration.Duration
}

/** Spawn a CLI, failing with a typed AiError on timeout or platform errors. */
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
