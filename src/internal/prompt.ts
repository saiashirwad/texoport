import type { Prompt } from "effect/unstable/ai"

export interface FlattenedPrompt {
  readonly system: string | undefined
  readonly user: string
}

const textParts = (parts: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  parts.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("")

/** Collapse an Effect AI prompt into system + user text for one-shot CLI print mode. */
export const flattenPrompt = (prompt: Prompt.Prompt): FlattenedPrompt => {
  const systems: Array<string> = []
  const turns: Array<string> = []

  for (const message of prompt.content) {
    switch (message.role) {
      case "system":
        systems.push(message.content)
        break
      case "user":
        turns.push(`User: ${textParts(message.content)}`)
        break
      case "assistant":
        turns.push(`Assistant: ${textParts(message.content)}`)
        break
      case "tool":
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          turns.push(
            `Tool result (${part.name}): ${
              typeof part.result === "string" ? part.result : JSON.stringify(part.result)
            }`
          )
        }
        break
    }
  }

  const user = turns.length === 0
    ? " "
    : turns.length === 1 && turns[0]!.startsWith("User: ")
    ? turns[0]!.slice(6)
    : turns.join("\n\n")

  return {
    system: systems.length > 0 ? systems.join("\n\n") : undefined,
    user
  }
}
