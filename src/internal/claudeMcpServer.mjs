/**
 * MCP stdio bridge: tools + gateway from env; tools/call proxies to the parent.
 *
 *   EFFECT_AI_SUBS_TOOLS_JSON
 *   EFFECT_AI_SUBS_GATEWAY
 *   EFFECT_AI_SUBS_GATEWAY_TOKEN
 */
import { createInterface } from "node:readline"

const tools = JSON.parse(process.env.EFFECT_AI_SUBS_TOOLS_JSON ?? "[]")
const gateway = process.env.EFFECT_AI_SUBS_GATEWAY ?? ""
const token = process.env.EFFECT_AI_SUBS_GATEWAY_TOKEN ?? ""

const write = (msg) => {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

const callGateway = async (name, args) => {
  const res = await fetch(`${gateway}/call`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-effect-ai-subs-token": token },
    body: JSON.stringify({ name, arguments: args ?? {} })
  })
  if (!res.ok) {
    throw new Error(`gateway ${res.status}: ${await res.text()}`)
  }
  return /** @type {{ isFailure: boolean, result: unknown }} */ (await res.json())
}

createInterface({ input: process.stdin, terminal: false }).on("line", async (line) => {
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
    try {
      const out = await callGateway(params?.name, params?.arguments ?? {})
      const text = typeof out.result === "string"
        ? out.result
        : (JSON.stringify(out.result) ?? "")
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
