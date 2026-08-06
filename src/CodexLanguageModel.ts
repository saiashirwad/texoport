/**
 * `@effect/ai` LanguageModel over Codex subscription:
 * - plain text/object: `codex exec`
 * - Effect toolkits: `codex app-server` dynamic tools (experimentalApi)
 */
import * as AiError from "@effect/ai/AiError"
import * as LanguageModel from "@effect/ai/LanguageModel"
import * as AiModel from "@effect/ai/Model"
import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { runTurnWithTools } from "./internal/codexAppServer.ts"
import { parseCodexCapture } from "./internal/codexEnvelope.ts"
import { DEFAULT_TIMEOUT } from "./internal/defaults.ts"
import { unknownError } from "./internal/errors.ts"
import { flattenPrompt } from "./internal/prompt.ts"
import { type Completion, toParts, toStreamParts } from "./internal/response.ts"
import { schemaAstToJsonSchemaArg } from "./internal/schema.ts"
import { runCli, type SpawnCapture } from "./internal/spawn.ts"
import { makeToolkitService } from "./internal/toolkit.ts"

export interface Config {
  readonly model?: string | undefined
  readonly bin?: string | undefined
  readonly cwd?: string | undefined
  readonly timeout?: Duration.DurationInput | undefined
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access" | undefined
  readonly extraArgs?: ReadonlyArray<string> | undefined
}

type Requires = CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path

interface ResolvedConfig {
  readonly model?: string | undefined
  readonly bin: string
  readonly cwd?: string | undefined
  readonly timeout: Duration.Duration
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access"
  readonly extraArgs?: ReadonlyArray<string> | undefined
}

const resolveConfig = (config: Config = {}): ResolvedConfig => ({
  ...(config.model !== undefined ? { model: config.model } : {}),
  bin: config.bin ?? "codex",
  ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
  timeout: Duration.decode(config.timeout ?? DEFAULT_TIMEOUT),
  sandbox: config.sandbox ?? "read-only",
  ...(config.extraArgs !== undefined ? { extraArgs: config.extraArgs } : {})
})

export const model = (
  modelId?: string,
  config?: Omit<Config, "model">
): AiModel.Model<"codex", LanguageModel.LanguageModel, Requires> =>
  AiModel.make(
    "codex",
    layer({ ...config, ...(modelId !== undefined ? { model: modelId } : {}) })
  )

export const layer = (
  config: Config = {}
): Layer.Layer<LanguageModel.LanguageModel, never, Requires> =>
  Layer.effect(LanguageModel.LanguageModel, make(config))

export const make = (
  defaults: Config = {}
): Effect.Effect<LanguageModel.Service, never, Requires> =>
  Effect.gen(function*() {
    const executor = yield* CommandExecutor.CommandExecutor
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = resolveConfig(defaults)
    const services = { executor, fs, path }

    const base = yield* LanguageModel.make({
      generateText: (options) =>
        completeExec(options, config, services, "generateText").pipe(Effect.map(toParts)),
      streamText: (options) =>
        Stream.unwrap(
          completeExec(options, config, services, "streamText").pipe(Effect.map(toStreamParts))
        )
    })

    // ResolvedConfig matches AppServerConfig — pass through, no field remap.
    return makeToolkitService(
      "CodexLanguageModel",
      base,
      (input) => runTurnWithTools({ ...input, config }),
      executor
    )
  })

// =============================================================================
// Plain `codex exec` path (no Effect toolkit)
// =============================================================================

const completeExec = (
  options: LanguageModel.ProviderOptions,
  config: ResolvedConfig,
  services: {
    readonly executor: CommandExecutor.CommandExecutor
    readonly fs: FileSystem.FileSystem
    readonly path: Path.Path
  },
  method: "generateText" | "streamText"
): Effect.Effect<Completion, AiError.AiError> =>
  Effect.gen(function*() {
    const fail = unknownError("CodexLanguageModel")
    const { system, user } = flattenPrompt(options.prompt)
    const promptText = system !== undefined ? `${system}\n\n${user}` : user
    // LanguageModel.make derives generateObject from generateText with a JSON
    // response format, so attribute errors accordingly.
    const effectiveMethod = options.responseFormat.type === "json" ? "generateObject" : method

    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      config.sandbox,
      "--color",
      "never"
    ]

    if (config.model !== undefined) args.push("--model", config.model)
    if (config.extraArgs !== undefined) args.push(...config.extraArgs)

    const runSpawn = (finalArgs: ReadonlyArray<string>): Effect.Effect<SpawnCapture, AiError.AiError> =>
      runCli({
        command: config.bin,
        args: finalArgs,
        stdin: "",
        cwd: config.cwd,
        module: "CodexLanguageModel",
        method: effectiveMethod,
        timeout: config.timeout
      }).pipe(Effect.provideService(CommandExecutor.CommandExecutor, services.executor))

    if (options.responseFormat.type !== "json") {
      return yield* parseCodexCapture(yield* runSpawn([...args, promptText]), effectiveMethod)
    }

    const jsonSchema = schemaAstToJsonSchemaArg(options.responseFormat.schema.ast)
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
          return yield* runSpawn([...args, "--output-schema", schemaPath, promptText])
        }),
      (dir) => services.fs.remove(dir, { recursive: true }).pipe(Effect.orDie)
    )
    return yield* parseCodexCapture(capture, effectiveMethod)
  })
