import * as AiError from "@effect/ai/AiError"

/** Build a module-scoped UnknownError factory so call sites stay one line. */
export const unknownError =
  (module: string) =>
  (method: string, description: string, cause?: unknown): AiError.UnknownError =>
    new AiError.UnknownError({
      module,
      method,
      description,
      ...(cause !== undefined ? { cause } : {})
    })

/** Build a module-scoped MalformedOutput factory. */
export const malformedOutput =
  (module: string) =>
  (method: string, description: string, cause?: unknown): AiError.MalformedOutput =>
    new AiError.MalformedOutput({
      module,
      method,
      description,
      ...(cause !== undefined ? { cause } : {})
    })
