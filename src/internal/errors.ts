import { AiError } from "effect/unstable/ai"

/** Build a module-scoped UnknownError factory so call sites stay one line. */
export const unknownError =
  (module: string) =>
  (method: string, description: string, cause?: unknown): AiError.AiError =>
    AiError.make({
      module,
      method,
      reason: new AiError.UnknownError({
        description: cause === undefined ? description : `${description}: ${String(cause)}`
      })
    })

/** Build a module-scoped InvalidOutputError factory. */
export const malformedOutput =
  (module: string) =>
  (method: string, description: string, cause?: unknown): AiError.AiError =>
    AiError.make({
      module,
      method,
      reason: new AiError.InvalidOutputError({
        description: cause === undefined ? description : `${description}: ${String(cause)}`
      })
    })
