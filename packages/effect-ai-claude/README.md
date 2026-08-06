# @texoport/effect-ai-claude

Use your signed-in Claude Code subscription from an Effect AI program. It shells out to `claude`, so you need the CLI installed and logged in.

```sh
pnpm add @texoport/effect-ai-claude effect @effect/platform-node
```

```ts
import * as ClaudeLanguageModel from "@texoport/effect-ai-claude"

ClaudeLanguageModel.model("sonnet")
```
