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
import { parseClaudeCapture } from "./internal/claudeEnvelope.ts"
import { flattenPrompt } from "./internal/prompt.ts"
import { type Completion, toParts, toStreamParts } from "./internal/response.ts"
import { schemaAstToJsonSchemaArg } from "./internal/schema.ts"
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
    const timeout = Duration.decode(defaults.timeout ?? "3 minutes")

    const base = yield* LanguageModel.make({
      generateText: (options) =>
        completeCli(options, defaults, "generateText").pipe(
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
          Effect.map(toParts)
        ),
      streamText: (options) =>
        Stream.unwrap(
          completeCli(options, defaults, "streamText").pipe(
            Effect.provideService(CommandExecutor.CommandExecutor, executor),
            Effect.map(toStreamParts)
          )
        )
    })

    return makeToolkitService(
      "ClaudeLanguageModel",
      base,
      (input) =>
        runTurnWithTools({
          ...input,
          config: {
            model: defaults.model,
            cwd: defaults.cwd,
            pathToClaude: defaults.bin,
            timeout,
            debug: defaults.debug
          }
        }),
      executor
    )
  })

// =============================================================================
// Plain `claude -p` path (no Effect toolkit)
// =============================================================================

const completeCli = (
  options: LanguageModel.ProviderOptions,
  defaults: Config,
  method: "generateText" | "streamText"
): Effect.Effect<Completion, AiError.AiError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function*() {
    const { system, user } = flattenPrompt(options.prompt)
    const timeout = Duration.decode(defaults.timeout ?? "3 minutes")
    // LanguageModel.make derives generateObject from generateText with a JSON
    // response format, so attribute errors accordingly.
    const effectiveMethod = options.responseFormat.type === "json" ? "generateObject" : method
    const args = ["-p", "--output-format", "json", "--tools", ""]

    if (defaults.model !== undefined) args.push("--model", defaults.model)
    if (system !== undefined) args.push("--system-prompt", system)
    if (options.responseFormat.type === "json") {
      args.push("--json-schema", schemaAstToJsonSchemaArg(options.responseFormat.schema.ast))
    }
    if (defaults.extraArgs !== undefined) args.push(...defaults.extraArgs)

    const startedAt = Date.now()
    const capture = yield* runCli({
      command: defaults.bin ?? "claude",
      args,
      stdin: user,
      cwd: defaults.cwd,
      module: "ClaudeLanguageModel",
      method: effectiveMethod,
      timeout,
      onStderr: defaults.debug === true ? (chunk) => process.stderr.write(chunk) : undefined
    })
    if (defaults.debug === true) {
      console.error(`[claude] exited ${capture.exitCode} after ${Date.now() - startedAt}ms`)
    }

    return yield* parseClaudeCapture(capture, effectiveMethod)
  })
