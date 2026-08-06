import type * as Response from "@effect/ai/Response";
import * as Stream from "effect/Stream";

export interface Usage {
  readonly inputTokens?: number | undefined;
  readonly outputTokens?: number | undefined;
  readonly totalTokens?: number | undefined;
  readonly reasoningTokens?: number | undefined;
  readonly cachedInputTokens?: number | undefined;
}

export interface Completion {
  readonly text: string;
  readonly modelId?: string | undefined;
  readonly id?: string | undefined;
  readonly finishReason?: Response.FinishReason | undefined;
  readonly usage?: Usage | undefined;
  readonly providerKey?: string | undefined;
  readonly raw?: unknown | undefined;
}

const encodeUsage = (usage: Usage | undefined): typeof Response.Usage.Encoded => {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      usage?.totalTokens ??
      (inputTokens !== undefined || outputTokens !== undefined
        ? (inputTokens ?? 0) + (outputTokens ?? 0)
        : undefined),
    reasoningTokens: usage?.reasoningTokens,
    cachedInputTokens: usage?.cachedInputTokens,
  };
};

const metadata = (result: Completion): Response.ResponseMetadataPartEncoded | undefined =>
  result.id === undefined && result.modelId === undefined
    ? undefined
    : {
        type: "response-metadata",
        id: result.id,
        modelId: result.modelId,
      };

export const toParts = (result: Completion): Array<Response.PartEncoded> => {
  const parts: Array<Response.PartEncoded> = [];
  const meta = metadata(result);
  if (meta !== undefined) parts.push(meta);
  parts.push({
    type: "text",
    text: result.text,
    ...(result.providerKey !== undefined && result.raw !== undefined
      ? { metadata: { [result.providerKey]: { raw: result.raw } } }
      : {}),
  });
  parts.push({
    type: "finish",
    reason: result.finishReason ?? "stop",
    usage: encodeUsage(result.usage),
  });
  return parts;
};

/** Full-result pseudo-stream (CLIs don't expose true token streams here). */
export const toStreamParts = (result: Completion): Stream.Stream<Response.StreamPartEncoded> => {
  const id = result.id ?? "0";
  const parts: Array<Response.StreamPartEncoded> = [];
  const meta = metadata(result);
  if (meta !== undefined) parts.push(meta);
  parts.push({ type: "text-start", id });
  if (result.text.length > 0) parts.push({ type: "text-delta", id, delta: result.text });
  parts.push({ type: "text-end", id });
  parts.push({
    type: "finish",
    reason: result.finishReason ?? "stop",
    usage: encodeUsage(result.usage),
  });
  return Stream.fromIterable(parts);
};
