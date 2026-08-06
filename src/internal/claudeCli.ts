/**
 * Shared `claude -p` argv construction for the plain CLI path and the MCP tool path.
 */
import type * as LanguageModel from "@effect/ai/LanguageModel"
import { schemaAstToJsonSchemaArg } from "./schema.ts"

export interface ClaudePrintArgsInput {
  readonly model?: string | undefined
  readonly system?: string | undefined
  readonly responseFormat: LanguageModel.ProviderOptions["responseFormat"]
  readonly extraArgs?: ReadonlyArray<string> | undefined
  /** When set, enables the MCP bridge flags for Effect toolkits. */
  readonly mcp?: {
    readonly configJson: string
    readonly allowedTools: string
  } | undefined
}

/** Build argv for `claude -p --output-format json` (optionally with MCP tools). */
export const buildClaudePrintArgs = (input: ClaudePrintArgsInput): Array<string> => {
  const args = ["-p", "--output-format", "json", "--tools", ""]

  if (input.mcp !== undefined) {
    args.push(
      "--permission-mode",
      "bypassPermissions",
      "--strict-mcp-config",
      "--mcp-config",
      input.mcp.configJson,
      "--allowedTools",
      input.mcp.allowedTools
    )
  }

  if (input.model !== undefined) args.push("--model", input.model)
  if (input.system !== undefined) args.push("--system-prompt", input.system)
  if (input.responseFormat.type === "json") {
    args.push("--json-schema", schemaAstToJsonSchemaArg(input.responseFormat.schema.ast))
  }
  if (input.extraArgs !== undefined) args.push(...input.extraArgs)

  return args
}
