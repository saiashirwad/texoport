import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Command } from "effect/unstable/cli"

import { trustNpmPublishers } from "./commands/trust-npm-publishers.ts"

await Command.make("texoport").pipe(
  Command.withSubcommands([trustNpmPublishers]),
  Command.run({ version: "internal" }),
  Effect.provide(NodeServices.layer),
  Effect.runPromise
)
