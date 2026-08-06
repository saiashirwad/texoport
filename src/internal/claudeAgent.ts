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
import * as Tool from "@effect/ai/Tool"
import type * as Toolkit from "@effect/ai/Toolkit"
import type { CommandExecutor } from "@effect/platform"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Runtime from "effect/Runtime"
import { parseClaudeCapture } from "./claudeEnvelope.ts"
import { flattenPrompt } from "./prompt.ts"
import type { Completion } from "./response.ts"
import { spawn } from "./spawn.ts"

export interface ClaudeAgentConfig {
  readonly model?: string | undefined
  readonly cwd?: string | undefined
  readonly pathToClaude?: string | undefined
  readonly timeout: Duration.Duration
  readonly maxTurns?: number | undefined
}

export interface ClaudeToolRunInput {
  readonly prompt: Prompt.Prompt
  readonly tools: ReadonlyArray<Tool.Any>
  readonly toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>
  readonly responseFormat: LanguageModel.ProviderOptions["responseFormat"]
  readonly config: ClaudeAgentConfig
}

const textOf = (prompt: Prompt.Prompt): { system?: string; user: string } => {
  const flat = flattenPrompt(prompt)
  return flat.system !== undefined
    ? { system: flat.system, user: flat.user }
    : { user: flat.user }
}

const mcpServerScriptPath = (): string => {
  // Prefer sibling .mjs next to this module (src or dist).
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    return path.join(here, "claudeMcpServer.mjs")
  } catch {
    const req = createRequire(import.meta.url)
    return req.resolve("./claudeMcpServer.mjs")
  }
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c) => chunks.push(Buffer.from(c)))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

const listenGateway = (
  handler: (name: string, args: unknown) => Promise<{ isFailure: boolean; result: unknown }>
): Effect.Effect<{ port: number; close: () => void }, AiError.AiError> =>
  Effect.async((resume) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && req.url === "/call") {
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

    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      if (addr === null || typeof addr === "string") {
        resume(Effect.fail(
          new AiError.UnknownError({
            module: "ClaudeLanguageModel",
            method: "generateText",
            description: "failed to bind tool gateway"
          })
        ))
        return
      }
      resume(Effect.succeed({
        port: addr.port,
        close: () => {
          server.close()
        }
      }))
    })

    server.on("error", (cause) => {
      resume(Effect.fail(
        new AiError.UnknownError({
          module: "ClaudeLanguageModel",
          method: "generateText",
          description: "tool gateway listen error",
          cause
        })
      ))
    })
  })

/**
 * Run one tool-enabled turn via `claude -p` + MCP (subscription OAuth).
 */
export const runTurnWithTools = (
  input: ClaudeToolRunInput
): Effect.Effect<
  {
    readonly completion: Completion
    readonly toolParts: Array<Response.ToolCallPartEncoded | Response.ToolResultPartEncoded>
  },
  AiError.AiError,
  CommandExecutor.CommandExecutor
> =>
  Effect.gen(function*() {
    const runtime = yield* Effect.runtime<never>()
    const toolParts: Array<Response.ToolCallPartEncoded | Response.ToolResultPartEncoded> = []
    let callSeq = 0

    const mcpTools = input.tools.map((raw) => {
      const t = raw as Tool.Any & { readonly name: string }
      return {
        name: t.name,
        description: Tool.getDescription(t as never) ?? `Tool ${t.name}`,
        inputSchema: Tool.getJsonSchema(t as never)
      }
    })

    const gateway = yield* listenGateway(async (name, args) => {
      const id = `call_${++callSeq}`
      toolParts.push({
        type: "tool-call",
        id,
        name,
        params: (args ?? {}) as Record<string, unknown>,
        providerExecuted: false
      })

      try {
        const outcome = await Runtime.runPromise(runtime)(
          input.toolkit.handle(name, args as never).pipe(
            Effect.map((r) => ({ _tag: "ok" as const, r })),
            Effect.catchAll((error) =>
              Effect.succeed({ _tag: "err" as const, message: String(error) })
            )
          )
        )

        if (outcome._tag === "ok") {
          const encoded = outcome.r.encodedResult
          toolParts.push({
            type: "tool-result",
            id,
            name,
            result: encoded,
            isFailure: outcome.r.isFailure,
            providerExecuted: false
          })
          return { isFailure: outcome.r.isFailure, result: encoded }
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
    })

    const { system, user } = textOf(input.prompt)
    let promptText = user
    if (input.responseFormat.type === "json") {
      const schema = Tool.getJsonSchemaFromSchemaAst(input.responseFormat.schema.ast as never)
      promptText +=
        `\n\nRespond with ONLY raw JSON matching this schema (no markdown):\n${
          JSON.stringify(schema)
        }`
    }

    const mcpConfig = {
      mcpServers: {
        effect: {
          command: process.execPath,
          args: [mcpServerScriptPath()],
          env: {
            EFFECT_AI_SUBS_TOOLS_JSON: JSON.stringify(mcpTools),
            EFFECT_AI_SUBS_GATEWAY: `http://127.0.0.1:${gateway.port}`
          }
        }
      }
    }

    // Write mcp config via stdin is not supported; use a temp file through Command.
    const configJson = JSON.stringify(mcpConfig)
    const allowed = mcpTools.map((t) => `mcp__effect__${t.name}`).join(",")
    const bin = input.config.pathToClaude ?? "claude"
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
      configJson,
      "--allowedTools",
      allowed
    ]

    if (input.config.model !== undefined) args.push("--model", input.config.model)
    if (system !== undefined) args.push("--system-prompt", system)

    const capture = yield* spawn({
      command: bin,
      args,
      stdin: promptText,
      cwd: input.config.cwd
    }).pipe(
      Effect.timeoutFail({
        duration: input.config.timeout,
        onTimeout: () =>
          new AiError.UnknownError({
            module: "ClaudeLanguageModel",
            method: "generateText",
            description: `claude timed out after ${Duration.toMillis(input.config.timeout)}ms`
          })
      }),
      Effect.mapError((error) =>
        AiError.isAiError(error)
          ? error
          : new AiError.UnknownError({
            module: "ClaudeLanguageModel",
            method: "generateText",
            description: "failed to spawn claude for toolkit turn",
            cause: error
          })
      ),
      Effect.ensuring(Effect.sync(() => gateway.close()))
    )

    const completion = yield* parseClaudeCapture(capture)

    // Prefer usage from CLI envelope; keep toolParts recorded by gateway.
    return {
      completion: {
        ...completion,
        // If model returned empty text but tools ran, leave as-is (caller sees results).
      },
      toolParts
    }
  })
