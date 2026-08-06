# effect-ai-subs

Effect AI `LanguageModel` providers that use your **local subscriptions** instead of API keys:

| Provider | Subscription | Text | Toolkits |
| --- | --- | --- | --- |
| `ClaudeLanguageModel` | Claude Code Pro / Max | `claude -p` | `claude -p` + MCP |
| `CodexLanguageModel` | ChatGPT Plus / Pro | `codex exec` | `codex app-server` |

## Install

```bash
pnpm add effect-ai-subs effect @effect/ai @effect/platform @effect/platform-node
```

Requires `claude` and/or `codex` on `PATH`, already logged in (`claude auth status` / `codex login`).

## Text

```ts
import { LanguageModel } from "@effect/ai"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { ClaudeLanguageModel } from "effect-ai-subs"

const program = Effect.gen(function* () {
  const text = yield* LanguageModel.generateText({
    prompt: "Write a one-line dad joke about TypeScript"
  })
  console.log(text.text)

  const Contact = Schema.Struct({
    name: Schema.String,
    email: Schema.String
  })
  const contact = yield* LanguageModel.generateObject({
    prompt: "Extract: Ada Lovelace, ada@example.com",
    schema: Contact
  })
  console.log(contact.value)
}).pipe(
  Effect.provide(ClaudeLanguageModel.model("sonnet"))
  // ChatGPT: Effect.provide(CodexLanguageModel.model())
)

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
```

## Tool calling

Same Effect `Toolkit` API as `@effect/ai-anthropic` / `@effect/ai-openai`. Handlers run in your process; the model calls them through the CLI.

```ts
import { LanguageModel, Tool, Toolkit } from "@effect/ai"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { ClaudeLanguageModel } from "effect-ai-subs"
// import { CodexLanguageModel } from "effect-ai-subs"

const GetWeather = Tool.make("get_weather", {
  description: "Get the current weather for a city",
  parameters: { city: Schema.String },
  success: Schema.Struct({
    city: Schema.String,
    tempC: Schema.Number,
    condition: Schema.String
  })
})

const WeatherToolkit = Toolkit.make(GetWeather)

const WeatherLive = WeatherToolkit.toLayer({
  get_weather: ({ city }) =>
    Effect.succeed({ city, tempC: 18, condition: "cloudy" })
})

const program = Effect.gen(function* () {
  const response = yield* LanguageModel.generateText({
    prompt: "What is the weather in Paris? Use get_weather, then answer in one sentence.",
    toolkit: WeatherToolkit
  })
  console.log(response.text)
  console.log(response.toolCalls)
  console.log(response.toolResults)
}).pipe(
  Effect.provide(ClaudeLanguageModel.model("sonnet")),
  // Effect.provide(CodexLanguageModel.model()),
  Effect.provide(WeatherLive)
)

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
```

Runnable copies: `examples/claude-tools.ts`, `examples/codex-tools.ts`.

## Options

```ts
ClaudeLanguageModel.model("sonnet", { timeout: "2 minutes" })
CodexLanguageModel.model(undefined, { sandbox: "read-only" })
```

| Option | Default | Notes |
| --- | --- | --- |
| `model` | CLI default | e.g. `sonnet`, or a Codex model id |
| `bin` | `claude` / `codex` | Binary path |
| `timeout` | `3 minutes` | Per-call |
| `sandbox` | `read-only` | Codex only |
| `cwd` | process cwd | Working directory |
| `extraArgs` | none | Additional CLI flags appended to the invocation |

## License

MIT
