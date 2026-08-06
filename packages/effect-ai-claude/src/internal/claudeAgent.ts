/**
 * Claude Max/Pro toolkit path via `claude -p` + MCP (same OAuth as the CLI).
 *
 * Avoids the Agent SDK OAuth refresh path, which fails when only keychain OAuth
 * is available (common in fish shells without ANTHROPIC_* proxy env).
 */
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type { AiError } from "effect/unstable/ai"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { listenGateway } from "./claudeGateway.ts"
import { type ClaudeAgentConfig, runClaudePrint } from "./claudePrint.ts"
import {
  encodeToolResultText,
  invokeTool,
  type ToolInvokeResult,
  type ToolPartBuffer,
  type ToolTurn,
  type ToolTurnInput,
  toolMetadata
} from "./toolkit.ts"

export type ClaudeToolRunInput = ToolTurnInput & {
  readonly config: ClaudeAgentConfig
}

export const runTurnWithTools = (
  input: ClaudeToolRunInput
): Effect.Effect<ToolTurn, AiError.AiError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(Effect.gen(function*() {
    const context = yield* Effect.context<never>()
    const toolParts: ToolPartBuffer = []
    let callSeq = 0
    const { method, config, toolkit, tools, prompt, responseFormat } = input

    const startedAt = Date.now()
    const log = config.debug
      ? (msg: string) => console.error(`[claude-agent +${Date.now() - startedAt}ms] ${msg}`)
      : () => {}

    const mcpTools = tools.map(toolMetadata)
    const token = randomUUID()

    // Tool calls arrive as HTTP callbacks from the MCP bridge child process.
    // Each runs on the parent runtime as a tracked fiber so closing the scope
    // interrupts in-flight handlers instead of abandoning them.
    const inFlight = new Set<Fiber.Fiber<ToolInvokeResult, never>>()

    const gateway = yield* Effect.acquireRelease(
      listenGateway(method, token, async (name, args) => {
        const id = `call_${++callSeq}`
        const callStartedAt = Date.now()
        log(`tool call: ${name} ${JSON.stringify(args ?? {})}`)

        const fiber = Effect.runForkWith(context)(invokeTool(toolkit, toolParts, name, args, id))
        inFlight.add(fiber)
        try {
          const out = await Effect.runPromiseWith(context)(Fiber.join(fiber))
          log(
            `tool ${out.isFailure ? "error" : "result"}: ${name} ` +
              `${encodeToolResultText(out.result).slice(0, 120)} (${Date.now() - callStartedAt}ms)`
          )
          return out
        } finally {
          inFlight.delete(fiber)
        }
      }),
      (gateway) =>
        Fiber.interruptAll(inFlight).pipe(
          Effect.ensuring(Effect.sync(() => gateway.close()))
        )
    )
    log(`tool gateway listening on 127.0.0.1:${gateway.port}`)

    const mcpServerPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "claudeMcpServer.mjs"
    )

    log(`spawning claude (${mcpTools.length} tools: ${mcpTools.map((t) => t.name).join(", ")})`)
    const completion = yield* runClaudePrint(config, {
      prompt,
      responseFormat,
      method,
      mcp: {
        configJson: JSON.stringify({
          mcpServers: {
            effect: {
              command: process.execPath,
              args: [mcpServerPath],
              env: {
                EFFECT_AI_SUBS_TOOLS_JSON: JSON.stringify(mcpTools),
                EFFECT_AI_SUBS_GATEWAY: `http://127.0.0.1:${gateway.port}`,
                EFFECT_AI_SUBS_GATEWAY_TOKEN: token
              }
            }
          }
        }),
        allowedTools: mcpTools.map((t) => `mcp__effect__${t.name}`).join(",")
      }
    })
    log(`turn done: ${toolParts.length} tool parts, ${completion.text.length} chars of text`)
    return { completion, toolParts }
  }))
