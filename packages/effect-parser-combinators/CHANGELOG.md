# @texoport/effect-parser-combinators

## 0.3.0

### Minor Changes

- 6a219fd: Make `parse` parser-first and pipeable, and preserve parse failures as typed Effect errors.

## 0.2.1

### Patch Changes

- Publish the package README with usage examples for string and streaming parsers.

## 0.2.0

### Minor Changes

- 5099c5f: Add bulk token, delimiter, lookahead, and list parser combinators with streaming support. Invalid parser configuration now fails through the Effect error channel instead of throwing.

## 0.1.0

### Minor Changes

- d4e8e32: Add parse-only Effect parser combinators.
