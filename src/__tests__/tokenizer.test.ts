import { describe, it, expect, beforeEach } from 'vitest'
import { countTokens, clearCache } from '../tokenizer'

describe('countTokens', () => {
  beforeEach(() => clearCache())

  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0)
  })

  it('counts ASCII text', () => {
    const n = countTokens('Hello world, this is a test of the tokenizer.')
    expect(n).toBeGreaterThan(5)
    expect(n).toBeLessThan(20)
  })

  it('counts unicode text', () => {
    const n = countTokens('Olá mundo — refatoração 日本語')
    expect(n).toBeGreaterThan(0)
  })

  it('counts code blocks', () => {
    const code = '```ts\nconst x: number = 42\nfunction foo() { return x }\n```'
    const n = countTokens(code)
    expect(n).toBeGreaterThan(10)
  })

  it('caches repeated calls', () => {
    const text = 'cache me please'
    const a = countTokens(text)
    const b = countTokens(text)
    expect(a).toBe(b)
  })

  it('produces stable counts for identical input', () => {
    expect(countTokens('same input')).toBe(countTokens('same input'))
  })

  it('scales with text size', () => {
    const small = countTokens('one two three')
    const large = countTokens('one two three '.repeat(100))
    expect(large).toBeGreaterThan(small * 50)
  })
})
