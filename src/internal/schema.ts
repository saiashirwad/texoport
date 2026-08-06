import * as Tool from "@effect/ai/Tool"
import * as Either from "effect/Either"
import * as Schema from "effect/Schema"
import type { AST as SchemaAST } from "effect/SchemaAST"

const JsonObject = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const asObject = Schema.decodeUnknownEither(JsonObject)

/**
 * Effect JSONSchema sometimes emits a bare root `$ref` + `$defs`.
 * Claude's `--json-schema` wants a top-level `type` — inline that root.
 */
export const hoistRootRef = (root: unknown): unknown => {
  const node = asObject(root)
  if (Either.isLeft(node)) return root

  const ref = node.right["$ref"]
  if (typeof ref !== "string" || !ref.startsWith("#/$defs/")) return root

  const defs = asObject(node.right["$defs"])
  if (Either.isLeft(defs)) return root

  const target = asObject(defs.right[ref.slice("#/$defs/".length)])
  if (Either.isLeft(target)) return root

  const { $ref: _, ...rest } = node.right
  return { ...rest, ...target.right, $defs: defs.right }
}

export const schemaAstToJsonSchemaArg = (ast: SchemaAST): string =>
  JSON.stringify(hoistRootRef(Tool.getJsonSchemaFromSchemaAst(ast)))
