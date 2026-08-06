import * as Response from "@effect/ai/Response";
import * as Option from "effect/Option";
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

export type ToolParts = ReadonlyArray<
  Response.ToolCallPartEncoded | Response.ToolResultPartEncoded
>;

const toolPart = (
  part: ToolParts[number]
): Response.AnyPart =>
  part.type === "tool-call"
    ? Response.makePart("tool-call", {
        id: part.id,
        name: part.name,
        params: part.params as never,
        providerExecuted: false,
      })
    : (Response.toolResultPart({
        id: part.id,
        name: part.name,
        isFailure: part.isFailure,
        result: part.result as never,
        encodedResult: part.result,
        providerExecuted: false,
      }) as Response.AnyPart);

const metadataPart = (result: Completion): Response.AnyPart | undefined =>
  result.id === undefined && result.modelId === undefined
    ? undefined
    : Response.makePart("response-metadata", {
        id: Option.fromNullable(result.id),
        modelId: Option.fromNullable(result.modelId),
        timestamp: Option.none(),
      });

/** Decoded parts for a tool-enabled turn: metadata, tool calls/results, text, finish. */
export const assembleParts = (
  completion: Completion,
  toolParts: ToolParts
): Array<Response.AnyPart> => {
  const parts: Array<Response.AnyPart> = [];
  const meta = metadataPart(completion);
  if (meta !== undefined) parts.push(meta);
  for (const part of toolParts) parts.push(toolPart(part));
  if (completion.text.length > 0) {
    parts.push(Response.makePart("text", { text: completion.text }));
  }
  parts.push(
    Response.makePart("finish", {
      reason: completion.finishReason ?? "stop",
      usage: encodeUsage(completion.usage),
    })
  );
  return parts;
};

/** Pseudo-stream for a tool-enabled turn: tool parts, then the text stream parts. */
export const assembleStreamParts = (
  completion: Completion,
  toolParts: ToolParts
): Stream.Stream<Response.StreamPartEncoded> => {
  const id = completion.id ?? "0";
  const parts: Array<Response.StreamPartEncoded> = [];
  const meta = metadata(completion);
  if (meta !== undefined) parts.push(meta);
  for (const part of toolParts) parts.push(part);
  parts.push({ type: "text-start", id });
  if (completion.text.length > 0) parts.push({ type: "text-delta", id, delta: completion.text });
  parts.push({ type: "text-end", id });
  parts.push({
    type: "finish",
    reason: completion.finishReason ?? "stop",
    usage: encodeUsage(completion.usage),
  });
  return Stream.fromIterable(parts);
};
