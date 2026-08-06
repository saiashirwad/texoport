# @texoport/effect-ai-codex

This lets an Effect AI program use the `codex` CLI that is already logged in on your machine. It uses your existing ChatGPT Codex session, so there is no OpenAI API key to set up alongside it.

You need ChatGPT Plus or Pro, `codex` on `PATH`, and an active login:

```sh
codex login
```

## Install

```sh
pnpm add @texoport/effect-ai-codex effect@4.0.0-beta.104 @effect/platform-node@4.0.0-beta.104
```

## Ask Codex something

`model` gives Effect AI a normal `LanguageModel` layer. Your application talks to `LanguageModel` and this package runs `codex exec` underneath.

The repository has this as a runnable example. From the repository root, run:

```sh
pnpm --filter @texoport/effect-ai-codex example
```

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as CodexLanguageModel from "@texoport/effect-ai-codex"
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"

const program = Effect.gen(function* () {
  const response = yield* LanguageModel.generateText({
    prompt: "Explain what a semaphore does in two sentences."
  })

  console.log(response.text)
}).pipe(
  Effect.provide(CodexLanguageModel.model()),
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program)
```

## Tools and sandboxing

Tool calls use Codex's app server, while plain text calls use `codex exec`. Your Effect `Toolkit` handlers run in your Node process. The Codex sandbox defaults to `read-only`, which is the sensible default for a library call. Choose a broader sandbox only when the model needs it.

```ts
CodexLanguageModel.model(undefined, {
  sandbox: "workspace-write"
})
```

## Configuration

`bin` points at a different Codex executable. `cwd` changes the CLI working directory. `timeout` defaults to five minutes. `extraArgs` passes flags through to Codex.

## License

MIT
