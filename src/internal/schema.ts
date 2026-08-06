import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { Tool } from "effect/unstable/ai"

const JsonObject = Schema.Record(Schema.String, Schema.Unknown)
const asObject = Schema.decodeUnknownResult(JsonObject)

/**
 * Effect JSONSchema sometimes emits a bare root `$ref` + `$defs`.
 * Claude's `--json-schema` wants a top-level `type` — inline that root.
 */
export const hoistRootRef = (root: unknown): unknown => {
  const node = asObject(root)
  if (Result.isFailure(node)) return root

  const ref = node.success["$ref"]
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return root

  const defs = asObject(node.success["$defs"])
  if (Result.isFailure(defs)) return root

  const target = asObject(defs.success[ref.slice("#/$defs/".length)])
  if (Result.isFailure(target)) return root

  const { $ref: _, ...rest } = node.success
  return { ...rest, ...target.success, $defs: defs.success }
}

/** Convert an Effect Schema into a JSON Schema string for CLI flags / app-server. */
export const schemaToJsonSchemaArg = (schema: Schema.Top): string =>
  JSON.stringify(hoistRootRef(Tool.getJsonSchemaFromSchema(schema as Schema.Constraint)))
