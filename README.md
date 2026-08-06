# effect-ai-subs

`@effect/ai` `LanguageModel` providers that bill your local coding-agent subscriptions — no API keys.

| Provider              | CLI          | Subscription               |
| --------------------- | ------------ | -------------------------- |
| `ClaudeLanguageModel` | `claude -p`  | Claude Code Pro / Max      |
| `CodexLanguageModel`  | `codex exec` | ChatGPT Plus / Pro (Codex) |

## Install

```bash
pnpm add effect-ai-subs effect @effect/ai @effect/platform @effect/platform-node
```

Need `claude` and/or `codex` on `PATH`, already logged in.

## Usage

```ts
import { LanguageModel } from "@effect/ai";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import { ClaudeLanguageModel } from "effect-ai-subs";

const program = Effect.gen(function* () {
  const joke = yield* LanguageModel.generateText({
    prompt: "Tell me a one-line dad joke about TypeScript",
  });
  console.log(joke.text);

  const Contact = Schema.Struct({
    name: Schema.String,
    email: Schema.String,
  });
  const contact = yield* LanguageModel.generateObject({
    prompt: "Extract: Ada Lovelace, ada@example.com",
    schema: Contact,
  });
  console.log(contact.value);
}).pipe(Effect.provide(ClaudeLanguageModel.model("sonnet")));

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)));
```

ChatGPT / Codex:

```ts
import { CodexLanguageModel } from "effect-ai-subs";

Effect.provide(CodexLanguageModel.model());
```

### Options

```ts
ClaudeLanguageModel.model("sonnet", { timeout: "2 minutes", bin: "claude" });
CodexLanguageModel.layer({ sandbox: "read-only", model: "..." });
```

| Option      | Default                | Notes                   |
| ----------- | ---------------------- | ----------------------- |
| `model`     | CLI default            | Alias or full model id  |
| `bin`       | `"claude"` / `"codex"` | Binary path             |
| `cwd`       | process cwd            | Child working directory |
| `timeout`   | `3 minutes`            | Per-call kill switch    |
| `sandbox`   | `"read-only"`          | Codex only              |
| `extraArgs` | —                      | Extra CLI flags         |

Claude always runs with `--tools ""` (pure completion, not the coding agent).

### Scope

| Feature             | Status                           |
| ------------------- | -------------------------------- |
| `generateText`      | yes                              |
| `generateObject`    | yes                              |
| `streamText`        | pseudo-stream of the full result |
| Effect toolkits     | no — use official API providers  |
| Embeddings / images | no                               |

## Notes

Personal use of _your_ subscription via the official CLIs. Provider ToS and billing for headless / Agent SDK usage can change; this adapter does not bypass that.

## Dev

```bash
pnpm typecheck && pnpm test
pnpm example:claude
pnpm example:codex
```

## License

MIT
