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
import { malformedOutput, unknownError } from "./errors.ts"
import { flattenPrompt } from "./prompt.ts"
import type { Completion, Usage } from "./response.ts"
import {
  type AnyToolkit,
  encodeToolResultText,
  invokeTool,
  type ToolMethod,
  type ToolPartBuffer,
  toolMetadata
} from "./toolkit.ts"

const MODULE = "CodexLanguageModel"
const fail = unknownError(MODULE)
const badOutput = malformedOutput(MODULE)

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

type Pending = Deferred.Deferred<unknown, AiError.AiError>

type Inbound =
  | { readonly kind: "rpc-response"; readonly id: string | number; readonly error?: unknown; readonly result?: unknown }
  | { readonly kind: "rpc-request"; readonly id: string | number; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: "notification"; readonly method: string; readonly params: Record<string, unknown> }
  | { readonly kind: "ignore" }

const classifyInbound = (msg: Record<string, unknown>): Inbound => {
  const hasId = "id" in msg
  const hasMethod = "method" in msg
  const isResponse = hasId && ("result" in msg || "error" in msg) && !hasMethod

  if (isResponse) {
    return {
      kind: "rpc-response",
      id: msg["id"] as string | number,
      ...("error" in msg ? { error: msg["error"] } : { result: msg["result"] })
    }
  }

  const params = (msg["params"] !== undefined && typeof msg["params"] === "object" && msg["params"] !== null
    ? msg["params"]
    : {}) as Record<string, unknown>

  if (hasMethod && hasId) {
    return {
      kind: "rpc-request",
      id: msg["id"] as string | number,
      method: String(msg["method"] ?? ""),
      params
    }
  }

  if (hasMethod) {
    return {
      kind: "notification",
      method: String(msg["method"]),
      params
    }
  }

  return { kind: "ignore" }
}

const toDynamicTools = (tools: ReadonlyArray<Tool.Any>) =>
  tools.map((tool) => ({ type: "function" as const, ...toolMetadata(tool) }))

const toolCallReply = (isFailure: boolean, result: unknown) => ({
  success: !isFailure,
  contentItems: [{ type: "inputText", text: encodeToolResultText(result) }]
})

const usageFromLast = (last: {
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly totalTokens?: number | undefined
  readonly reasoningOutputTokens?: number | undefined
  readonly cachedInputTokens?: number | undefined
}): Usage => ({
  inputTokens: last.inputTokens,
  outputTokens: last.outputTokens,
  totalTokens: last.totalTokens,
  reasoningTokens: last.reasoningOutputTokens,
  cachedInputTokens: last.cachedInputTokens
})

/**
 * Run one user turn on app-server, executing Effect tools when requested.
 */
export const runTurnWithTools = (
  input: ToolRunInput
): Effect.Effect<
  {
    readonly completion: Completion
    readonly toolParts: ToolPartBuffer
  },
  AiError.AiError,
  CommandExecutor.CommandExecutor
> =>
  Effect.scoped(Effect.gen(function*() {
    const { method, config, toolkit, tools, prompt, responseFormat } = input
    const process = yield* Command.start(
      Command.make(config.bin, "app-server", "--stdio")
    ).pipe(
      Effect.mapError((cause) => fail(method, "failed to spawn codex app-server", cause))
    )

    let nextId = 1
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
      Effect.ensuring(Deferred.fail(turnDone, fail(method, "codex app-server exited before completing the turn"))),
      Effect.forkScoped
    )

    const write = (payload: unknown) =>
      Queue.offer(outbound, new TextEncoder().encode(`${JSON.stringify(payload)}\n`))

    const request = (rpcMethod: string, params: unknown): Effect.Effect<unknown, AiError.AiError> =>
      Effect.gen(function*() {
        const id = nextId++
        const deferred = yield* Deferred.make<unknown, AiError.AiError>()
        yield* Ref.update(pending, (m) => HashMap.set(m, id, deferred))
        yield* write({ method: rpcMethod, id, params })
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: config.timeoutMs,
            onTimeout: () => fail(method, `codex app-server request timed out: ${rpcMethod}`)
          }),
          Effect.ensuring(Ref.update(pending, (m) => HashMap.remove(m, id)))
        )
      })

    const reply = (id: number | string, result: unknown) => write({ id, result })

    const toolParts: ToolPartBuffer = []
    let text = ""
    let usage: Usage | undefined

    const handleToolCall = (id: string | number, params: Record<string, unknown>) =>
      Effect.gen(function*() {
        const callId = String(params["callId"] ?? "")
        const toolName = String(params["tool"] ?? "")
        const args = params["arguments"]
        const out = yield* invokeTool(toolkit, toolParts, toolName, args, callId)
        yield* reply(id, toolCallReply(out.isFailure, out.result))
      })

    const handleServerRequest = (id: string | number, rpcMethod: string, params: Record<string, unknown>) => {
      if (rpcMethod === "item/tool/call") return handleToolCall(id, params)
      // Approval requests (commandExecution / fileChange / permissions /
      // execCommandApproval / applyPatchApproval / …) are always declined:
      // sandbox and approvalPolicy "never" are set at thread/start.
      return reply(id, { decision: "decline" })
    }

    const handleNotification = (rpcMethod: string, params: Record<string, unknown>) => {
      if (rpcMethod === "item/completed") {
        const item = decodeAgentMessageItem(params["item"])
        if (Either.isRight(item)) text = item.right.text
        return Effect.void
      }

      if (rpcMethod === "thread/tokenUsage/updated") {
        const parsed = decodeTokenUsageParams(params)
        const last = Either.isRight(parsed) ? parsed.right.tokenUsage?.last : undefined
        if (last != null) usage = usageFromLast(last)
        return Effect.void
      }

      if (rpcMethod === "turn/completed") {
        const parsed = decodeTurnCompletedParams(params)
        const turn = Either.isRight(parsed) ? parsed.right.turn : undefined
        if (turn?.status === "failed") {
          return Deferred.fail(turnDone, fail(method, `codex turn failed: ${JSON.stringify(turn.error)}`))
        }
        for (const it of turn?.items ?? []) {
          const item = decodeAgentMessageItem(it)
          if (Either.isRight(item)) text = item.right.text
        }
        return Deferred.succeed(turnDone, undefined)
      }

      if (rpcMethod === "error") {
        return Deferred.fail(
          turnDone,
          fail(method, `codex app-server error notification: ${JSON.stringify(params)}`)
        )
      }

      return Effect.void
    }

    const settleResponse = (id: string | number, error: unknown | undefined, result: unknown | undefined) =>
      Effect.gen(function*() {
        const map = yield* Ref.get(pending)
        const def = HashMap.get(map, id)
        if (Option.isNone(def)) return
        if (error !== undefined) {
          yield* Deferred.fail(def.value, fail(method, `codex app-server error: ${JSON.stringify(error)}`))
        } else {
          yield* Deferred.succeed(def.value, result)
        }
      })

    yield* Effect.forever(
      Effect.gen(function*() {
        const raw = yield* Queue.take(inbound)
        const rec = asRecord(raw)
        if (Either.isLeft(rec)) return

        const msg = classifyInbound(rec.right)
        switch (msg.kind) {
          case "rpc-response":
            yield* settleResponse(msg.id, msg.error, msg.result)
            return
          case "rpc-request":
            yield* handleServerRequest(msg.id, msg.method, msg.params)
            return
          case "notification":
            yield* handleNotification(msg.method, msg.params)
            return
          case "ignore":
            return
        }
      })
    ).pipe(Effect.forkScoped)

    yield* request("initialize", {
      clientInfo: { name: "effect-ai-subs", title: "effect-ai-subs", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false }
    })
    yield* write({ method: "initialized" })

    const { system, user } = flattenPrompt(prompt)
    const threadResult = yield* request("thread/start", {
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: config.sandbox,
      ...(config.model !== undefined ? { model: config.model } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      ...(system !== undefined ? { developerInstructions: system } : {}),
      dynamicTools: toDynamicTools(tools)
    })

    const threadRec = asRecord(threadResult)
    if (Either.isLeft(threadRec)) {
      return yield* badOutput(method, "invalid thread/start response")
    }
    const threadObj = asRecord(threadRec.right["thread"])
    if (Either.isLeft(threadObj) || typeof threadObj.right["id"] !== "string") {
      return yield* badOutput(method, "thread/start missing thread.id")
    }
    const threadId = threadObj.right["id"]

    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: user, text_elements: [] }]
    }
    if (responseFormat.type === "json") {
      turnParams["outputSchema"] = Tool.getJsonSchemaFromSchemaAst(responseFormat.schema.ast)
    }

    yield* request("turn/start", turnParams)

    yield* Deferred.await(turnDone).pipe(
      Effect.timeoutFail({
        duration: config.timeoutMs,
        onTimeout: () => fail(method, `codex turn timed out after ${config.timeoutMs}ms`)
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
