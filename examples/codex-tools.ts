/**
 * Effect toolkit via Codex app-server dynamic tools (subscription).
 *
 *   pnpm example:codex-tools
 */
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { CodexLanguageModel } from "../src/index.ts"

const GetWeather = Tool.make("get_weather", {
  description: "Get the current weather for a city",
  parameters: Schema.Struct({ city: Schema.String }),
  success: Schema.Struct({ city: Schema.String, tempC: Schema.Number, condition: Schema.String })
})

const WeatherToolkit = Toolkit.make(GetWeather)

const WeatherLive = WeatherToolkit.toLayer({
  get_weather: ({ city }) => Effect.succeed({ city, tempC: 18, condition: "cloudy" })
})

const program = Effect.gen(function* () {
  const response = yield* LanguageModel.generateText({
    prompt:
      "What is the weather in Paris? Use the get_weather tool. Then answer in one short sentence.",
    toolkit: WeatherToolkit
  })
  console.log("text:", response.text)
  console.log("toolCalls:", response.toolCalls.length)
  console.log("toolResults:", response.toolResults.length)
}).pipe(Effect.provide(CodexLanguageModel.model()), Effect.provide(WeatherLive))

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
