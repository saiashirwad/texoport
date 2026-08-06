/**
 * Codex app-server session: spawn stdio JSON-RPC, run one turn with Effect tools.
 *
 * Wire-format decoding lives in codexProtocol.ts; this file owns process I/O
 * and the request/response session loop.
 */
import * as AiError from "@effect/ai/AiError"
import type * as LanguageModel from "@effect/ai/LanguageModel"
import type * as Prompt from "@effect/ai/Prompt"
import * as Tool from "@effect/ai/Tool"
import { Command, type CommandExecutor } from "@effect/platform"
import * as Duration from "effect/Duration"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { malformedOutput, unknownError } from "./errors.ts"
import {
  decodeInboundLine,
  encodeOutbound,
  type Inbound,
  interpretNotification,
  type TurnSignal,
  threadIdFromStartResult,
  toDynamicTools,
  toolCallReply
} from "./codexProtocol.ts"
import { flattenPrompt } from "./prompt.ts"
import type { Completion, Usage } from "./response.ts"
import {
  type AnyToolkit,
  invokeTool,
  type ToolMethod,
  type ToolPartBuffer
} from "./toolkit.ts"

const MODULE = "CodexLanguageModel"
const fail = unknownError(MODULE)
const badOutput = malformedOutput(MODULE)

/**
 * Subset of Codex ResolvedConfig used by the app-server tool path.
 * Extra fields on the provider config (e.g. extraArgs) are fine to pass through.
 */
export interface AppServerConfig {
  readonly bin: string
  readonly model?: string | undefined
  readonly cwd?: string | undefined
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access"
  readonly timeout: Duration.Duration
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
    const timeout = config.timeout
    const process = yield* Command.start(
      Command.make(config.bin, "app-server", "--stdio")
    ).pipe(
      Effect.mapError((cause) => fail(method, "failed to spawn codex app-server", cause))
    )

    let nextId = 1
    const pending = yield* Ref.make(HashMap.empty<string | number, Pending>())
    const inbound = yield* Queue.unbounded<Inbound>()
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
        const msg = decodeInboundLine(line)
        return msg === undefined ? Effect.void : Queue.offer(inbound, msg)
      }
    ).pipe(
      // If the app-server exits (or the stream fails) the turn can never
      // complete; unblock the Deferred.await below instead of hanging until
      // the turn timeout.
      Effect.ensuring(Deferred.fail(turnDone, fail(method, "codex app-server exited before completing the turn"))),
      Effect.forkScoped
    )

    const write = (payload: unknown) => Queue.offer(outbound, encodeOutbound(payload))

    const request = (rpcMethod: string, params: unknown): Effect.Effect<unknown, AiError.AiError> =>
      Effect.gen(function*() {
        const id = nextId++
        const deferred = yield* Deferred.make<unknown, AiError.AiError>()
        yield* Ref.update(pending, (m) => HashMap.set(m, id, deferred))
        yield* write({ method: rpcMethod, id, params })
        return yield* Deferred.await(deferred).pipe(
          Effect.timeoutFail({
            duration: timeout,
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
        const out = yield* invokeTool(toolkit, toolParts, toolName, params["arguments"], callId)
        yield* reply(id, toolCallReply(out.isFailure, out.result))
      })

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

    const applySignal = (signal: TurnSignal) => {
      switch (signal._tag) {
        case "SetText":
          text = signal.text
          return Effect.void
        case "SetUsage":
          usage = signal.usage
          return Effect.void
        case "Complete":
          if (signal.text !== undefined) text = signal.text
          return Deferred.succeed(turnDone, undefined)
        case "Fail":
          return Deferred.fail(turnDone, fail(method, signal.message))
        case "Ignore":
          return Effect.void
      }
    }

    yield* Effect.forever(
      Effect.gen(function*() {
        const msg = yield* Queue.take(inbound)
        switch (msg.kind) {
          case "rpc-response":
            yield* settleResponse(msg.id, msg.error, msg.result)
            return
          case "rpc-request":
            // item/tool/call runs Effect tools; all approval RPCs are declined
            // (sandbox + approvalPolicy "never" are set at thread/start).
            yield* msg.method === "item/tool/call"
              ? handleToolCall(msg.id, msg.params)
              : reply(msg.id, { decision: "decline" })
            return
          case "notification":
            yield* applySignal(interpretNotification(msg.method, msg.params))
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

    const threadId = threadIdFromStartResult(threadResult)
    if (threadId === undefined) {
      return yield* badOutput(method, "thread/start missing thread.id")
    }

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
        duration: timeout,
        onTimeout: () =>
          fail(method, `codex turn timed out after ${Duration.toMillis(timeout)}ms`)
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
