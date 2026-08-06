import { Console, Effect, FileSystem, Path, Schema, Array } from "effect"
import { Command } from "effect/unstable/cli"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

const PackageJson = Schema.Struct({
  name: Schema.String,
  private: Schema.optional(Schema.Boolean)
})

const repository = "saiashirwad/texoport"
const workflow = "release.yml"

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
          yield* ChildProcess.make`npm trust github ${name} --repo ${repository} --file ${workflow} --allow-publish --yes`.pipe(
            (process) => spawner.exitCode(process),
            Effect.filterOrFail(
              (exitCode) => exitCode === 0,
              () => new Error(`Failed to configure trusted publishing for ${name}`)
            ),
            Effect.orDie
          )
        })
      )
    })
  )
)
