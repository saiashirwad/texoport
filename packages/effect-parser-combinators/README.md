# @texoport/effect-parser-combinators

Parser combinators for Effect that work on strings and `Stream<string>` input. A parser is an `Effect` that reads from `ParseState`, so it composes with `Effect.gen`, preserves typed failures, and can wait for more input when a token crosses a chunk boundary.

This is for parsers that need to live in an Effect program or parse incrementally. If all you need is the fastest possible parser for one complete string, [Parserator](https://github.com/saiashirwad/parserator) is a better fit.

## Install

```sh
pnpm add @texoport/effect-parser-combinators effect
```

## Parse a string

Use `parser.pipe(parse(input))` at the boundary. `parse` returns the parser's ordinary typed Effect failure, with `ParseError` enriched with its one-based line and column. Use `Effect.result` only when the calling boundary needs failures as data.

```ts
import { Effect } from "effect"
import { digit, endOfInput, many, parse } from "@texoport/effect-parser-combinators"

const byte = Effect.gen(function* () {
  const digits = yield* many(digit, { atLeast: 1 })
  return Number(digits.join(""))
})

const parser = Effect.gen(function* () {
  const value = yield* byte
  yield* endOfInput
  return value
})

const value = Effect.runSync(parser.pipe(parse("101")))
// 101
```

Most programs should use the built-in lexical parsers instead of repeating a character parser. They do one buffered scan, which matters on long inputs.

```ts
import { Effect } from "effect"
import {
  endOfInput,
  parse,
  string,
  takeWhileChar1,
} from "@texoport/effect-parser-combinators"

const assignment = Effect.gen(function* () {
  yield* string("count=")
  const value = yield* takeWhileChar1(
    (char) => char >= "0" && char <= "9",
    "digit",
  )
  yield* endOfInput
  return Number(value)
})

Effect.runSync(assignment.pipe(parse("count=42")))
```

## Parse a stream

`parseStream` pulls chunks only when a parser needs more input. `string`, `regex`, `takeWhileChar`, and `takeUntilChar` all handle a token split across chunks.

```ts
import { Effect, Stream } from "effect"
import {
  char,
  parseStream,
  takeUntilChar,
} from "@texoport/effect-parser-combinators"

const line = Effect.gen(function* () {
  const value = yield* takeUntilChar("\n")
  yield* char("\n")
  return value
})

const value = Effect.runSync(
  parseStream(Stream.fromIterable(["first", " line\nrest"]), line),
)
// "first line"
```

`streamElements(input, element)` runs an element parser repeatedly and releases consumed input after each successful element. The element parser must consume input.

## Consumption and backtracking

Choice is ordered. `or_(left, right)` tries `right` only when `left` fails without consuming input. Wrap a branch in `attempt` when failure should rewind it.

```ts
import { Effect } from "effect"
import { attempt, char, or_ } from "@texoport/effect-parser-combinators"

const ab = Effect.gen(function* () {
  yield* char("a")
  yield* char("b")
  return "ab"
})

const ac = Effect.gen(function* () {
  yield* char("a")
  yield* char("c")
  return "ac"
})

const parser = or_(attempt(ab), ac)
```

`many`, `manyUntil`, and `streamElements` reject an element parser that succeeds without moving the cursor. That failure catches loops that would otherwise never end.

## Core combinators

- Character and token parsers: `satisfy`, `char`, `digit`, `alphabet`, `anyChar`, `notChar`, `oneOfChars`, `string`, `anyOfStrings`, `regex`.
- Bulk scans: `takeWhileChar`, `takeWhileChar1`, `takeUntilChar`, `whitespace`, `skipWhitespace`.
- Structure: `many`, `manyUntil`, `count`, `between`, `sepBy`, `sepBy1`, `optional`, `lookAhead`, `notFollowedBy`, `or_`, `attempt`.
- Boundaries: `endOfInput`, `parse`, `parseStream`, `streamElements`.

`takeUntilChar` leaves its delimiter unread. Parse the delimiter next with `char`, as in the line example. If the delimiter never arrives, it consumes the rest of the input and returns a `ParseError`.

## Errors

Expected input failures use `ParseError`, which records the absolute input position, the expected value, and the character found. `parse` also attaches a one-based line and column. An upstream stream failure becomes `UpstreamError` and keeps the original cause.

Bad combinator arguments, such as `oneOfChars("")` or `count(digit, -1)`, return a failed Effect. The library does not throw configuration errors or turn parser contract failures into defects.

## Development

```sh
pnpm --filter @texoport/effect-parser-combinators typecheck
pnpm --filter @texoport/effect-parser-combinators test
pnpm --filter @texoport/effect-parser-combinators bench
```
