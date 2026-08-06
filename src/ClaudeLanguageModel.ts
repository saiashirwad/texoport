/**
 * `@effect/ai` LanguageModel over `claude -p` (Claude Code Pro/Max subscription).
 */
import * as AiError from "@effect/ai/AiError"
import * as LanguageModel from "@effect/ai/LanguageModel"
import * as AiModel from "@effect/ai/Model"
import { CommandExecutor } from "@effect/platform"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { parseClaudeCapture } from "./internal/claudeEnvelope.ts"
import { flattenPrompt } from "./internal/prompt.ts"
import { toParts, toStreamParts, type Completion } from "./internal/response.ts"
import { schemaAstToJsonSchemaArg } from "./internal/schema.ts"
import { spawn } from "./internal/spawn.ts"

export class Config extends Context.Tag("effect-ai-subs/ClaudeLanguageModel/Config")<
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
    readonly extraArgs?: ReadonlyArray<string> | undefined
  }
}

export const model = (
  modelId?: string,
  config?: Omit<Config.Service, "model">
): AiModel.Model<"claude-code", LanguageModel.LanguageModel, CommandExecutor.CommandExecutor> =>
  AiModel.make(
    "claude-code",
    layer({ ...config, ...(modelId !== undefined ? { model: modelId } : {}) })
  )

export const layer = (
  config: Config.Service = {}
): Layer.Layer<LanguageModel.LanguageModel, never, CommandExecutor.CommandExecutor> =>
  Layer.effect(LanguageModel.LanguageModel, make(config))

export const make = (
  defaults: Config.Service = {}
): Effect.Effect<LanguageModel.Service, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function*() {
    const executor = yield* CommandExecutor.CommandExecutor
    const run = (options: LanguageModel.ProviderOptions) =>
      complete(options, defaults).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, executor)
      )
    return yield* LanguageModel.make({
      generateText: (options) => run(options).pipe(Effect.map(toParts)),
      streamText: (options) => Stream.unwrap(run(options).pipe(Effect.map(toStreamParts)))
    })
  })

const complete = (
  options: LanguageModel.ProviderOptions,
  defaults: Config.Service
): Effect.Effect<Completion, AiError.AiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function*() {
    if (options.tools.length > 0) {
      return yield* new AiError.MalformedInput({
        module: "ClaudeLanguageModel",
        method: "generateText",
        description:
          "Effect toolkits are not supported over the Claude Code CLI. Use text/object generation, or @effect/ai-anthropic with an API key."
      })
    }

    const config = { ...defaults, ...(yield* Config.getOrUndefined) }
    const { system, user } = flattenPrompt(options.prompt)
    const timeout = Duration.decode(config.timeout ?? "3 minutes")
    const args = ["-p", "--output-format", "json", "--tools", ""]

    if (config.model !== undefined) args.push("--model", config.model)
    if (system !== undefined) args.push("--system-prompt", system)
    if (options.responseFormat.type === "json") {
      args.push("--json-schema", schemaAstToJsonSchemaArg(options.responseFormat.schema.ast))
    }
    if (config.extraArgs !== undefined) args.push(...config.extraArgs)

    const capture = yield* spawn({
      command: config.bin ?? "claude",
      args,
      stdin: user,
      cwd: config.cwd
    }).pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () =>
          new AiError.UnknownError({
            module: "ClaudeLanguageModel",
            method: "generateText",
            description: `claude timed out after ${Duration.toMillis(timeout)}ms`
          })
      }),
      Effect.mapError((error) =>
        AiError.isAiError(error)
          ? error
          : new AiError.UnknownError({
            module: "ClaudeLanguageModel",
            method: "generateText",
            description: "failed to spawn claude",
            cause: error
          })
      )
    )

    return yield* parseClaudeCapture(capture)
  })
