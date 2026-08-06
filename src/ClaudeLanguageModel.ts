/**
 * `@effect/ai` LanguageModel over Claude Code subscription (Pro/Max):
 * - plain text/object: `claude -p`
 * - Effect toolkits: `claude -p` + local MCP bridge (same OAuth as the CLI)
 */
import * as AiError from "@effect/ai/AiError"
import * as LanguageModel from "@effect/ai/LanguageModel"
import * as AiModel from "@effect/ai/Model"
import * as Prompt from "@effect/ai/Prompt"
import * as Response from "@effect/ai/Response"
import type * as Tool from "@effect/ai/Tool"
import type * as Toolkit from "@effect/ai/Toolkit"
import { CommandExecutor } from "@effect/platform"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { runTurnWithTools } from "./internal/claudeAgent.ts"
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
    /** Max agent turns when using Effect toolkits (Agent SDK). Default 16. */
    readonly maxTurns?: number | undefined
  }
}

type AnyToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>

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

    const base = yield* LanguageModel.make({
      generateText: (options) =>
        completeCli(options, defaults).pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Effect.map(toParts)
        ),
      streamText: (options) =>
        Stream.unwrap(
          completeCli(options, defaults).pipe(
            Effect.provideService(CommandExecutor.CommandExecutor, executor),
            Effect.map(toStreamParts)
          )
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
        const config = { ...defaults, ...(yield* Config.getOrUndefined) }
        const timeout = Duration.decode(config.timeout ?? "3 minutes")
        return yield* runTurnWithTools({
          prompt: Prompt.make(options.prompt),
          tools: Object.values(toolkit.tools),
          toolkit,
          responseFormat,
          config: {
            model: config.model,
            cwd: config.cwd,
            pathToClaude: config.bin,
            timeout,
            maxTurns: config.maxTurns
          }
        })
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
                module: "ClaudeLanguageModel",
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
            return toStreamParts(completion) as Stream.Stream<Response.StreamPart<any>>
          })
        )
    } as LanguageModel.Service
  })

// =============================================================================
// Plain `claude -p` path (no Effect toolkit)
// =============================================================================

const completeCli = (
  options: LanguageModel.ProviderOptions,
  defaults: Config.Service
): Effect.Effect<Completion, AiError.AiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function*() {
    if (options.tools.length > 0) {
      return yield* new AiError.MalformedInput({
        module: "ClaudeLanguageModel",
        method: "generateText",
        description:
          "Use LanguageModel.generateText({ toolkit }) for tools. The bare provider tool list is not supported on the claude -p path."
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
