import { LanguageModel } from "@effect/ai"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { CodexLanguageModel } from "../src/index.ts"

const program = Effect.gen(function*() {
  const text = yield* LanguageModel.generateText({ prompt: "Reply with exactly: pong" })
  console.log("text:", text.text)
  console.log("usage:", text.usage)
}).pipe(Effect.provide(CodexLanguageModel.model()))

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
