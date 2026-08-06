/**
 * Claude Max/Pro toolkit path via `claude -p` + MCP (same OAuth as the CLI).
 *
 * Avoids the Agent SDK OAuth refresh path, which fails when only keychain OAuth
 * is available (common in fish shells without ANTHROPIC_* proxy env).
 *
 * Flow:
 *   HTTP gateway (tool handlers) + temp MCP stdio server
 *   → claude -p --mcp-config … --allowedTools mcp__effect__*
 */
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { AiError } from "effect/unstable/ai"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { listenGateway } from "./claudeGateway.ts"
import { buildClaudePrintArgs } from "./claudeCli.ts"
import { parseClaudeCapture } from "./claudeEnvelope.ts"
import { flattenPrompt } from "./prompt.ts"
import { runCli } from "./spawn.ts"
import {
  encodeToolResultText,
  invokeTool,
  type ToolPartBuffer,
  type ToolTurn,
  type ToolTurnInput,
  toolMetadata
} from "./toolkit.ts"

const MODULE = "ClaudeLanguageModel"

/** Runtime config for the MCP tool path (same shape the provider resolves). */
export interface ClaudeAgentConfig {
  readonly model?: string | undefined
  readonly bin: string
  readonly cwd?: string | undefined
  readonly timeout: Duration.Duration
  readonly debug: boolean
  readonly extraArgs?: ReadonlyArray<string> | undefined
}

export type ClaudeToolRunInput = ToolTurnInput & {
  readonly config: ClaudeAgentConfig
}

const mcpServerScriptPath = (): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "claudeMcpServer.mjs")

/**
 * Run one tool-enabled turn via `claude -p` + MCP (subscription OAuth).
 */
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

    const gateway = yield* Effect.acquireRelease(
      listenGateway(method, token, async (name, args) => {
        const id = `call_${++callSeq}`
        const callStartedAt = Date.now()
        log(`tool call: ${name} ${JSON.stringify(args ?? {})}`)

        // invokeTool is total (handler failures + defects → failed tool result).
        const out = await Effect.runPromiseWith(context)(
          invokeTool(toolkit, toolParts, name, args, id)
        )
        log(
          `tool ${out.isFailure ? "error" : "result"}: ${name} ` +
            `${encodeToolResultText(out.result).slice(0, 120)} (${Date.now() - callStartedAt}ms)`
        )
        return out
      }),
      (gateway) => Effect.sync(() => gateway.close())
    )
    log(`tool gateway listening on 127.0.0.1:${gateway.port}`)

    const { system, user } = flattenPrompt(prompt)

    const mcpConfig = {
      mcpServers: {
        effect: {
          command: process.execPath,
          args: [mcpServerScriptPath()],
          env: {
            EFFECT_AI_SUBS_TOOLS_JSON: JSON.stringify(mcpTools),
            EFFECT_AI_SUBS_GATEWAY: `http://127.0.0.1:${gateway.port}`,
            EFFECT_AI_SUBS_GATEWAY_TOKEN: token
          }
        }
      }
    }

    const args = buildClaudePrintArgs({
      model: config.model,
      system,
      responseFormat,
      extraArgs: config.extraArgs,
      mcp: {
        configJson: JSON.stringify(mcpConfig),
        allowedTools: mcpTools.map((t) => `mcp__effect__${t.name}`).join(",")
      }
    })

    log(`spawning claude (${mcpTools.length} tools: ${mcpTools.map((t) => t.name).join(", ")})`)
    const capture = yield* runCli({
      command: config.bin,
      args,
      stdin: user,
      cwd: config.cwd,
      module: MODULE,
      method,
      timeout: config.timeout,
      onStderr: config.debug ? (chunk) => process.stderr.write(chunk) : undefined
    })
    log(`claude exited with code ${capture.exitCode}`)

    const completion = yield* parseClaudeCapture(capture, method)
    log(`turn done: ${toolParts.length} tool parts, ${completion.text.length} chars of text`)
    return { completion, toolParts }
  }))
