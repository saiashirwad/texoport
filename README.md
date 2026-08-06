# effect-ai-subs

Effect AI `LanguageModel` over your **Claude Code** / **ChatGPT Codex** subscriptions (local CLIs, no API keys).

| | Claude | Codex |
| --- | --- | --- |
| Text / object | `claude -p` | `codex exec` |
| Toolkits | `claude -p` + MCP | `codex app-server` |

```bash
pnpm add effect-ai-subs effect @effect/ai @effect/platform @effect/platform-node
# need `claude` and/or `codex` on PATH, already logged in
```

```ts
import { LanguageModel } from "@effect/ai"
import { NodeContext, NodeRuntime } from "@effect/platform-node"
import { Effect } from "effect"
import { ClaudeLanguageModel, CodexLanguageModel } from "effect-ai-subs"

const program = LanguageModel.generateText({ prompt: "hi" }).pipe(
  Effect.provide(ClaudeLanguageModel.model("sonnet"))
  // or: Effect.provide(CodexLanguageModel.model())
)

NodeRuntime.runMain(program.pipe(Effect.provide(NodeContext.layer)))
```

Toolkits: pass `toolkit` like normal Effect AI; see `examples/claude-tools.ts` / `examples/codex-tools.ts`.

MIT
