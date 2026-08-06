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

export const listenGateway = (
  method: string,
  token: string,
  handler: GatewayHandler
): Effect.Effect<ToolGateway, AiError.AiError> =>
  Effect.callback((resume) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "POST" && req.url === "/call") {
        // Per-turn token (custom header — browsers cannot forge with no-cors POST).
        if (req.headers["x-effect-ai-claude-token"] !== token) {
          res.writeHead(401)
          res.end()
          return
        }
        try {
          const body = JSON.parse(await readBody(req)) as { name?: string; arguments?: unknown }
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
        // not listening yet
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
