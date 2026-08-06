/**
 * `@effect/ai` LanguageModel over Codex subscription:
 * - plain text/object: `codex exec`
 * - Effect toolkits: `codex app-server` dynamic tools (experimentalApi)
 */
import * as AiError from "@effect/ai/AiError"
import * as LanguageModel from "@effect/ai/LanguageModel"
import * as AiModel from "@effect/ai/Model"
import * as Prompt from "@effect/ai/Prompt"
import * as Response from "@effect/ai/Response"
import type * as Tool from "@effect/ai/Tool"
import type * as Toolkit from "@effect/ai/Toolkit"
import { CommandExecutor, FileSystem, Path } from "@effect/platform"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { runTurnWithTools } from "./internal/codexAppServer.ts"
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
type AnyToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>

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
    const services = { executor, fs, path }

    const base = yield* LanguageModel.make({
      generateText: (options) =>
        completeExec(options, defaults, services).pipe(Effect.map(toParts)),
      streamText: (options) =>
        Stream.unwrap(
          completeExec(options, defaults, services).pipe(Effect.map(toStreamParts))
        )
    })

    const resolveToolkit = (
      toolkit: AnyToolkit | Effect.Effect<AnyToolkit, any, any> | undefined
    ): Effect.Effect<AnyToolkit | undefined, any, any> => {
      if (Predicate.isUndefined(toolkit)) return Effect.succeed(undefined)
      return Effect.isEffect(toolkit) ? toolkit : Effect.succeed(toolkit)
    }

    const toolsEnabled = (toolkit: AnyToolkit | undefined) =>
      toolkit !== undefined && Object.values(toolkit.tools).length > 0

    const withTools = (
      options: {
        readonly prompt: Prompt.RawInput
        readonly toolkit?: AnyToolkit | Effect.Effect<AnyToolkit, any, any>
      },
      responseFormat: LanguageModel.ProviderOptions["responseFormat"]
    ) =>
      Effect.gen(function*() {
        const toolkit = (yield* resolveToolkit(options.toolkit))!
        const config = yield* mergedConfig(defaults)
        const timeout = Duration.decode(config.timeout ?? "3 minutes")
        return yield* runTurnWithTools({
          prompt: Prompt.make(options.prompt),
          tools: Object.values(toolkit.tools),
          toolkit,
          responseFormat,
          config: {
            bin: config.bin ?? "codex",
            model: config.model,
            cwd: config.cwd,
            sandbox: config.sandbox ?? "read-only",
            timeoutMs: Duration.toMillis(timeout)
          }
        }).pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor))
      })

    const assembleParts = (
      completion: Completion,
      toolParts: ReadonlyArray<Response.ToolCallPartEncoded | Response.ToolResultPartEncoded>
    ): Array<Response.AnyPart> => {
      const parts: Array<Response.AnyPart> = []
      for (const p of toolParts) {
        if (p.type === "tool-call") {
          parts.push(Response.makePart("tool-call", {
            id: p.id,
            name: p.name,
            params: p.params as never,
            providerExecuted: false
          }))
        } else {
          parts.push(Response.toolResultPart({
            id: p.id,
            name: p.name,
            isFailure: p.isFailure,
            result: p.result as never,
            encodedResult: p.result,
            providerExecuted: false
          }) as Response.AnyPart)
        }
      }
      if (completion.text.length > 0) {
        parts.push(Response.makePart("text", { text: completion.text }))
      }
      const inputTokens = completion.usage?.inputTokens
      const outputTokens = completion.usage?.outputTokens
      parts.push(Response.makePart("finish", {
        reason: completion.finishReason ?? "stop",
        usage: {
          inputTokens,
          outputTokens,
          totalTokens: completion.usage?.totalTokens ??
            (inputTokens !== undefined || outputTokens !== undefined
              ? (inputTokens ?? 0) + (outputTokens ?? 0)
              : undefined),
          reasoningTokens: completion.usage?.reasoningTokens,
          cachedInputTokens: completion.usage?.cachedInputTokens
        }
      }))
      return parts
    }

    return {
      generateText: (options) =>
        Effect.gen(function*() {
          const toolkit = yield* resolveToolkit(options.toolkit as never)
          if (!toolsEnabled(toolkit)) return yield* base.generateText(options)

          const { completion, toolParts } = yield* withTools(options as never, { type: "text" })
          return new LanguageModel.GenerateTextResponse(assembleParts(completion, toolParts) as never)
        }),

      generateObject: (options) =>
        Effect.gen(function*() {
          const toolkit = yield* resolveToolkit(options.toolkit as never)
          if (!toolsEnabled(toolkit)) return yield* base.generateObject(options)

          const { completion, toolParts } = yield* withTools(options as never, {
            type: "json",
            objectName: options.objectName ?? "object",
            schema: options.schema
          })
          const parts = assembleParts(completion, toolParts)
          const value = yield* Schema.decode(Schema.parseJson(options.schema))(completion.text).pipe(
            Effect.mapError((cause) =>
              new AiError.MalformedOutput({
                module: "CodexLanguageModel",
                method: "generateObject",
                description: "Generated object failed schema validation",
                cause
              })
            )
          )
          return new LanguageModel.GenerateObjectResponse(value, parts as never)
        }),

      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function*() {
            const toolkit = yield* resolveToolkit(options.toolkit as never)
            if (!toolsEnabled(toolkit)) return base.streamText(options)

            const { completion } = yield* withTools(options as never, { type: "text" })
            // Pseudo-stream: full turn (incl. tools) then emit stream parts.
            return toStreamParts(completion) as Stream.Stream<Response.StreamPart<any>>
          })
        )
    } as LanguageModel.Service
  })

const mergedConfig = (defaults: Config.Service) =>
  Effect.map(Config.getOrUndefined, (override) => ({ ...defaults, ...override }))

// =============================================================================
// Plain `codex exec` path (no Effect toolkit)
// =============================================================================

const completeExec = (
  options: LanguageModel.ProviderOptions,
  defaults: Config.Service,
  services: {
    readonly executor: CommandExecutor.CommandExecutor
    readonly fs: FileSystem.FileSystem
    readonly path: Path.Path
  }
): Effect.Effect<Completion, AiError.AiError> =>
  Effect.gen(function*() {
    // When a toolkit is used, the Service wrapper takes the app-server path.
    // LanguageModel.make only reaches here for non-toolkit calls (tools: []).
    if (options.tools.length > 0) {
      return yield* new AiError.MalformedInput({
        module: "CodexLanguageModel",
        method: "generateText",
        description:
          "Use LanguageModel.generateText({ toolkit }) for tools. The bare provider tool list is not supported on the exec path."
      })
    }

    const config = yield* mergedConfig(defaults)
    const { system, user } = flattenPrompt(options.prompt)
    const promptText = system !== undefined ? `${system}\n\n${user}` : user
    const timeout = Duration.decode(config.timeout ?? "3 minutes")
    const sandbox = config.sandbox ?? "read-only"

    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      sandbox,
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
            return yield* runSpawn([
              ...args.slice(0, -1),
              "--output-schema",
              schemaPath,
              promptText
            ])
          }),
        (dir) => services.fs.remove(dir, { recursive: true }).pipe(Effect.orDie)
      )
      return yield* parseCodexCapture(capture)
    }

    return yield* parseCodexCapture(yield* runSpawn(args))
  })
