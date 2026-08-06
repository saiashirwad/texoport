export interface CodexExecArgsInput {
  readonly model?: string | undefined
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access"
  readonly extraArgs?: ReadonlyArray<string> | undefined
  readonly outputSchemaPath?: string | undefined
  readonly promptText: string
}

export const buildCodexExecArgs = (input: CodexExecArgsInput): Array<string> => {
  const args = [
    "exec",
    "--json",
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    input.sandbox,
    "--color",
    "never"
  ]

  if (input.model !== undefined) args.push("--model", input.model)
  if (input.extraArgs !== undefined) args.push(...input.extraArgs)
  if (input.outputSchemaPath !== undefined) {
    args.push("--output-schema", input.outputSchemaPath)
  }
  args.push(input.promptText)
  return args
}
