/**
 * Loopback HTTP gateway that Claude's MCP bridge calls to run Effect tool handlers.
 * One server per tool-enabled turn; auth is a per-turn random token header.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import * as Effect from "effect/Effect"
import type { AiError } from "effect/unstable/ai"
import { unknownError } from "./errors.ts"

const fail = unknownError("ClaudeLanguageModel")

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })

export interface ToolGateway {
  readonly port: number
  readonly close: () => void
}

export type GatewayHandler = (
  name: string,
  args: unknown
) => Promise<{ isFailure: boolean; result: unknown }>

/** Bind an ephemeral 127.0.0.1 server that POSTs /call → handler. */
export const listenGateway = (
  method: string,
  token: string,
  handler: GatewayHandler
): Effect.Effect<ToolGateway, AiError.AiError> =>
  Effect.callback((resume) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && req.url === "/call") {
        // Loopback-only but otherwise open on the machine; the per-turn token
        // (custom header — browsers cannot forge it with a no-cors POST) gates tools.
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
        // never listened
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
