/**
 * `@effect/ai` LanguageModel over `codex exec` (ChatGPT Plus/Pro Codex subscription).
 */
import * as AiError from "@effect/ai/AiError"
import * as LanguageModel from "@effect/ai/LanguageModel"
import * as AiModel from "@effect/ai/Model"
import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { parseCodexCapture } from "./internal/codexEnvelope.ts"
import { flattenPrompt } from "./internal/prompt.ts"
import { toParts, toStreamParts, type Completion } from "./internal/response.ts"
import { schemaAstToJsonSchemaArg } from "./internal/schema.ts"
import { spawn } from "./internal/spawn.ts"

export class Config extends Context.Tag("effect-ai-subs/CodexLanguageModel/Config")<
  Config,
  Config.Service
>() {
  static readonly getOrUndefined: Effect.Effect<Config.Service | undefined> = Effect.map(
    Effect.context<never>(),
    (ctx) => ctx.unsafeMap.get(Config.key) as Config.Service | undefined
  )
}

export declare namespace Config {
  export interface Service {
    readonly model?: string | undefined
    readonly bin?: string | undefined
    readonly cwd?: string | undefined
    readonly timeout?: Duration.DurationInput | undefined
    readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access" | undefined
    readonly extraArgs?: ReadonlyArray<string> | undefined
  }
}

type Requires = CommandExecutor.CommandExecutor | FileSystem.FileSystem | Path.Path

export const model = (
  modelId?: string,
  config?: Omit<Config.Service, "model">
): AiModel.Model<"codex", LanguageModel.LanguageModel, Requires> =>
  AiModel.make(
    "codex",
    layer({ ...config, ...(modelId !== undefined ? { model: modelId } : {}) })
  )

export const layer = (
  config: Config.Service = {}
): Layer.Layer<LanguageModel.LanguageModel, never, Requires> =>
  Layer.effect(LanguageModel.LanguageModel, make(config))

export const make = (
  defaults: Config.Service = {}
): Effect.Effect<LanguageModel.Service, never, Requires> =>
  Effect.gen(function*() {
    const executor = yield* CommandExecutor.CommandExecutor
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const run = (options: LanguageModel.ProviderOptions) =>
      complete(options, defaults, { executor, fs, path })
    return yield* LanguageModel.make({
      generateText: (options) => run(options).pipe(Effect.map(toParts)),
      streamText: (options) => Stream.unwrap(run(options).pipe(Effect.map(toStreamParts)))
    })
  })

const complete = (
  options: LanguageModel.ProviderOptions,
  defaults: Config.Service,
  services: {
    readonly executor: CommandExecutor.CommandExecutor
    readonly fs: FileSystem.FileSystem
    readonly path: Path.Path
  }
): Effect.Effect<Completion, AiError.AiError> =>
  Effect.gen(function*() {
    if (options.tools.length > 0) {
      return yield* new AiError.MalformedInput({
        module: "CodexLanguageModel",
        method: "generateText",
        description:
          "Effect toolkits are not supported over the Codex CLI. Use text/object generation, or @effect/ai-openai with an API key."
      })
    }

    const config = { ...defaults, ...(yield* Config.getOrUndefined) }
    const { system, user } = flattenPrompt(options.prompt)
    const promptText = system !== undefined ? `${system}\n\n${user}` : user
    const timeout = Duration.decode(config.timeout ?? "3 minutes")
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      config.sandbox ?? "read-only",
      "--color",
      "never"
    ]

    if (config.model !== undefined) args.push("--model", config.model)
    if (config.extraArgs !== undefined) args.push(...config.extraArgs)
    args.push(promptText)

    const runSpawn = (finalArgs: ReadonlyArray<string>) =>
      spawn({
        command: config.bin ?? "codex",
        args: finalArgs,
        stdin: "",
        cwd: config.cwd
      }).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, services.executor),
        Effect.timeoutFail({
          duration: timeout,
          onTimeout: () =>
            new AiError.UnknownError({
              module: "CodexLanguageModel",
              method: "generateText",
              description: `codex timed out after ${Duration.toMillis(timeout)}ms`
            })
        }),
        Effect.mapError((error) =>
          AiError.isAiError(error)
            ? error
            : new AiError.UnknownError({
              module: "CodexLanguageModel",
              method: "generateText",
              description: "failed to spawn codex",
              cause: error
            })
        )
      )

    if (options.responseFormat.type === "json") {
      const jsonSchema = schemaAstToJsonSchemaArg(options.responseFormat.schema.ast)
      const capture = yield* Effect.acquireUseRelease(
        services.fs.makeTempDirectory({ prefix: "effect-ai-subs-" }).pipe(
          Effect.mapError((cause) =>
            new AiError.UnknownError({
              module: "CodexLanguageModel",
              method: "generateText",
              description: "failed to create temp dir for output schema",
              cause
            })
          )
        ),
        (dir) =>
          Effect.gen(function*() {
            const schemaPath = services.path.join(dir, "schema.json")
            yield* services.fs.writeFileString(schemaPath, jsonSchema).pipe(
              Effect.mapError((cause) =>
                new AiError.UnknownError({
                  module: "CodexLanguageModel",
                  method: "generateText",
                  description: "failed to write output schema",
                  cause
                })
              )
            )
            const withSchema = [...args.slice(0, -1), "--output-schema", schemaPath, promptText]
            return yield* runSpawn(withSchema)
          }),
        (dir) => services.fs.remove(dir, { recursive: true }).pipe(Effect.orDie)
      )
      return yield* parseCodexCapture(capture)
    }

    return yield* parseCodexCapture(yield* runSpawn(args))
  })
