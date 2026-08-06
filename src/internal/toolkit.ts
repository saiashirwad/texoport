/**
 * Shared toolkit plumbing for the CLI-backed providers: resolve the toolkit
 * once, run the provider's tool turn, and assemble the response parts.
 */
import * as AiError from "@effect/ai/AiError"
import * as LanguageModel from "@effect/ai/LanguageModel"
import * as Prompt from "@effect/ai/Prompt"
import type * as Response from "@effect/ai/Response"
import * as Tool from "@effect/ai/Tool"
import type * as Toolkit from "@effect/ai/Toolkit"
import { CommandExecutor } from "@effect/platform"
import * as Effect from "effect/Effect"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { malformedOutput } from "./errors.ts"
import { assembleParts, assembleStreamParts, type Completion, type ToolParts } from "./response.ts"

export type AnyToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>

export type ToolMethod = "generateText" | "generateObject" | "streamText"

export interface ToolTurnInput {
  readonly prompt: Prompt.Prompt
  readonly tools: ReadonlyArray<Tool.Any>
  readonly toolkit: AnyToolkit
  readonly responseFormat: LanguageModel.ProviderOptions["responseFormat"]
  readonly method: ToolMethod
}

export interface ToolTurn {
  readonly completion: Completion
  readonly toolParts: ToolParts
}

/** Mutable buffer both agent paths push tool call/result parts into. */
export type ToolPartBuffer = Array<Response.ToolCallPartEncoded | Response.ToolResultPartEncoded>

/** MCP/dynamic-tool metadata for one Effect tool. */
export const toolMetadata = (tool: Tool.Any) => ({
  name: tool.name,
  description: Tool.getDescription(tool as never) ?? `Tool ${tool.name}`,
  inputSchema: Tool.getJsonSchema(tool as never)
})

export type ToolOutcome =
  | { readonly _tag: "ok"; readonly encoded: unknown; readonly isFailure: boolean }
  | { readonly _tag: "err"; readonly message: string }

/** Run one tool call, capturing handler failures as data. */
export const callTool = (
  toolkit: AnyToolkit,
  name: string,
  args: unknown
): Effect.Effect<ToolOutcome> =>
  toolkit.handle(name, args as never).pipe(
    Effect.map((r) => ({ _tag: "ok" as const, encoded: r.encodedResult, isFailure: r.isFailure })),
    Effect.catchAll((error) => Effect.succeed({ _tag: "err" as const, message: String(error) }))
  )

/**
 * Record a tool-call part, run the handler, record the tool-result part.
 * Shared by Claude MCP gateway and Codex app-server tool paths.
 */
export const invokeTool = (
  toolkit: AnyToolkit,
  toolParts: ToolPartBuffer,
  name: string,
  args: unknown,
  id: string
): Effect.Effect<{ readonly isFailure: boolean; readonly result: unknown }> =>
  Effect.gen(function*() {
    toolParts.push({
      type: "tool-call",
      id,
      name,
      params: (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
      providerExecuted: false
    })

    const outcome = yield* callTool(toolkit, name, args)
    if (outcome._tag === "ok") {
      toolParts.push({
        type: "tool-result",
        id,
        name,
        result: outcome.encoded,
        isFailure: outcome.isFailure,
        providerExecuted: false
      })
      return { isFailure: outcome.isFailure, result: outcome.encoded }
    }

    toolParts.push({
      type: "tool-result",
      id,
      name,
      result: outcome.message,
      isFailure: true,
      providerExecuted: false
    })
    return { isFailure: true, result: outcome.message }
  })

/** Stringify a tool result for transport (MCP content / Codex contentItems). */
export const encodeToolResultText = (result: unknown): string =>
  typeof result === "string" ? result : JSON.stringify(result) ?? ""

const resolveToolkit = (
  toolkit: AnyToolkit | Effect.Effect<AnyToolkit, any, any> | undefined
): Effect.Effect<AnyToolkit | undefined, any, any> => {
  if (Predicate.isUndefined(toolkit)) return Effect.succeed(undefined)
  return Effect.isEffect(toolkit) ? toolkit : Effect.succeed(toolkit)
}

const toolsEnabled = (toolkit: AnyToolkit | undefined): toolkit is AnyToolkit =>
  toolkit !== undefined && Object.values(toolkit.tools).length > 0

/**
 * Build a LanguageModel.Service that delegates tool-enabled calls to the
 * provider's tool turn runner and everything else to the plain CLI base.
 */
export const makeToolkitService = (
  module: string,
  base: LanguageModel.Service,
  runTurn: (input: ToolTurnInput) => Effect.Effect<ToolTurn, AiError.AiError, CommandExecutor.CommandExecutor>,
  executor: CommandExecutor.CommandExecutor
): LanguageModel.Service => {
  const failMalformed = malformedOutput(module)

  const withTools = (
    toolkit: AnyToolkit,
    options: { readonly prompt: Prompt.RawInput },
    responseFormat: LanguageModel.ProviderOptions["responseFormat"],
    method: ToolMethod
  ) =>
    runTurn({
      prompt: Prompt.make(options.prompt),
      tools: Object.values(toolkit.tools),
      toolkit,
      responseFormat,
      method
    }).pipe(Effect.provideService(CommandExecutor.CommandExecutor, executor))

  return {
    generateText: (options: LanguageModel.GenerateTextOptions<any>) =>
      Effect.gen(function*() {
        const toolkit = yield* resolveToolkit(options.toolkit as never)
        if (!toolsEnabled(toolkit)) return yield* base.generateText(options as never)

        const { completion, toolParts } = yield* withTools(toolkit, options, { type: "text" }, "generateText")
        return new LanguageModel.GenerateTextResponse(assembleParts(completion, toolParts) as never)
      }),

    generateObject: (options: LanguageModel.GenerateObjectOptions<any, any, any, any>) =>
      Effect.gen(function*() {
        const toolkit = yield* resolveToolkit(options.toolkit as never)
        if (!toolsEnabled(toolkit)) return yield* base.generateObject(options as never)

        const { completion, toolParts } = yield* withTools(toolkit, options, {
          type: "json",
          objectName: options.objectName ?? "object",
          schema: options.schema
        }, "generateObject")
        const parts = assembleParts(completion, toolParts)
        const value = yield* Schema.decode(Schema.parseJson(options.schema))(completion.text).pipe(
          Effect.mapError((cause) =>
            failMalformed("generateObject", "Generated object failed schema validation", cause)
          )
        )
        return new LanguageModel.GenerateObjectResponse(value, parts as never)
      }),

    streamText: (options: LanguageModel.GenerateTextOptions<any>) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const toolkit = yield* resolveToolkit(options.toolkit as never)
          if (!toolsEnabled(toolkit)) return base.streamText(options as never)

          const { completion, toolParts } = yield* withTools(toolkit, options, { type: "text" }, "streamText")
          // Pseudo-stream: full turn (incl. tools) then emit stream parts.
          return assembleStreamParts(completion, toolParts) as Stream.Stream<Response.StreamPart<any>>
        })
      )
  } as LanguageModel.Service
}
