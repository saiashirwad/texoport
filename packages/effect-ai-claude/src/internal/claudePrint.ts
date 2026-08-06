/**
 * Shared `claude -p` one-shot: flatten prompt, spawn, capture, parse envelope.
 * Used by both the plain provider path and the MCP tool-loop path.
 */
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type { AiError, LanguageModel, Prompt } from "effect/unstable/ai"
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { buildClaudePrintArgs, type ClaudeMcpArg } from "./claudeCli.ts"
import { parseClaudeCapture } from "./claudeEnvelope.ts"
import { flattenPrompt } from "./prompt.ts"
import type { Completion } from "./response.ts"
import { runCli } from "./spawn.ts"

export interface ClaudeAgentConfig {
  readonly model?: string | undefined
  readonly bin: string
  readonly cwd?: string | undefined
  readonly timeout: Duration.Duration
  readonly debug: boolean
  readonly extraArgs?: ReadonlyArray<string> | undefined
}

export interface ClaudePrintInput {
  readonly prompt: Prompt.Prompt
  readonly responseFormat: LanguageModel.ProviderOptions["responseFormat"]
  /** Method label for error reporting (e.g. "generateText", "generateObject"). */
  readonly method: string
  readonly mcp?: ClaudeMcpArg | undefined
}

export const runClaudePrint = (
  config: ClaudeAgentConfig,
  input: ClaudePrintInput
): Effect.Effect<Completion, AiError.AiError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function*() {
    const { system, user } = flattenPrompt(input.prompt)

    const startedAt = Date.now()
    const capture = yield* runCli({
      command: config.bin,
      args: buildClaudePrintArgs({
        model: config.model,
        system,
        responseFormat: input.responseFormat,
        extraArgs: config.extraArgs,
        mcp: input.mcp
      }),
      stdin: user,
      cwd: config.cwd,
      module: "ClaudeLanguageModel",
      method: input.method,
      timeout: config.timeout,
      onStderr: config.debug ? (chunk) => process.stderr.write(chunk) : undefined
    })
    if (config.debug) {
      console.error(`[claude] exited ${capture.exitCode} after ${Date.now() - startedAt}ms`)
    }

    return yield* parseClaudeCapture(capture, input.method)
  })
