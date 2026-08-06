import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { LanguageModel, Model as AiModel } from "effect/unstable/ai"
import { ChildProcessSpawner } from "effect/unstable/process"
import { runTurnWithTools } from "./internal/claudeAgent.ts"
import {
  type ClaudeAgentConfig,
  runClaudePrint
} from "./internal/claudePrint.ts"
import { type BaseConfig, defined, methodForFormat, resolveBase } from "./internal/config.ts"
import { makeProviderService } from "./internal/provider.ts"
import { provideSpawner } from "./internal/spawn.ts"

export interface Config extends BaseConfig {
  /** Log spawn/tool-call progress with timings and tee the CLI's stderr live. */
  readonly debug?: boolean | undefined
}

const resolveConfig = (config: Config = {}): ClaudeAgentConfig => ({
  ...resolveBase(config, "claude"),
  debug: config.debug === true
})

export const model = (
  modelId?: string,
  config?: Omit<Config, "model">
): AiModel.Model<"claude", LanguageModel.LanguageModel, ChildProcessSpawner.ChildProcessSpawner> =>
  AiModel.make(
    "claude",
    modelId ?? "default",
    layer({ ...config, ...defined({ model: modelId }) })
  )

export const layer = (
  config: Config = {}
): Layer.Layer<LanguageModel.LanguageModel, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(LanguageModel.LanguageModel, make(config))

export const make = (
  defaults: Config = {}
): Effect.Effect<LanguageModel.Service, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const config = resolveConfig(defaults)

    return yield* makeProviderService(
      "ClaudeLanguageModel",
      spawner,
      (options, method) =>
        provideSpawner(
          runClaudePrint(config, {
            prompt: options.prompt,
            responseFormat: options.responseFormat,
            method: methodForFormat(options.responseFormat, method)
          }),
          spawner
        ),
      (input) => runTurnWithTools({ ...input, config })
    )
  })
