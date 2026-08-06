import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Prompt } from "effect/unstable/ai"
import { flattenPrompt } from "../src/internal/prompt.ts"

describe("flattenPrompt", () => {
  it("keeps a single user message plain", () => {
    const prompt = Prompt.make("hello")
    const flat = flattenPrompt(prompt)
    assert.equal(flat.system, undefined)
    assert.equal(flat.user, "hello")
  })

  it("extracts system messages", () => {
    const prompt = Prompt.make([
      { role: "system", content: "Be terse." },
      { role: "user", content: [{ type: "text", text: "hi" }] }
    ])
    const flat = flattenPrompt(prompt)
    assert.equal(flat.system, "Be terse.")
    assert.equal(flat.user, "hi")
  })

  it("renders multi-turn history as a transcript", () => {
    const prompt = Prompt.make([
      { role: "user", content: [{ type: "text", text: "1+1?" }] },
      { role: "assistant", content: [{ type: "text", text: "2" }] },
      { role: "user", content: [{ type: "text", text: "times 3?" }] }
    ])
    const flat = flattenPrompt(prompt)
    assert.match(flat.user, /User: 1\+1\?/)
    assert.match(flat.user, /Assistant: 2/)
    assert.match(flat.user, /User: times 3\?/)
  })
})
