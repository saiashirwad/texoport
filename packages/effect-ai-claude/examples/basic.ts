import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as ClaudeLanguageModel from "../src/index.ts"
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"

const program = Effect.gen(function*() {
  const response = yield* LanguageModel.generateText({
    prompt: "Explain what a semaphore does in two sentences."
  })

  console.log(response.text)
}).pipe(
  Effect.provide(ClaudeLanguageModel.model("sonnet")),
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program)
