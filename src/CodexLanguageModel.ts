/**
 * Effect AI LanguageModel over Codex subscription:
 * - plain text/object: `codex exec`
 * - Effect toolkits: `codex app-server` dynamic tools (experimentalApi)
 */
import { FileSystem, Path } from "effect"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { type AiError, LanguageModel, Model as AiModel } from "effect/unstable/ai"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  type AppServerConfig,
  runTurnWithTools
} from "./internal/codexAppServer.ts"
import { buildCodexExecArgs } from "./internal/codexCli.ts"
import { parseCodexCapture } from "./internal/codexEnvelope.ts"
import {
  type BaseConfig,
  defined,
  methodForFormat,
  resolveBase
} from "./internal/config.ts"
import { unknownError } from "./internal/errors.ts"
import { makeProviderService } from "./internal/provider.ts"
import { flattenPrompt } from "./internal/prompt.ts"
import type { Completion } from "./internal/response.ts"
import { schemaToJsonSchemaArg } from "./internal/schema.ts"
import { provideSpawner, runCli } from "./internal/spawn.ts"

export interface Config extends BaseConfig {
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access" | undefined
}

type Requires =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path

interface ResolvedConfig extends AppServerConfig {
  readonly extraArgs?: ReadonlyArray<string> | undefined
}

const resolveConfig = (config: Config = {}): ResolvedConfig => ({
  ...resolveBase(config, "codex"),
  sandbox: config.sandbox ?? "read-only"
})

export const model = (
  modelId?: string,
  config?: Omit<Config, "model">
): AiModel.Model<"codex", LanguageModel.LanguageModel, Requires> =>
  AiModel.make(
    "codex",
    modelId ?? "default",
    layer({ ...config, ...defined({ model: modelId }) })
  )

export const layer = (
  config: Config = {}
): Layer.Layer<LanguageModel.LanguageModel, never, Requires> =>
  Layer.effect(LanguageModel.LanguageModel, make(config))

export const make = (
  defaults: Config = {}
): Effect.Effect<LanguageModel.Service, never, Requires> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = resolveConfig(defaults)

    return yield* makeProviderService(
      "CodexLanguageModel",
      spawner,
      (options, method) =>
        provideSpawner(completeExec(options, config, { fs, path }, method), spawner),
      (input) => runTurnWithTools({ ...input, config })
    )
  })

// =============================================================================
// Plain `codex exec` path (no Effect toolkit)
// =============================================================================

const completeExec = (
  options: LanguageModel.ProviderOptions,
  config: ResolvedConfig,
  services: {
    readonly fs: FileSystem.FileSystem
    readonly path: Path.Path
  },
  method: "generateText" | "streamText"
): Effect.Effect<Completion, AiError.AiError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const fail = unknownError("CodexLanguageModel")
    const { system, user } = flattenPrompt(options.prompt)
    const promptText = system !== undefined ? `${system}\n\n${user}` : user
    const effectiveMethod = methodForFormat(options.responseFormat, method)

    const runSpawn = (outputSchemaPath?: string) =>
      runCli({
        command: config.bin,
        args: buildCodexExecArgs({
          model: config.model,
          sandbox: config.sandbox,
          extraArgs: config.extraArgs,
          outputSchemaPath,
          promptText
        }),
        stdin: "",
        cwd: config.cwd,
        module: "CodexLanguageModel",
        method: effectiveMethod,
        timeout: config.timeout
      })

    if (options.responseFormat.type !== "json") {
      return yield* parseCodexCapture(yield* runSpawn(), effectiveMethod)
    }

    const jsonSchema = schemaToJsonSchemaArg(options.responseFormat.schema)
    const capture = yield* Effect.acquireUseRelease(
      services.fs.makeTempDirectory({ prefix: "effect-ai-subs-" }).pipe(
        Effect.mapError((cause) =>
          fail(effectiveMethod, "failed to create temp dir for output schema", cause)
        )
      ),
      (dir) =>
        Effect.gen(function*() {
          const schemaPath = services.path.join(dir, "schema.json")
          yield* services.fs.writeFileString(schemaPath, jsonSchema).pipe(
            Effect.mapError((cause) =>
              fail(effectiveMethod, "failed to write output schema", cause)
            )
          )
          return yield* runSpawn(schemaPath)
        }),
      (dir) => services.fs.remove(dir, { recursive: true }).pipe(Effect.orDie)
    )
    return yield* parseCodexCapture(capture, effectiveMethod)
  })
