# @texoport/effect-ai-claude

This lets an Effect AI program talk to the `claude` CLI that is already logged in on your machine. No Anthropic API key. No second account to wire up. It is a useful fit for local tools, personal projects, and anything else where Claude Code is already part of the setup.

It expects Claude Code Pro or Max, `claude` on `PATH`, and a working CLI login. Check that first:

```sh
claude auth status
```

## Install

```sh
pnpm add @texoport/effect-ai-claude effect@4.0.0-beta.104 @effect/platform-node@4.0.0-beta.104
```

## Ask Claude something

`model` gives Effect AI a normal `LanguageModel` layer. The rest of the program uses the same API as any other Effect provider.

```ts
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import * as ClaudeLanguageModel from "@texoport/effect-ai-claude"
import { Effect } from "effect"
import { LanguageModel } from "effect/unstable/ai"

const program = Effect.gen(function* () {
  const response = yield* LanguageModel.generateText({
    prompt: "Explain what a semaphore does in two sentences."
  })

  console.log(response.text)
}).pipe(
  Effect.provide(ClaudeLanguageModel.model("sonnet")),
  Effect.provide(NodeServices.layer)
)

NodeRuntime.runMain(program)
```

## Tools

Tool calls work through the normal Effect `Toolkit` API. This package starts a small local MCP bridge for the turn, so your tool handlers stay in the same Node process as your application. Claude sees them as MCP tools through `claude -p`.

## Configuration

```ts
ClaudeLanguageModel.model("sonnet", {
  timeout: "2 minutes",
  debug: true
})
```

`bin` points at a different Claude executable. `cwd` changes the CLI working directory. `extraArgs` passes flags through to `claude`. Calls time out after five minutes unless you set `timeout`. Set `debug` when you want spawn timing and Claude's stderr in your terminal.

## License

MIT
