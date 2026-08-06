import { AiError } from "effect/unstable/ai"

const describe = (description: string, cause?: unknown): string =>
  cause === undefined ? description : `${description}: ${String(cause)}`

type ErrorFactory = (method: string, description: string, cause?: unknown) => AiError.AiError

const makeFactory =
  (reason: (description: string) => AiError.AiError["reason"]): ((module: string) => ErrorFactory) =>
  (module) =>
  (method, description, cause) =>
    AiError.make({ module, method, reason: reason(describe(description, cause)) })

/** Build a module-scoped UnknownError factory so call sites stay one line. */
export const unknownError = makeFactory(
  (description) => new AiError.UnknownError({ description })
)

/** Build a module-scoped InvalidOutputError factory. */
export const malformedOutput = makeFactory(
  (description) => new AiError.InvalidOutputError({ description })
)
