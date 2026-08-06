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
import * as AiError from "@effect/ai/AiError"
import type * as LanguageModel from "@effect/ai/LanguageModel"
import type * as Prompt from "@effect/ai/Prompt"
import type * as Response from "@effect/ai/Response"
import type * as Tool from "@effect/ai/Tool"
import type { CommandExecutor } from "@effect/platform"
import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Runtime from "effect/Runtime"
import { parseClaudeCapture } from "./claudeEnvelope.ts"
import { flattenPrompt } from "./prompt.ts"
import type { Completion, ToolParts } from "./response.ts"
import { schemaAstToJsonSchemaArg } from "./schema.ts"
import { runCli } from "./spawn.ts"
import { type AnyToolkit, callTool, type ToolMethod, toolMetadata } from "./toolkit.ts"

export interface ClaudeAgentConfig {
  readonly model?: string | undefined
  readonly cwd?: string | undefined
  readonly pathToClaude?: string | undefined
  readonly timeout: Duration.Duration
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
  Effect.async((resume) => {
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
        resume(Effect.fail(
          new AiError.UnknownError({
            module: "ClaudeLanguageModel",
            method,
            description: "failed to bind tool gateway"
          })
        ))
        return
      }
      resume(Effect.succeed({ port: addr.port, close }))
    })

    server.on("error", (cause) => {
      resume(Effect.fail(
        new AiError.UnknownError({
          module: "ClaudeLanguageModel",
          method,
          description: "tool gateway listen error",
          cause
        })
      ))
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
    readonly toolParts: ToolParts
  },
  AiError.AiError,
  CommandExecutor.CommandExecutor
> =>
  Effect.scoped(Effect.gen(function*() {
    const runtime = yield* Effect.runtime<never>()
    const toolParts: Array<Response.ToolCallPartEncoded | Response.ToolResultPartEncoded> = []
    let callSeq = 0

    const mcpTools = input.tools.map(toolMetadata)
    const token = randomUUID()

    const gateway = yield* Effect.acquireRelease(
      listenGateway(input.method, token, async (name, args) => {
        const id = `call_${++callSeq}`
        toolParts.push({
          type: "tool-call",
          id,
          name,
          params: (args ?? {}) as Record<string, unknown>,
          providerExecuted: false
        })

        try {
          const outcome = await Runtime.runPromise(runtime)(callTool(input.toolkit, name, args))

          if (outcome._tag === "ok") {
            toolParts.push({
              type: "tool-result",
              id,
              name,
              result: outcome.encoded,
              isFailure: outcome.isFailure,
              providerExecuted: false
            })
            return { isFailure: outcome.isFailure, result: outcome.encoded }
          }

          toolParts.push({
            type: "tool-result",
            id,
            name,
            result: outcome.message,
            isFailure: true,
            providerExecuted: false
          })
          return { isFailure: true, result: outcome.message }
        } catch (error) {
          const message = String(error)
          toolParts.push({
            type: "tool-result",
            id,
            name,
            result: message,
            isFailure: true,
            providerExecuted: false
          })
          return { isFailure: true, result: message }
        }
      }),
      (gateway) => Effect.sync(() => gateway.close())
    )

    const { system, user } = flattenPrompt(input.prompt)

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

    const allowed = mcpTools.map((t) => `mcp__effect__${t.name}`).join(",")
    const args = [
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--permission-mode",
      "bypassPermissions",
      "--strict-mcp-config",
      "--mcp-config",
      JSON.stringify(mcpConfig),
      "--allowedTools",
      allowed
    ]

    if (input.config.model !== undefined) args.push("--model", input.config.model)
    if (system !== undefined) args.push("--system-prompt", system)
    if (input.responseFormat.type === "json") {
      args.push("--json-schema", schemaAstToJsonSchemaArg(input.responseFormat.schema.ast))
    }

    const capture = yield* runCli({
      command: input.config.pathToClaude ?? "claude",
      args,
      stdin: user,
      cwd: input.config.cwd,
      module: "ClaudeLanguageModel",
      method: input.method,
      timeout: input.config.timeout
    })

    const completion = yield* parseClaudeCapture(capture, input.method)
    return { completion, toolParts }
  }))
