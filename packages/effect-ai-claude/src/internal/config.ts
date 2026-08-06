import * as Duration from "effect/Duration"

/**
 * Must exceed the CLIs' own failure budget: `claude` retries a dead API
 * connection for ~180s before exiting 1 with a JSON error envelope. A shorter
 * timeout masks that envelope with a generic "timed out" error.
 */
export const DEFAULT_TIMEOUT = "5 minutes" as const

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
 * Drop undefined optionals. Under exactOptionalPropertyTypes, spreading
 * `model: undefined` still places the key and breaks assignability.
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

export const resolveBase = (config: BaseConfig, defaultBin: string): ResolvedBase => ({
  ...defined({
    model: config.model,
    cwd: config.cwd,
    extraArgs: config.extraArgs
  }),
  bin: config.bin ?? defaultBin,
  timeout: Duration.fromInputUnsafe(config.timeout ?? DEFAULT_TIMEOUT)
})

/** LanguageModel.make derives generateObject/streamObject from the text methods with a JSON format. */
export const methodForFormat = (
  responseFormat: { readonly type: string },
  method: "generateText" | "streamText"
): "generateText" | "generateObject" | "streamText" | "streamObject" =>
  responseFormat.type === "json"
    ? method === "streamText" ? "streamObject" : "generateObject"
    : method
