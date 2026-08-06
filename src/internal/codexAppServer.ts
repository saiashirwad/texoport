/**
 * Codex app-server JSON-RPC client (stdio) with dynamic Effect tools.
 *
 *   initialize → thread/start(dynamicTools) → turn/start
 *   on item/tool/call → Effect toolkit.handle → respond
 *   until turn/completed
 */
import * as AiError from "@effect/ai/AiError"
import type * as LanguageModel from "@effect/ai/LanguageModel"
import type * as Prompt from "@effect/ai/Prompt"
import type * as Response from "@effect/ai/Response"
import * as Tool from "@effect/ai/Tool"
import { Command, type CommandExecutor } from "@effect/platform"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { flattenPrompt } from "./prompt.ts"
import type { Completion, ToolParts, Usage } from "./response.ts"
import { type AnyToolkit, callTool, type ToolMethod, toolMetadata } from "./toolkit.ts"

const decodeLine = Schema.decodeUnknownEither(Schema.parseJson(Schema.Unknown))
const asRecord = Schema.decodeUnknownEither(
  Schema.Record({ key: Schema.String, value: Schema.Unknown })
)

const AgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  text: Schema.String
})
const decodeAgentMessageItem = Schema.decodeUnknownEither(AgentMessageItem)

const TokenUsageParams = Schema.Struct({
  tokenUsage: Schema.optional(Schema.Struct({
    last: Schema.optional(Schema.NullOr(Schema.Struct({
      inputTokens: Schema.optional(Schema.Number),
      outputTokens: Schema.optional(Schema.Number),
      totalTokens: Schema.optional(Schema.Number),
      reasoningOutputTokens: Schema.optional(Schema.Number),
      cachedInputTokens: Schema.optional(Schema.Number)
    })))
  }))
})
const decodeTokenUsageParams = Schema.decodeUnknownEither(TokenUsageParams)

const TurnCompletedParams = Schema.Struct({
  turn: Schema.optional(Schema.Struct({
    status: Schema.String,
    error: Schema.optional(Schema.Unknown),
    items: Schema.optional(Schema.Array(Schema.Unknown))
  }))
})
const decodeTurnCompletedParams = Schema.decodeUnknownEither(TurnCompletedParams)

export interface AppServerConfig {
  readonly bin: string
  readonly model?: string | undefined
  readonly cwd?: string | undefined
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access"
  readonly timeoutMs: number
}

export interface ToolRunInput {
  readonly prompt: Prompt.Prompt
  readonly tools: ReadonlyArray<Tool.Any>
  readonly toolkit: AnyToolkit
  readonly responseFormat: LanguageModel.ProviderOptions["responseFormat"]
  readonly method: ToolMethod
  readonly config: AppServerConfig
}

const toDynamicTools = (tools: ReadonlyArray<Tool.Any>) =>
  tools.map((tool) => ({ type: "function" as const, ...toolMetadata(tool) }))

/**
 * Run one user turn on app-server, executing Effect tools when requested.
 */
export const runTurnWithTools = (
  input: ToolRunInput
): Effect.Effect<
  {
    readonly completion: Completion
    readonly toolParts: ToolParts
  },
  AiError.AiError,
  CommandExecutor.CommandExecutor
> =>
  Effect.scoped(Effect.gen(function*() {
    const process = yield* Command.start(
      Command.make(input.config.bin, "app-server", "--stdio")
    ).pipe(
      Effect.mapError((cause) =>
        new AiError.UnknownError({
          module: "CodexLanguageModel",
          method: input.method,
          description: "failed to spawn codex app-server",
          cause
        })
      )
    )

    let nextId = 1
    type Pending = Deferred.Deferred<unknown, AiError.AiError>
    const pending = yield* Ref.make(HashMap.empty<string | number, Pending>())
    const inbound = yield* Queue.unbounded<unknown>()
    const turnDone = yield* Deferred.make<void, AiError.AiError>()

    // Keep stdin open for the whole session: a fiber drains outbound into process.stdin.
    const outbound = yield* Queue.unbounded<Uint8Array>()
    yield* Stream.fromQueue(outbound).pipe(
      Stream.run(process.stdin),
      Effect.forkScoped
    )

    yield* Stream.runForEach(
      process.stdout.pipe(Stream.decodeText(), Stream.splitLines),
      (line) => {
        if (line.trim().length === 0) return Effect.void
        const decoded = decodeLine(line)
        if (Either.isLeft(decoded)) return Effect.void
        return Queue.offer(inbound, decoded.right)
      }
    ).pipe(
      // If the app-server exits (or the stream fails) the turn can never
      // complete; unblock the Deferred.await below instead of hanging until
      // the turn timeout.
      Effect.ensuring(Deferred.fail(turnDone, new AiError.UnknownError({
        module: "CodexLanguageModel",
        method: input.method,
        description: "codex app-server exited before completing the turn"
      }))),
      Effect.forkScoped
    )

    const write = (payload: unknown) =>
      Queue.offer(outbound, new TextEncoder().encode(`${JSON.stringify(payload)}\n`))

    const request = (method: string, params: unknown): Effect.Effect<unknown, AiError.AiError> =>
      Effect.gen(function*() {
        const id = nextId++
        const deferred = yield* Deferred.make<unknown, AiError.AiError>()
        yield* Ref.update(pending, (m) => HashMap.set(m, id, deferred))
        yield* write({ method, id, params })
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: input.config.timeoutMs,
            onTimeout: () =>
              new AiError.UnknownError({
                module: "CodexLanguageModel",
                method: input.method,
                description: `codex app-server request timed out: ${method}`
              })
          }),
          Effect.ensuring(Ref.update(pending, (m) => HashMap.remove(m, id)))
        )
      })

    const reply = (id: number | string, result: unknown) => write({ id, result })

    const toolParts: Array<Response.ToolCallPartEncoded | Response.ToolResultPartEncoded> = []
    let text = ""
    let usage: Usage | undefined

    const handleServerRequest = (msg: Record<string, unknown>) =>
      Effect.gen(function*() {
        const id = msg["id"] as number | string
        const method = String(msg["method"] ?? "")
        const params = (msg["params"] ?? {}) as Record<string, unknown>

        if (method === "item/tool/call") {
          const callId = String(params["callId"] ?? "")
          const toolName = String(params["tool"] ?? "")
          const args = params["arguments"]

          toolParts.push({
            type: "tool-call",
            id: callId,
            name: toolName,
            params: (args ?? {}) as Record<string, unknown>,
            providerExecuted: false
          })

          const outcome = yield* callTool(input.toolkit, toolName, args)

          if (outcome._tag === "ok") {
            toolParts.push({
              type: "tool-result",
              id: callId,
              name: toolName,
              result: outcome.encoded,
              isFailure: outcome.isFailure,
              providerExecuted: false
            })
            yield* reply(id, {
              success: !outcome.isFailure,
              contentItems: [{
                type: "inputText",
                text: typeof outcome.encoded === "string"
                  ? outcome.encoded
                  : JSON.stringify(outcome.encoded) ?? ""
              }]
            })
          } else {
            toolParts.push({
              type: "tool-result",
              id: callId,
              name: toolName,
              result: outcome.message,
              isFailure: true,
              providerExecuted: false
            })
            yield* reply(id, {
              success: false,
              contentItems: [{ type: "inputText", text: outcome.message }]
            })
          }
          return
        }

        // Approval requests (commandExecution / fileChange / permissions /
        // execCommandApproval / applyPatchApproval / …) are always declined:
        // sandbox and approvalPolicy "never" are set at thread/start.
        yield* reply(id, { decision: "decline" })
      })

    yield* Effect.forever(
      Effect.gen(function*() {
        const raw = yield* Queue.take(inbound)
        const rec = asRecord(raw)
        if (Either.isLeft(rec)) return
        const msg = rec.right

        if ("id" in msg && ("result" in msg || "error" in msg) && !("method" in msg)) {
          const id = msg["id"] as number | string
          const map = yield* Ref.get(pending)
          const def = HashMap.get(map, id)
          if (Option.isSome(def)) {
            yield* Ref.update(pending, (m) => HashMap.remove(m, id))
            if ("error" in msg) {
              yield* Deferred.fail(
                def.value,
                new AiError.UnknownError({
                  module: "CodexLanguageModel",
                  method: input.method,
                  description: `codex app-server error: ${JSON.stringify(msg["error"])}`
                })
              )
            } else {
              yield* Deferred.succeed(def.value, msg["result"])
            }
          }
          return
        }

        if ("method" in msg && "id" in msg) {
          yield* handleServerRequest(msg)
          return
        }

        if ("method" in msg) {
          const method = String(msg["method"])
          const params = (msg["params"] ?? {}) as Record<string, unknown>

          if (method === "item/completed") {
            const item = decodeAgentMessageItem(params["item"])
            if (Either.isRight(item)) text = item.right.text
          }

          if (method === "thread/tokenUsage/updated") {
            const parsed = decodeTokenUsageParams(params)
            const last = Either.isRight(parsed) ? parsed.right.tokenUsage?.last : undefined
            if (last != null) {
              usage = {
                inputTokens: last.inputTokens,
                outputTokens: last.outputTokens,
                totalTokens: last.totalTokens,
                reasoningTokens: last.reasoningOutputTokens,
                cachedInputTokens: last.cachedInputTokens
              }
            }
          }

          if (method === "turn/completed") {
            const parsed = decodeTurnCompletedParams(params)
            const turn = Either.isRight(parsed) ? parsed.right.turn : undefined
            if (turn?.status === "failed") {
              yield* Deferred.fail(
                turnDone,
                new AiError.UnknownError({
                  module: "CodexLanguageModel",
                  method: input.method,
                  description: `codex turn failed: ${JSON.stringify(turn.error)}`
                })
              )
            } else {
              for (const it of turn?.items ?? []) {
                const item = decodeAgentMessageItem(it)
                if (Either.isRight(item)) text = item.right.text
              }
              yield* Deferred.succeed(turnDone, undefined)
            }
          }

          if (method === "error") {
            yield* Deferred.fail(
              turnDone,
              new AiError.UnknownError({
                module: "CodexLanguageModel",
                method: input.method,
                description: `codex app-server error notification: ${JSON.stringify(params)}`
              })
            )
          }
        }
      })
    ).pipe(Effect.forkScoped)

    yield* request("initialize", {
      clientInfo: { name: "effect-ai-subs", title: "effect-ai-subs", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    yield* write({ method: "initialized" })

    const { system, user } = flattenPrompt(input.prompt)
    const threadResult = yield* request("thread/start", {
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: input.config.sandbox,
      ...(input.config.model !== undefined ? { model: input.config.model } : {}),
      ...(input.config.cwd !== undefined ? { cwd: input.config.cwd } : {}),
      ...(system !== undefined ? { developerInstructions: system } : {}),
      dynamicTools: toDynamicTools(input.tools)
    })

    const threadRec = asRecord(threadResult)
    if (Either.isLeft(threadRec)) {
      return yield* new AiError.MalformedOutput({
        module: "CodexLanguageModel",
        method: input.method,
        description: "invalid thread/start response"
      })
    }
    const threadObj = asRecord(threadRec.right["thread"])
    if (Either.isLeft(threadObj) || typeof threadObj.right["id"] !== "string") {
      return yield* new AiError.MalformedOutput({
        module: "CodexLanguageModel",
        method: input.method,
        description: "thread/start missing thread.id"
      })
    }
    const threadId = threadObj.right["id"]

    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: user, text_elements: [] }]
    }
    if (input.responseFormat.type === "json") {
      turnParams["outputSchema"] = Tool.getJsonSchemaFromSchemaAst(input.responseFormat.schema.ast)
    }

    yield* request("turn/start", turnParams)

    yield* Deferred.await(turnDone).pipe(
      Effect.timeoutFail({
        duration: input.config.timeoutMs,
        onTimeout: () =>
          new AiError.UnknownError({
            module: "CodexLanguageModel",
            method: input.method,
            description: `codex turn timed out after ${input.config.timeoutMs}ms`
          })
      })
    )

    return {
      completion: {
        text,
        id: threadId,
        finishReason: "stop" as const,
        usage,
        providerKey: "codex",
        raw: { threadId, toolCallCount: toolParts.length }
      },
      toolParts
    }
  }))
