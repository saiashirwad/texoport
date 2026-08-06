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
import type * as Toolkit from "@effect/ai/Toolkit"
import { Command, type CommandExecutor } from "@effect/platform"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Either from "effect/Either"
import * as Fiber from "effect/Fiber"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { flattenPrompt } from "./prompt.ts"
import type { Completion, Usage } from "./response.ts"

const JsonLine = Schema.parseJson(Schema.Unknown)
const decodeLine = Schema.decodeUnknownEither(JsonLine)
const asRecord = Schema.decodeUnknownEither(
  Schema.Record({ key: Schema.String, value: Schema.Unknown })
)

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
  readonly toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>
  readonly responseFormat: LanguageModel.ProviderOptions["responseFormat"]
  readonly config: AppServerConfig
}

const textOf = (prompt: Prompt.Prompt): { system?: string; user: string } => {
  const flat = flattenPrompt(prompt)
  return flat.system !== undefined
    ? { system: flat.system, user: flat.user }
    : { user: flat.user }
}

const toDynamicTools = (tools: ReadonlyArray<Tool.Any>) =>
  tools.map((tool) => {
    // Tool.Any is a wide union; cast for metadata helpers.
    const t = tool as Tool.Any & { readonly name: string }
    return {
      type: "function" as const,
      name: t.name,
      description: Tool.getDescription(t as never) ?? `Tool ${t.name}`,
      inputSchema: Tool.getJsonSchema(t as never) as unknown
    }
  })

const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/**
 * Run one user turn on app-server, executing Effect tools when requested.
 */
export const runTurnWithTools = (
  input: ToolRunInput
): Effect.Effect<
  {
    readonly completion: Completion
    readonly toolParts: Array<Response.ToolCallPartEncoded | Response.ToolResultPartEncoded>
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
          method: "generateText",
          description: "failed to spawn codex app-server",
          cause
        })
      )
    )

    let nextId = 1
    type Pending = Deferred.Deferred<unknown, AiError.AiError>
    const pending = yield* Ref.make(HashMap.empty<string | number, Pending>())
    const inbound = yield* Queue.unbounded<unknown>()

    // Keep stdin open for the whole session: a fiber drains outbound into process.stdin.
    const outbound = yield* Queue.unbounded<Uint8Array>()
    const writer = yield* Stream.fromQueue(outbound).pipe(
      Stream.run(process.stdin),
      Effect.forkScoped
    )

    const reader = yield* Stream.runForEach(
      process.stdout.pipe(Stream.decodeText(), Stream.splitLines),
      (line) => {
        if (line.trim().length === 0) return Effect.void
        const decoded = decodeLine(line)
        if (Either.isLeft(decoded)) return Effect.void
        return Queue.offer(inbound, decoded.right)
      }
    ).pipe(Effect.forkScoped)

    const write = (payload: unknown) =>
      Queue.offer(outbound, encodeUtf8(`${JSON.stringify(payload)}\n`))

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
                method: "generateText",
                description: `codex app-server request timed out: ${method}`
              })
          })
        )
      })

    const reply = (id: number | string, result: unknown) => write({ id, result })

    const toolParts: Array<Response.ToolCallPartEncoded | Response.ToolResultPartEncoded> = []
    let text = ""
    let usage: Usage | undefined
    const turnDone = yield* Deferred.make<void, AiError.AiError>()

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

          const outcome = yield* input.toolkit.handle(toolName, args as never).pipe(
            Effect.map((r) => ({ _tag: "ok" as const, r })),
            Effect.catchAll((error) =>
              Effect.succeed({
                _tag: "err" as const,
                message: String(error)
              })
            )
          )

          if (outcome._tag === "ok") {
            const encoded = outcome.r.encodedResult
            toolParts.push({
              type: "tool-result",
              id: callId,
              name: toolName,
              result: encoded,
              isFailure: outcome.r.isFailure,
              providerExecuted: false
            })
            yield* reply(id, {
              success: !outcome.r.isFailure,
              contentItems: [{
                type: "inputText",
                text: typeof encoded === "string" ? encoded : JSON.stringify(encoded)
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

        if (
          method === "item/commandExecution/requestApproval" ||
          method === "item/fileChange/requestApproval" ||
          method === "item/permissions/requestApproval"
        ) {
          yield* reply(id, { decision: "accept" })
          return
        }
        if (method === "execCommandApproval" || method === "applyPatchApproval") {
          yield* reply(id, { decision: "approved" })
          return
        }

        yield* reply(id, { decision: "decline" }).pipe(Effect.ignore)
      })

    const dispatcher = yield* Effect.forever(
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
                  method: "generateText",
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
            const item = params["item"] as Record<string, unknown> | undefined
            if (item?.["type"] === "agentMessage" && typeof item["text"] === "string") {
              text = item["text"]
            }
          }

          if (method === "thread/tokenUsage/updated") {
            const tokenUsage = params["tokenUsage"] as Record<string, unknown> | undefined
            const last = tokenUsage?.["last"] as Record<string, unknown> | undefined
            if (last !== undefined) {
              usage = {
                inputTokens: typeof last["inputTokens"] === "number" ? last["inputTokens"] : undefined,
                outputTokens: typeof last["outputTokens"] === "number" ? last["outputTokens"] : undefined,
                totalTokens: typeof last["totalTokens"] === "number" ? last["totalTokens"] : undefined,
                reasoningTokens: typeof last["reasoningOutputTokens"] === "number"
                  ? last["reasoningOutputTokens"]
                  : undefined,
                cachedInputTokens: typeof last["cachedInputTokens"] === "number"
                  ? last["cachedInputTokens"]
                  : undefined
              }
            }
          }

          if (method === "turn/completed") {
            const turn = params["turn"] as Record<string, unknown> | undefined
            if (turn?.["status"] === "failed") {
              yield* Deferred.fail(
                turnDone,
                new AiError.UnknownError({
                  module: "CodexLanguageModel",
                  method: "generateText",
                  description: `codex turn failed: ${JSON.stringify(turn["error"])}`
                })
              )
            } else {
              const items = turn?.["items"]
              if (Array.isArray(items)) {
                for (const it of items) {
                  if (
                    typeof it === "object" && it !== null &&
                    (it as Record<string, unknown>)["type"] === "agentMessage" &&
                    typeof (it as Record<string, unknown>)["text"] === "string"
                  ) {
                    text = (it as Record<string, unknown>)["text"] as string
                  }
                }
              }
              yield* Deferred.succeed(turnDone, undefined)
            }
          }

          if (method === "error") {
            yield* Deferred.fail(
              turnDone,
              new AiError.UnknownError({
                module: "CodexLanguageModel",
                method: "generateText",
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

    const { system, user } = textOf(input.prompt)
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
        method: "generateText",
        description: "invalid thread/start response"
      })
    }
    const threadObj = asRecord(threadRec.right["thread"])
    if (Either.isLeft(threadObj) || typeof threadObj.right["id"] !== "string") {
      return yield* new AiError.MalformedOutput({
        module: "CodexLanguageModel",
        method: "generateText",
        description: "thread/start missing thread.id"
      })
    }
    const threadId = threadObj.right["id"]

    const turnParams: Record<string, unknown> = {
      threadId,
      input: [{ type: "text", text: user, text_elements: [] }]
    }
    if (input.responseFormat.type === "json") {
      turnParams["outputSchema"] = Tool.getJsonSchemaFromSchemaAst(
        input.responseFormat.schema.ast as never
      )
    }

    yield* request("turn/start", turnParams)

    yield* Deferred.await(turnDone).pipe(
      Effect.timeoutFail({
        duration: input.config.timeoutMs,
        onTimeout: () =>
          new AiError.UnknownError({
            module: "CodexLanguageModel",
            method: "generateText",
            description: `codex turn timed out after ${input.config.timeoutMs}ms`
          })
      })
    )

    yield* Fiber.interrupt(reader).pipe(Effect.ignore)
    yield* Fiber.interrupt(writer).pipe(Effect.ignore)
    yield* Fiber.interrupt(dispatcher).pipe(Effect.ignore)
    yield* process.kill().pipe(Effect.ignore)

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
