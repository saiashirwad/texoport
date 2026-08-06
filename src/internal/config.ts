/**
 * Shared CLI-provider config: optional-field helpers for exactOptionalPropertyTypes,
 * and the common resolved shape both providers build on.
 */
import * as Duration from "effect/Duration"

/** Shared defaults for CLI-backed providers. */
export const DEFAULT_TIMEOUT = "3 minutes" as const

export interface BaseConfig {
  readonly model?: string | undefined
  readonly bin?: string | undefined
  readonly cwd?: string | undefined
  readonly timeout?: Duration.Input | undefined
  readonly extraArgs?: ReadonlyArray<string> | undefined
}

export interface ResolvedBase {
  readonly model?: string | undefined
  readonly bin: string
  readonly cwd?: string | undefined
  readonly timeout: Duration.Duration
  readonly extraArgs?: ReadonlyArray<string> | undefined
}

/**
 * Keep only defined optional keys. Required under exactOptionalPropertyTypes:
 * spreading `model: undefined` would still place the key and break assignability.
 */
export const defined = <T extends object>(
  fields: { readonly [K in keyof T]?: T[K] | undefined }
): { readonly [K in keyof T]?: Exclude<T[K], undefined> } => {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(fields) as Array<keyof T>) {
    const value = fields[key]
    if (value !== undefined) out[key as string] = value
  }
  return out as { readonly [K in keyof T]?: Exclude<T[K], undefined> }
}

/** Resolve shared bin/cwd/timeout/model/extraArgs with a provider default binary name. */
export const resolveBase = (config: BaseConfig, defaultBin: string): ResolvedBase => ({
  ...defined({
    model: config.model,
    cwd: config.cwd,
    extraArgs: config.extraArgs
  }),
  bin: config.bin ?? defaultBin,
  timeout: Duration.fromInputUnsafe(config.timeout ?? DEFAULT_TIMEOUT)
})

/** LanguageModel.make derives generateObject from generateText with a JSON format. */
export const methodForFormat = (
  responseFormat: { readonly type: string },
  method: "generateText" | "streamText"
): "generateText" | "generateObject" | "streamText" =>
  responseFormat.type === "json" ? "generateObject" : method
