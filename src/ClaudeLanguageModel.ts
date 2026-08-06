import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { type AiError, LanguageModel, Model as AiModel } from "effect/unstable/ai"
import { ChildProcessSpawner } from "effect/unstable/process"
import {
  type ClaudeAgentConfig,
  runTurnWithTools
} from "./internal/claudeAgent.ts"
import { buildClaudePrintArgs } from "./internal/claudeCli.ts"
import { parseClaudeCapture } from "./internal/claudeEnvelope.ts"
import {
  type BaseConfig,
  defined,
  methodForFormat,
  resolveBase
} from "./internal/config.ts"
import { makeProviderService } from "./internal/provider.ts"
import { flattenPrompt } from "./internal/prompt.ts"
import type { Completion } from "./internal/response.ts"
import { provideSpawner, runCli } from "./internal/spawn.ts"

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
      (options, method) => provideSpawner(completeCli(options, config, method), spawner),
      (input) => runTurnWithTools({ ...input, config })
    )
  })

const completeCli = (
  options: LanguageModel.ProviderOptions,
  config: ClaudeAgentConfig,
  method: "generateText" | "streamText"
): Effect.Effect<Completion, AiError.AiError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const { system, user } = flattenPrompt(options.prompt)
    const effectiveMethod = methodForFormat(options.responseFormat, method)

    const startedAt = Date.now()
    const capture = yield* runCli({
      command: config.bin,
      args: buildClaudePrintArgs({
        model: config.model,
        system,
        responseFormat: options.responseFormat,
        extraArgs: config.extraArgs
      }),
      stdin: user,
      cwd: config.cwd,
      module: "ClaudeLanguageModel",
      method: effectiveMethod,
      timeout: config.timeout,
      onStderr: config.debug ? (chunk) => process.stderr.write(chunk) : undefined
    })
    if (config.debug) {
      console.error(`[claude] exited ${capture.exitCode} after ${Date.now() - startedAt}ms`)
    }

    return yield* parseClaudeCapture(capture, effectiveMethod)
  })
