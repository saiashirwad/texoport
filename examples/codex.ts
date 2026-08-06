import { LanguageModel } from "effect/unstable/ai"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { CodexLanguageModel } from "../src/index.ts"

const program = Effect.gen(function* () {
  const text = yield* LanguageModel.generateText({ prompt: "Reply with exactly: pong" })
  console.log("text:", text.text)

  const Person = Schema.Struct({ name: Schema.String, age: Schema.Number })
  const person = yield* LanguageModel.generateObject({
    prompt: "Invent a person named Ada who is 36.",
    schema: Person
  })
  console.log("object:", person.value)
}).pipe(Effect.provide(CodexLanguageModel.model()))

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
