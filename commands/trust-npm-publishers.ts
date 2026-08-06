import { Array, Console, Data, Effect, FileSystem, Path, Schema } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const PackageJson = Schema.Struct({
  name: Schema.String,
  private: Schema.optional(Schema.Boolean)
})

const repository = "saiashirwad/texoport"
const workflow = "release.yml"

export class TrustedPublisherSetupError extends Data.TaggedError("TrustedPublisherSetupError")<{
  readonly packageName: string
  readonly exitCode: number
}> {}

export const trustNpmPublishers = Command.make("trust-npm-publishers").pipe(
  Command.withHandler(
    Effect.fn(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const packagesDir = path.join(process.cwd(), "packages")
      const entries = yield* fs.readDirectory(packagesDir).pipe(Effect.orDie)
      const packages = yield* Effect.forEach(
        entries,
        Effect.fn(function* (entry) {
          const packageDir = path.join(packagesDir, entry)
          const info = yield* fs.stat(packageDir).pipe(Effect.orDie)
          if (info.type !== "Directory") return []

          const packageJson = yield* fs.readFileString(path.join(packageDir, "package.json")).pipe(
            Effect.orDie
          )
          const pkg = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PackageJson))(packageJson).pipe(
            Effect.orDie
          )
          return pkg.private === true ? [] : [pkg.name]
        }),
        { concurrency: "unbounded" }
      ).pipe(Effect.map(Array.flatten))

      yield* Effect.forEach(
        packages,
        Effect.fn(function* (name) {
          yield* Console.log(`Configuring npm trusted publishing for ${name}`)
          yield* ChildProcess.make({ stdout: "inherit", stderr: "inherit" })`npm trust github ${name} --repo ${repository} --file ${workflow} --allow-publish --yes`.pipe(
            (process) => spawner.exitCode(process),
            Effect.filterOrFail(
              (exitCode) => exitCode === 0,
              (exitCode) => new TrustedPublisherSetupError({ packageName: name, exitCode })
            )
          )
        })
      ).pipe(
        Effect.catchTag("TrustedPublisherSetupError", (error) =>
          Effect.gen(function* () {
            yield* Console.error(`npm did not configure trusted publishing for ${error.packageName}.`)
            yield* Console.error(
              "If you use a security key or passkey for npm two-factor authentication, finish this one-time setup in npm's web UI instead:"
            )
            yield* Console.error(`  https://www.npmjs.com/package/${error.packageName}`)
            yield* Console.error("  Settings > Trusted publisher > GitHub Actions")
            yield* Console.error(`  Owner: saiashirwad | Repository: texoport | Workflow: ${workflow} | Allow npm publish`)
            yield* Effect.sync(() => {
              process.exitCode = 1
            })
          })
        )
      )
    })
  )
)
