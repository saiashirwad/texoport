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
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { AiError, LanguageModel, Prompt, Tool } from "effect/unstable/ai"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { buildClaudePrintArgs } from "./claudeCli.ts"
import { parseClaudeCapture } from "./claudeEnvelope.ts"
import { unknownError } from "./errors.ts"
import { flattenPrompt } from "./prompt.ts"
import type { Completion } from "./response.ts"
import { runCli } from "./spawn.ts"
import {
  type AnyToolkit,
  encodeToolResultText,
  invokeTool,
  type ToolMethod,
  type ToolPartBuffer,
  toolMetadata
} from "./toolkit.ts"

const MODULE = "ClaudeLanguageModel"
const fail = unknownError(MODULE)

/** Resolved runtime config shared with ClaudeLanguageModel (same shape, no remapping). */
export interface ClaudeAgentConfig {
  readonly model?: string | undefined
  readonly bin: string
  readonly cwd?: string | undefined
  readonly timeout: Duration.Duration
  readonly debug: boolean
  readonly extraArgs?: ReadonlyArray<string> | undefined
}

export interface ClaudeToolRunInput {
  readonly prompt: Prompt.Prompt
  readonly tools: ReadonlyArray<Tool.Any>
  readonly toolkit: AnyToolkit
  readonly responseFormat: LanguageModel.ProviderOptions["responseFormat"]
  readonly method: ToolMethod
  readonly config: ClaudeAgentConfig
}

const mcpServerScriptPath = (): string =>
  path.join(path.dirname(fileURLToPath(import.meta.url)), "claudeMcpServer.mjs")

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

const listenGateway = (
  method: string,
  token: string,
  handler: (name: string, args: unknown) => Promise<{ isFailure: boolean; result: unknown }>
): Effect.Effect<{ port: number; close: () => void }, AiError.AiError> =>
  Effect.callback((resume) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && req.url === "/call") {
        // The gateway is loopback-only but otherwise unauthenticated on the
        // machine; the per-turn token (a custom header, so browsers cannot
        // forge it with a no-cors POST) gates tool execution.
        if (req.headers["x-effect-ai-subs-token"] !== token) {
          res.writeHead(401)
          res.end()
          return
        }
        try {
          const raw = await readBody(req)
          const body = JSON.parse(raw) as { name?: string; arguments?: unknown }
          const out = await handler(String(body.name ?? ""), body.arguments ?? {})
          res.writeHead(200, { "content-type": "application/json" })
          res.end(JSON.stringify(out))
        } catch (error) {
          res.writeHead(500, { "content-type": "application/json" })
          res.end(JSON.stringify({ isFailure: true, result: String(error) }))
        }
        return
      }
      res.writeHead(404)
      res.end()
    })

    const close = () => {
      try {
        server.closeAllConnections()
        server.close()
      } catch {
        // server never listened
      }
    }

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (addr === null || typeof addr !== "object") {
        resume(Effect.fail(fail(method, "failed to bind tool gateway")))
        return
      }
      resume(Effect.succeed({ port: addr.port, close }))
    })

    server.on("error", (cause) => {
      resume(Effect.fail(fail(method, "tool gateway listen error", cause)))
    })

    return Effect.sync(close)
  })

/**
 * Run one tool-enabled turn via `claude -p` + MCP (subscription OAuth).
 */
export const runTurnWithTools = (
  input: ClaudeToolRunInput
): Effect.Effect<
  {
    readonly completion: Completion
    readonly toolParts: ToolPartBuffer
  },
  AiError.AiError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
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
