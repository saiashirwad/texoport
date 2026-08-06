import { Command, type CommandExecutor } from "@effect/platform"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

export interface SpawnInput {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly stdin: string
  readonly cwd?: string | undefined
}

export interface SpawnCapture {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

const readText = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(Stream.decodeText(), Stream.runFold("", (acc, chunk) => acc + chunk), Effect.orDie)

export const spawn = (
  input: SpawnInput
): Effect.Effect<SpawnCapture, unknown, CommandExecutor.CommandExecutor> =>
  Effect.scoped(Effect.gen(function*() {
    let command = Command.make(input.command, ...input.args).pipe(Command.feed(input.stdin))
    if (input.cwd !== undefined) {
      command = Command.workingDirectory(command, input.cwd)
    }
    const process = yield* Command.start(command)
    const stdout = yield* readText(process.stdout)
    const stderr = yield* readText(process.stderr)
    const exitCode = yield* process.exitCode.pipe(Effect.orDie)
    return { stdout, stderr, exitCode: Number(exitCode) }
  }))
