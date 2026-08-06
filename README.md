# effect-ai-subs

Effect `LanguageModel` providers that call the CLIs you already pay for. No API keys. You need a Claude Code Pro/Max or ChatGPT Plus/Pro subscription, with `claude` or `codex` on `PATH` and logged in.

| Provider | Subscription | Text | Toolkits |
| --- | --- | --- | --- |
| `ClaudeLanguageModel` | Claude Code Pro / Max | `claude -p` | `claude -p` + MCP |
| `CodexLanguageModel` | ChatGPT Plus / Pro | `codex exec` | `codex app-server` |

Targets Effect v4 (`effect@4.0.0-beta.*`). The AI modules sit under `effect/unstable/ai`.

## Install

```bash
pnpm add effect-ai-subs effect@^4.0.0-beta.104 @effect/platform-node@^4.0.0-beta.104
```

Confirm the CLI is signed in before you run anything: `claude auth status` or `codex login`.

## Text

```ts
import { LanguageModel } from "effect/unstable/ai"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
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

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
```

## Tool calling

Same `Toolkit` API as Effect's other AI providers. Your handlers run in-process. The model reaches them through the CLI (MCP for Claude, app-server for Codex).

```ts
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import { ClaudeLanguageModel } from "effect-ai-subs"
// import { CodexLanguageModel } from "effect-ai-subs"

const GetWeather = Tool.make("get_weather", {
  description: "Get the current weather for a city",
  parameters: Schema.Struct({ city: Schema.String }),
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

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
```

Full scripts live in `examples/claude-tools.ts` and `examples/codex-tools.ts`.

## Options

```ts
ClaudeLanguageModel.model("sonnet", { timeout: "2 minutes" })
CodexLanguageModel.model(undefined, { sandbox: "read-only" })
```

| Option | Default | Notes |
| --- | --- | --- |
| `model` | CLI default | e.g. `sonnet`, or a Codex model id |
| `bin` | `claude` / `codex` | Binary path |
| `timeout` | `3 minutes` | Per call |
| `sandbox` | `read-only` | Codex only |
| `cwd` | process cwd | Working directory |
| `extraArgs` | none | Extra flags passed straight to the CLI |
| `debug` | `false` | Claude only: spawn and tool-call timings, plus live CLI stderr |

## License

MIT
