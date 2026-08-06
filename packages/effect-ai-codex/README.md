# @texoport/effect-ai-codex

Use your signed-in ChatGPT Codex subscription from an Effect AI program. It shells out to `codex`, so you need the CLI installed and logged in.

```sh
pnpm add @texoport/effect-ai-codex effect @effect/platform-node
```

```ts
import * as CodexLanguageModel from "@texoport/effect-ai-codex"

CodexLanguageModel.model()
```
