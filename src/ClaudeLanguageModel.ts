/**
 * `@effect/ai` LanguageModel over Claude Code subscription (Pro/Max):
 * - plain text/object: `claude -p`
 * - Effect toolkits: `claude -p` + local MCP bridge (same OAuth as the CLI)
 */
import type * as AiError from "@effect/ai/AiError"
import * as LanguageModel from "@effect/ai/LanguageModel"
import * as AiModel from "@effect/ai/Model"
import { CommandExecutor } from "@effect/platform"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import { runTurnWithTools } from "./internal/claudeAgent.ts"
import { buildClaudePrintArgs } from "./internal/claudeCli.ts"
import { parseClaudeCapture } from "./internal/claudeEnvelope.ts"
import { DEFAULT_TIMEOUT } from "./internal/defaults.ts"
import { flattenPrompt } from "./internal/prompt.ts"
import { type Completion, toParts, toStreamParts } from "./internal/response.ts"
import { runCli } from "./internal/spawn.ts"
import { makeToolkitService } from "./internal/toolkit.ts"

export interface Config {
  readonly model?: string | undefined
  readonly bin?: string | undefined
  readonly cwd?: string | undefined
  readonly timeout?: Duration.DurationInput | undefined
  readonly extraArgs?: ReadonlyArray<string> | undefined
  /** Log spawn/tool-call progress with timings and tee the CLI's stderr live. */
  readonly debug?: boolean | undefined
}

interface ResolvedConfig {
  readonly model?: string | undefined
  readonly bin: string
  readonly cwd?: string | undefined
  readonly timeout: Duration.Duration
  readonly extraArgs?: ReadonlyArray<string> | undefined
  readonly debug: boolean
}

const resolveConfig = (config: Config = {}): ResolvedConfig => ({
  ...(config.model !== undefined ? { model: config.model } : {}),
  bin: config.bin ?? "claude",
  ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
  timeout: Duration.decode(config.timeout ?? DEFAULT_TIMEOUT),
  ...(config.extraArgs !== undefined ? { extraArgs: config.extraArgs } : {}),
  debug: config.debug === true
})

export const model = (
  modelId?: string,
  config?: Omit<Config, "model">
): AiModel.Model<"claude", LanguageModel.LanguageModel, CommandExecutor.CommandExecutor> =>
  AiModel.make(
    "claude",
    layer({ ...config, ...(modelId !== undefined ? { model: modelId } : {}) })
  )

export const layer = (
  config: Config = {}
): Layer.Layer<LanguageModel.LanguageModel, never, CommandExecutor.CommandExecutor> =>
  Layer.effect(LanguageModel.LanguageModel, make(config))

export const make = (
  defaults: Config = {}
): Effect.Effect<LanguageModel.Service, never, CommandExecutor.CommandExecutor> =>
  Effect.gen(function*() {
    const executor = yield* CommandExecutor.CommandExecutor
    const config = resolveConfig(defaults)

    const base = yield* LanguageModel.make({
      generateText: (options) =>
        completeCli(options, config, "generateText").pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Effect.map(toParts)
        ),
      streamText: (options) =>
        Stream.unwrap(
          completeCli(options, config, "streamText").pipe(
            Effect.provideService(CommandExecutor.CommandExecutor, executor),
            Effect.map(toStreamParts)
          )
        )
    })

    // ResolvedConfig matches ClaudeAgentConfig — pass through, no field remap.
    return makeToolkitService(
      "ClaudeLanguageModel",
      base,
      (input) => runTurnWithTools({ ...input, config }),
      executor
    )
  })

// =============================================================================
// Plain `claude -p` path (no Effect toolkit)
// =============================================================================

const completeCli = (
  options: LanguageModel.ProviderOptions,
  config: ResolvedConfig,
  method: "generateText" | "streamText"
): Effect.Effect<Completion, AiError.AiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function*() {
    const { system, user } = flattenPrompt(options.prompt)
    // LanguageModel.make derives generateObject from generateText with a JSON
    // response format, so attribute errors accordingly.
    const effectiveMethod = options.responseFormat.type === "json" ? "generateObject" : method

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
