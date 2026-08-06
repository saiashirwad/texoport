import * as Stream from "effect/Stream"
import { Response } from "effect/unstable/ai"

export interface Usage {
  readonly inputTokens?: number | undefined
  readonly outputTokens?: number | undefined
  readonly totalTokens?: number | undefined
  readonly reasoningTokens?: number | undefined
  readonly cachedInputTokens?: number | undefined
}

export interface Completion {
  readonly text: string
  readonly modelId?: string | undefined
  readonly id?: string | undefined
  readonly finishReason?: Response.FinishReason | undefined
  readonly usage?: Usage | undefined
  readonly providerKey?: string | undefined
  readonly raw?: unknown | undefined
}

const encodeUsage = (usage: Usage | undefined): typeof Response.Usage.Encoded => {
  const inputTokens = usage?.inputTokens
  const outputTokens = usage?.outputTokens
  const totalTokens =
    usage?.totalTokens ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined)
  return {
    inputTokens: {
      total: inputTokens ?? totalTokens,
      uncached: undefined,
      cacheRead: usage?.cachedInputTokens,
      cacheWrite: undefined
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: usage?.reasoningTokens
    }
  }
}

const metadataEncoded = (result: Completion): Response.ResponseMetadataPartEncoded | undefined =>
  result.id === undefined && result.modelId === undefined
    ? undefined
    : {
      type: "response-metadata",
      id: result.id,
      modelId: result.modelId
    }

const finishEncoded = (result: Completion): Response.FinishPartEncoded => ({
  type: "finish",
  reason: result.finishReason ?? "stop",
  usage: encodeUsage(result.usage)
})

const textStreamBody = (id: string, text: string): Array<Response.StreamPartEncoded> => {
  const parts: Array<Response.StreamPartEncoded> = [{ type: "text-start", id }]
  if (text.length > 0) parts.push({ type: "text-delta", id, delta: text })
  parts.push({ type: "text-end", id })
  return parts
}

export const toParts = (result: Completion): Array<Response.PartEncoded> => {
  const parts: Array<Response.PartEncoded> = []
  const meta = metadataEncoded(result)
  if (meta !== undefined) parts.push(meta)
  const textPart: Response.TextPartEncoded = {
    type: "text",
    text: result.text
  }
  if (result.providerKey !== undefined && result.raw !== undefined) {
    // Provider metadata must be JSON-serializable; stringify unknown raw payloads.
    ;(textPart as { metadata?: Response.ProviderMetadata }).metadata = {
      [result.providerKey]: { raw: JSON.parse(JSON.stringify(result.raw)) as never }
    }
  }
  parts.push(textPart)
  parts.push(finishEncoded(result))
  return parts
}

/** Full-result pseudo-stream (CLIs don't expose true token streams here). */
export const toStreamParts = (result: Completion): Stream.Stream<Response.StreamPartEncoded> => {
  const id = result.id ?? "0"
  const parts: Array<Response.StreamPartEncoded> = []
  const meta = metadataEncoded(result)
  if (meta !== undefined) parts.push(meta)
  parts.push(...textStreamBody(id, result.text), finishEncoded(result))
  return Stream.fromIterable(parts)
}

export type ToolParts = ReadonlyArray<
  Response.ToolCallPartEncoded | Response.ToolResultPartEncoded
>

const toolPart = (
  part: ToolParts[number]
): Response.AnyPart =>
  part.type === "tool-call"
    ? Response.makePart("tool-call", {
      id: part.id,
      name: part.name,
      params: part.params as never,
      providerExecuted: false
    })
    : Response.toolResultPart({
      id: part.id,
      name: part.name,
      isFailure: part.isFailure,
      result: part.result as never,
      encodedResult: part.result,
      providerExecuted: false,
      preliminary: false
    })

/** Decoded parts for a tool-enabled turn: metadata, tool calls/results, text, finish. */
export const assembleParts = (
  completion: Completion,
  toolParts: ToolParts
): Array<Response.AnyPart> => {
  const parts: Array<Response.AnyPart> = []
  if (completion.id !== undefined || completion.modelId !== undefined) {
    parts.push(Response.makePart("response-metadata", {
      id: completion.id,
      modelId: completion.modelId,
      timestamp: undefined,
      request: undefined
    }))
  }
  for (const part of toolParts) parts.push(toolPart(part))
  if (completion.text.length > 0) {
    parts.push(Response.makePart("text", { text: completion.text }))
  }
  parts.push(
    Response.makePart("finish", {
      reason: completion.finishReason ?? "stop",
      usage: new Response.Usage(encodeUsage(completion.usage)),
      response: undefined
    })
  )
  return parts
}

/** Pseudo-stream for a tool-enabled turn: tool parts, then the text stream parts. */
export const assembleStreamParts = (
  completion: Completion,
  toolParts: ToolParts
): Stream.Stream<Response.StreamPartEncoded> => {
  const id = completion.id ?? "0"
  const parts: Array<Response.StreamPartEncoded> = []
  const meta = metadataEncoded(completion)
  if (meta !== undefined) parts.push(meta)
  for (const part of toolParts) parts.push(part)
  parts.push(...textStreamBody(id, completion.text), finishEncoded(completion))
  return Stream.fromIterable(parts)
}
