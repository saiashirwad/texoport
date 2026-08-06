/**
 * Shared LanguageModel construction for CLI-backed providers:
 * plain complete → LanguageModel.make base, then toolkit wrap.
 */
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { type AiError, LanguageModel } from "effect/unstable/ai"
import type { ChildProcessSpawner } from "effect/unstable/process"
import { type Completion, toParts, toStreamParts } from "./response.ts"
import type { SpawnerService } from "./spawn.ts"
import { makeToolkitService, type ToolTurn, type ToolTurnInput } from "./toolkit.ts"

export type CompleteFn = (
  options: LanguageModel.ProviderOptions,
  method: "generateText" | "streamText"
) => Effect.Effect<Completion, AiError.AiError>

export type RunTurnFn = (
  input: ToolTurnInput
) => Effect.Effect<ToolTurn, AiError.AiError, ChildProcessSpawner.ChildProcessSpawner>

/**
 * Build a LanguageModel.Service: CLI complete for text/stream, tool turn when a toolkit is active.
 */
export const makeProviderService = (
  module: string,
  spawner: SpawnerService,
  complete: CompleteFn,
  runTurn: RunTurnFn
): Effect.Effect<LanguageModel.Service> =>
  LanguageModel.make({
    generateText: (options) => complete(options, "generateText").pipe(Effect.map(toParts)),
    streamText: (options) =>
      Stream.unwrap(complete(options, "streamText").pipe(Effect.map(toStreamParts)))
  }).pipe(
    Effect.map((base) => makeToolkitService(module, base, runTurn, spawner))
  )
