import * as AiError from "@effect/ai/AiError"

type AiErrorCtor<E> = new (args: {
  readonly module: string
  readonly method: string
  readonly description: string
  readonly cause?: unknown
}) => E

const errorFactory =
  <E>(Ctor: AiErrorCtor<E>) =>
  (module: string) =>
  (method: string, description: string, cause?: unknown): E =>
    new Ctor({
      module,
      method,
      description,
      ...(cause !== undefined ? { cause } : {})
    })

/** Build a module-scoped UnknownError factory so call sites stay one line. */
export const unknownError = errorFactory(AiError.UnknownError)

/** Build a module-scoped MalformedOutput factory. */
export const malformedOutput = errorFactory(AiError.MalformedOutput)
