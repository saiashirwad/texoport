/**
 * Minimal MCP stdio server for effect-ai-subs Claude toolkits.
 * Tool list + gateway URL come from env; tools/call is proxied to the parent process.
 *
 * Env:
 *   EFFECT_AI_SUBS_TOOLS_JSON  - JSON array of { name, description, inputSchema }
 *   EFFECT_AI_SUBS_GATEWAY     - http://127.0.0.1:<port>
 */
import { createInterface } from "node:readline"

const tools = JSON.parse(process.env.EFFECT_AI_SUBS_TOOLS_JSON ?? "[]")
const gateway = process.env.EFFECT_AI_SUBS_GATEWAY ?? ""

const write = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

const callGateway = async (name, args) => {
  const res = await fetch(`${gateway}/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, arguments: args ?? {} })
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`gateway ${res.status}: ${text}`)
  }
  return /** @type {{ isFailure: boolean, result: unknown }} */ (await res.json())
}

const rl = createInterface({ input: process.stdin, terminal: false })

rl.on("line", async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }

  const { id, method, params } = msg

  if (method === "initialize") {
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "effect", version: "0.1.0" }
      }
    })
    return
  }

  if (method === "notifications/initialized" || method === "initialized") return

  if (method === "tools/list") {
    write({ jsonrpc: "2.0", id, result: { tools } })
    return
  }

  if (method === "tools/call") {
    const name = params?.name
    const args = params?.arguments ?? {}
    try {
      const out = await callGateway(name, args)
      const text = typeof out.result === "string" ? out.result : JSON.stringify(out.result)
      write({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text }],
          isError: out.isFailure === true
        }
      })
    } catch (error) {
      write({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: String(error) }],
          isError: true
        }
      })
    }
    return
  }

  if (id !== undefined) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    })
  }
})
