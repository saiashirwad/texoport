/**
 * Codex app-server session: spawn stdio JSON-RPC, run one turn with Effect tools.
 * Wire-format decoding lives in codexProtocol.ts.
 */
import * as Duration from "effect/Duration"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Stream from "effect/Stream"
import { AiError } from "effect/unstable/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
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
import { defined } from "./config.ts"
import { flattenPrompt } from "./prompt.ts"
import type { Usage } from "./response.ts"
import { schemaToJsonSchemaArg } from "./schema.ts"
import {
  invokeTool,
  type ToolPartBuffer,
  type ToolTurn,
  type ToolTurnInput
} from "./toolkit.ts"

const fail = unknownError("CodexLanguageModel")
const badOutput = malformedOutput("CodexLanguageModel")

export interface AppServerConfig {
  readonly bin: string
  readonly model?: string | undefined
  readonly cwd?: string | undefined
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access"
  readonly timeout: Duration.Duration
}

export type ToolRunInput = ToolTurnInput & {
  readonly config: AppServerConfig
}

type Pending = Deferred.Deferred<unknown, AiError.AiError>

export const runTurnWithTools = (
  input: ToolRunInput
): Effect.Effect<ToolTurn, AiError.AiError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(Effect.gen(function*() {
    const { method, config, toolkit, tools, prompt, responseFormat } = input
    const timeout = config.timeout
    const process = yield* ChildProcess.make(config.bin, ["app-server", "--stdio"]).pipe(
      Effect.mapError((cause) => fail(method, "failed to spawn codex app-server", cause))
    )

    let nextId = 1
    const pending = yield* Ref.make(HashMap.empty<string | number, Pending>())
    const inbound = yield* Queue.unbounded<Inbound>()
    const turnDone = yield* Deferred.make<void, AiError.AiError>()

    // Keep stdin open for the whole session via a drain fiber.
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
      // Unblock Deferred.await if the app-server exits before turn completion.
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
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(fail(method, `codex app-server request timed out: ${rpcMethod}`))
          }),
          Effect.ensuring(Ref.update(pending, (m) => HashMap.remove(m, id)))
        )
      })

    const reply = (id: number | string, result: unknown) => write({ id, result })

    const toolParts: ToolPartBuffer = []
    let text = ""
    let usage: Usage | undefined

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
          case "rpc-response": {
            const map = yield* Ref.get(pending)
            const def = HashMap.get(map, msg.id)
            if (Option.isNone(def)) return
            if (msg.error !== undefined) {
              yield* Deferred.fail(def.value, fail(method, `codex app-server error: ${JSON.stringify(msg.error)}`))
            } else {
              yield* Deferred.succeed(def.value, msg.result)
            }
            return
          }
          case "rpc-request":
            // item/tool/call runs Effect tools; all approval RPCs are declined
            // (sandbox + approvalPolicy "never" are set at thread/start).
            if (msg.method === "item/tool/call") {
              const out = yield* invokeTool(
                toolkit,
                toolParts,
                String(msg.params["tool"] ?? ""),
                msg.params["arguments"],
                String(msg.params["callId"] ?? "")
              )
              yield* reply(msg.id, toolCallReply(out.isFailure, out.result))
            } else {
              yield* reply(msg.id, { decision: "decline" })
            }
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
      ...defined({
        model: config.model,
        cwd: config.cwd,
        developerInstructions: system
      }),
      dynamicTools: toDynamicTools(tools)
    })

    const threadId = threadIdFromStartResult(threadResult)
    if (threadId === undefined) {
      return yield* Effect.fail(badOutput(method, "thread/start missing thread.id"))
    }

    yield* request("turn/start", {
      threadId,
      input: [{ type: "text", text: user, text_elements: [] }],
      ...defined({
        outputSchema: responseFormat.type === "json"
          ? JSON.parse(schemaToJsonSchemaArg(responseFormat.schema))
          : undefined
      })
    })

    yield* Deferred.await(turnDone).pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(fail(method, `codex turn timed out after ${Duration.toMillis(timeout)}ms`))
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
