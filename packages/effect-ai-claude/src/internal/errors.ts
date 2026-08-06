import { AiError } from "effect/unstable/ai"

type ErrorFactory = (method: string, description: string, cause?: unknown) => AiError.AiError

const makeFactory =
  (reason: (description: string) => AiError.AiError["reason"]): ((module: string) => ErrorFactory) =>
  (module) =>
  (method, description, cause) =>
    AiError.make({
      module,
      method,
      reason: reason(
        cause === undefined ? description : `${description}: ${String(cause)}`
      )
    })

export const unknownError = makeFactory(
  (description) => new AiError.UnknownError({ description })
)

export const malformedOutput = makeFactory(
  (description) => new AiError.InvalidOutputError({ description })
)
