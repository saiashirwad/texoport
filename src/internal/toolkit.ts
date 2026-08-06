/**
 * Shared toolkit plumbing for the CLI-backed providers: resolve the toolkit
 * once, run the provider's tool turn, and assemble the response parts.
 */
import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import {
  AiError,
  LanguageModel,
  Prompt,
  type Response,
  Tool,
  type Toolkit
} from "effect/unstable/ai"
import { ChildProcessSpawner } from "effect/unstable/process"
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

export interface ToolInvokeResult {
  readonly isFailure: boolean
  readonly result: unknown
}

type SpawnerService = Context.Service.Shape<typeof ChildProcessSpawner.ChildProcessSpawner>

/** Coerce tool call arguments into the params record shape Response expects. */
export const asToolParams = (args: unknown): Record<string, unknown> =>
  args !== null && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {}

/** MCP/dynamic-tool metadata for one Effect tool. */
export const toolMetadata = (tool: Tool.Any) => ({
  name: tool.name,
  description: Tool.getDescription(tool as never) ?? `Tool ${tool.name}`,
  inputSchema: Tool.getJsonSchema(tool as never)
})

const pushToolCall = (
  toolParts: ToolPartBuffer,
  id: string,
  name: string,
  args: unknown
): void => {
  toolParts.push({
    type: "tool-call",
    id,
    name,
    params: asToolParams(args),
    providerExecuted: false
  })
}

const pushToolResult = (
  toolParts: ToolPartBuffer,
  id: string,
  name: string,
  result: unknown,
  isFailure: boolean
): void => {
  toolParts.push({
    type: "tool-result",
    id,
    name,
    result,
    isFailure,
    providerExecuted: false
  })
}

const hasPart = (toolParts: ToolPartBuffer, type: "tool-call" | "tool-result", id: string): boolean =>
  toolParts.some((p) => p.type === type && p.id === id)

/**
 * Record a tool-call part, run the handler, record the tool-result part.
 * Handler failures and runtime defects are captured as failed tool results
 * (never throw), so both the Claude gateway and Codex app-server stay total.
 */
export const invokeTool = (
  toolkit: AnyToolkit,
  toolParts: ToolPartBuffer,
  name: string,
  args: unknown,
  id: string
): Effect.Effect<ToolInvokeResult> => {
  const body = Effect.gen(function*() {
    pushToolCall(toolParts, id, name, args)

    const outcome: ToolInvokeResult = yield* Effect.gen(function*() {
      // v4 handle returns Effect<Stream<HandlerResult>>; take the last chunk.
      const resultStream = yield* toolkit.handle(name, args as never, id)
      const chunks = yield* Stream.runCollect(resultStream)
      const last = chunks.at(-1)
      if (last === undefined) {
        return { isFailure: true, result: "tool handler produced no result" } satisfies ToolInvokeResult
      }
      return {
        isFailure: last.isFailure,
        result: last.encodedResult
      } satisfies ToolInvokeResult
    }).pipe(
      Effect.catch((): Effect.Effect<ToolInvokeResult> =>
        Effect.succeed({ isFailure: true, result: "tool handler failed" })
      )
    )

    pushToolResult(toolParts, id, name, outcome.result, outcome.isFailure)
    return outcome
  }).pipe(
    Effect.catchDefect((error) =>
      Effect.sync(() => {
        const message = String(error)
        if (!hasPart(toolParts, "tool-call", id)) {
          pushToolCall(toolParts, id, name, args)
        }
        if (!hasPart(toolParts, "tool-result", id)) {
          pushToolResult(toolParts, id, name, message, true)
        }
        return { isFailure: true, result: message } satisfies ToolInvokeResult
      })
    )
  )
  // Tool handlers may declare services; failures collapse into ToolInvokeResult so
  // the public surface stays total with no leftover requirements.
  return body as Effect.Effect<ToolInvokeResult>
}

/** Stringify a tool result for transport (MCP content / Codex contentItems). */
export const encodeToolResultText = (result: unknown): string =>
  typeof result === "string" ? result : JSON.stringify(result) ?? ""

/** Resolve a toolkit option to an active toolkit, or undefined when tools are off. */
const resolveActiveToolkit = (
  toolkit: AnyToolkit | Effect.Effect<AnyToolkit, any, any> | undefined
): Effect.Effect<AnyToolkit | undefined, any, any> =>
  Effect.gen(function*() {
    if (Predicate.isUndefined(toolkit)) return undefined
    const resolved = Effect.isEffect(toolkit) ? yield* toolkit : toolkit
    return Object.values(resolved.tools).length > 0 ? resolved : undefined
  })

const provideSpawner = <A, E, R>(
  effect: Effect.Effect<A, E, R | ChildProcessSpawner.ChildProcessSpawner>,
  spawner: SpawnerService
): Effect.Effect<A, E, Exclude<R, ChildProcessSpawner.ChildProcessSpawner>> =>
  effect.pipe(
    Effect.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner))
  )

/**
 * Build a LanguageModel.Service that delegates tool-enabled calls to the
 * provider's tool turn runner and everything else to the plain CLI base.
 */
export const makeToolkitService = (
  module: string,
  base: LanguageModel.Service,
  runTurn: (
    input: ToolTurnInput
  ) => Effect.Effect<ToolTurn, AiError.AiError, ChildProcessSpawner.ChildProcessSpawner>,
  spawner: SpawnerService
): LanguageModel.Service => {
  const failMalformed = malformedOutput(module)

  const withTools = (
    toolkit: AnyToolkit,
    options: { readonly prompt: Prompt.RawInput },
    responseFormat: LanguageModel.ProviderOptions["responseFormat"],
    method: ToolMethod
  ) =>
    provideSpawner(
      runTurn({
        prompt: Prompt.make(options.prompt),
        tools: Object.values(toolkit.tools),
        toolkit,
        responseFormat,
        method
      }),
      spawner
    )

  return {
    generateText: (options: LanguageModel.GenerateTextOptions<any>) =>
      Effect.gen(function*() {
        const toolkit = yield* resolveActiveToolkit(options.toolkit as never)
        if (toolkit === undefined) return yield* base.generateText(options as never)

        const { completion, toolParts } = yield* withTools(toolkit, options, { type: "text" }, "generateText")
        return new LanguageModel.GenerateTextResponse(assembleParts(completion, toolParts) as never)
      }),

    generateObject: (options: LanguageModel.GenerateObjectOptions<any, any>) =>
      Effect.gen(function*() {
        const toolkit = yield* resolveActiveToolkit(options.toolkit as never)
        if (toolkit === undefined) return yield* base.generateObject(options as never)

        const { completion, toolParts } = yield* withTools(toolkit, options, {
          type: "json",
          objectName: options.objectName ?? "object",
          schema: options.schema
        }, "generateObject")
        const parts = assembleParts(completion, toolParts)
        const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(options.schema))(
          completion.text
        ).pipe(
          Effect.mapError((cause) =>
            failMalformed("generateObject", "Generated object failed schema validation", cause)
          )
        )
        return new LanguageModel.GenerateObjectResponse(value, parts as never)
      }),

    streamText: (options: LanguageModel.GenerateTextOptions<any>) =>
      Stream.unwrap(
        Effect.gen(function*() {
          const toolkit = yield* resolveActiveToolkit(options.toolkit as never)
          if (toolkit === undefined) return base.streamText(options as never)

          const { completion, toolParts } = yield* withTools(toolkit, options, { type: "text" }, "streamText")
          // Pseudo-stream: full turn (incl. tools) then emit stream parts.
          return assembleStreamParts(completion, toolParts) as Stream.Stream<Response.StreamPart<any>>
        })
      )
  } as LanguageModel.Service
}
