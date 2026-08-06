import * as Effect from "effect/Effect"
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
import type { ChildProcessSpawner } from "effect/unstable/process"
import { malformedOutput } from "./errors.ts"
import { assembleParts, assembleStreamParts, type Completion, type ToolParts } from "./response.ts"
import { provideSpawner, type SpawnerService } from "./spawn.ts"

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

export type ToolPartBuffer = Array<Response.ToolCallPartEncoded | Response.ToolResultPartEncoded>

export interface ToolInvokeResult {
  readonly isFailure: boolean
  readonly result: unknown
}

export const asToolParams = (args: unknown): Record<string, unknown> =>
  args !== null && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {}

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
 * Record call + result parts. Handler failures and defects become failed tool
 * results so the surface stays total.
 */
export const invokeTool = (
  toolkit: AnyToolkit,
  toolParts: ToolPartBuffer,
  name: string,
  args: unknown,
  id: string
): Effect.Effect<ToolInvokeResult> => {
  const failed = (result: unknown): ToolInvokeResult => ({ isFailure: true, result })

  const ensureFailedParts = (result: unknown): ToolInvokeResult => {
    if (!hasPart(toolParts, "tool-call", id)) pushToolCall(toolParts, id, name, args)
    if (!hasPart(toolParts, "tool-result", id)) pushToolResult(toolParts, id, name, result, true)
    return failed(result)
  }

  const body = Effect.gen(function*() {
    pushToolCall(toolParts, id, name, args)

    // v4 handle returns Effect<Stream<HandlerResult>>; take the last chunk.
    const outcome: ToolInvokeResult = yield* Effect.gen(function*() {
      const resultStream = yield* toolkit.handle(name, args as never, id)
      const last = (yield* Stream.runCollect(resultStream)).at(-1)
      if (last === undefined) return failed("tool handler produced no result")
      return { isFailure: last.isFailure, result: last.encodedResult } satisfies ToolInvokeResult
    }).pipe(
      Effect.catch((error): Effect.Effect<ToolInvokeResult> =>
        Effect.succeed(failed(error instanceof Error ? error.message : String(error)))
      )
    )

    pushToolResult(toolParts, id, name, outcome.result, outcome.isFailure)
    return outcome
  }).pipe(
    Effect.catchDefect((error) => Effect.sync(() => ensureFailedParts(String(error))))
  )

  return body as Effect.Effect<ToolInvokeResult>
}

export const encodeToolResultText = (result: unknown): string =>
  typeof result === "string" ? result : JSON.stringify(result) ?? ""

type ToolkitOption = AnyToolkit | Effect.Effect<AnyToolkit, any, any> | undefined

/**
 * LanguageModel.Service that routes tool-enabled calls through runTurn and
 * everything else through the plain CLI base.
 *
 * Several `as never` casts exist because LanguageModel.Service overloads are
 * toolkit-generic; custom providers that reassemble Response parts cannot
 * satisfy those overloads without an escape hatch.
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

  const runToolTurn = (
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

  const withOptionalToolkit = <A, E, R>(
    toolkitOption: ToolkitOption,
    baseCall: Effect.Effect<A, E, R>,
    toolCall: (toolkit: AnyToolkit) => Effect.Effect<A, E | AiError.AiError, R>
  ): Effect.Effect<A, E | AiError.AiError, R> =>
    Effect.gen(function*() {
      if (Predicate.isUndefined(toolkitOption)) return yield* baseCall
      const resolved = Effect.isEffect(toolkitOption)
        ? yield* (toolkitOption as Effect.Effect<AnyToolkit>)
        : toolkitOption
      return Object.values(resolved.tools).length > 0
        ? yield* toolCall(resolved)
        : yield* baseCall
    }) as Effect.Effect<A, E | AiError.AiError, R>

  return {
    generateText: (options: LanguageModel.GenerateTextOptions<any>) =>
      withOptionalToolkit(
        options.toolkit as ToolkitOption,
        base.generateText(options as never),
        (toolkit) =>
          runToolTurn(toolkit, options, { type: "text" }, "generateText").pipe(
            Effect.map((turn) =>
              new LanguageModel.GenerateTextResponse(
                assembleParts(turn.completion, turn.toolParts) as never
              )
            )
          )
      ),

    generateObject: (options: LanguageModel.GenerateObjectOptions<any, any>) =>
      withOptionalToolkit(
        options.toolkit as ToolkitOption,
        base.generateObject(options as never),
        (toolkit) =>
          Effect.gen(function*() {
            const turn = yield* runToolTurn(toolkit, options, {
              type: "json",
              objectName: options.objectName ?? "object",
              schema: options.schema
            }, "generateObject")
            const value = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(options.schema))(
              turn.completion.text
            ).pipe(
              Effect.mapError((cause) =>
                failMalformed("generateObject", "Generated object failed schema validation", cause)
              )
            )
            return new LanguageModel.GenerateObjectResponse(
              value,
              assembleParts(turn.completion, turn.toolParts) as never
            )
          })
      ),

    streamText: (options: LanguageModel.GenerateTextOptions<any>) =>
      Stream.unwrap(
        withOptionalToolkit(
          options.toolkit as ToolkitOption,
          Effect.succeed(base.streamText(options as never)),
          (toolkit) =>
            runToolTurn(toolkit, options, { type: "text" }, "streamText").pipe(
              Effect.map(
                (turn) =>
                  assembleStreamParts(turn.completion, turn.toolParts) as Stream.Stream<
                    Response.StreamPart<any>
                  >
              )
            )
        )
      )
  } as LanguageModel.Service
}
