import { performance } from "node:perf_hooks"
import { Effect } from "effect"
import { char, digit, many, parse, string, takeUntilChar, takeWhileChar1 } from "../src/index.ts"

const iterations = 250
const digits = "1234567890".repeat(1_000)
const word = "parser-combinators".repeat(1_000)

const run = <A>(input: string, parser: Effect.Effect<A, unknown, never>) =>
  Effect.runSync(parse(input, parser))

const measure = (name: string, f: () => unknown) => {
  for (let i = 0; i < 20; i++) f()
  const start = performance.now()
  for (let i = 0; i < iterations; i++) f()
  const elapsed = performance.now() - start
  console.log(`${name}: ${(elapsed / iterations).toFixed(3)} ms/run`)
}

measure("many(digit)", () => run(digits, many(digit, { atLeast: 1 })))
measure("takeWhileChar1(digit)", () =>
  run(digits, takeWhileChar1((char) => char >= "0" && char <= "9", "digit")),
)
measure("many(char) exact string", () =>
  run(word, Effect.all([...word].map((character) => char(character)))),
)
measure("string exact string", () => run(word, string(word)))
measure("takeUntilChar", () => run(`${word}|`, takeUntilChar("|")))
