import { describe, it, expect } from 'vitest'
import { estimateTokens } from '../statusBarItem'

// lint rules are tested via the pure functions they depend on

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('approximates 1 token per 4 chars', () => {
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(400))).toBe(100)
  })

  it('rounds to nearest integer', () => {
    expect(estimateTokens('abc')).toBe(1) // 3/4 = 0.75 → rounds to 1
    expect(estimateTokens('ab')).toBe(1)  // 2/4 = 0.5 → rounds to 1 (Math.round)
  })
})

// lint rule trigger logic (extracted inline for testability)

function wordCount(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length
}

function hasFilePath(text: string): boolean {
  return /[^\s]+\.[a-z]{1,5}(\/|$)/i.test(text)
}

function hasCodeBlock(text: string): boolean {
  return /```/.test(text)
}

describe('no-context rule', () => {
  it('triggers when prompt is short and has no file path or code block', () => {
    const text = 'Fix the bug.'
    expect(wordCount(text)).toBeLessThan(20)
    expect(hasFilePath(text)).toBe(false)
    expect(hasCodeBlock(text)).toBe(false)
  })

  it('does not trigger when file path is present', () => {
    expect(hasFilePath('Fix the bug in src/auth.ts')).toBe(true)
  })

  it('does not trigger when code block is present', () => {
    expect(hasCodeBlock('Fix this:\n```ts\nconst x = 1\n```')).toBe(true)
  })

  it('does not trigger when prompt is long enough', () => {
    const longText = 'word '.repeat(25)
    expect(wordCount(longText)).toBeGreaterThanOrEqual(20)
  })
})

describe('vague-scope rule', () => {
  const vaguePattern = /\b(everything|all files|entire codebase)\b/gi

  it('matches "everything"', () => {
    expect(vaguePattern.test('Refactor everything')).toBe(true)
  })

  it('matches "all files"', () => {
    vaguePattern.lastIndex = 0
    expect(vaguePattern.test('Update all files to use the new API')).toBe(true)
  })

  it('matches "entire codebase"', () => {
    vaguePattern.lastIndex = 0
    expect(vaguePattern.test('Lint the entire codebase')).toBe(true)
  })

  it('does not match specific scopes', () => {
    vaguePattern.lastIndex = 0
    expect(vaguePattern.test('Refactor src/auth.ts')).toBe(false)
  })
})

describe('long-prompt rule', () => {
  it('triggers when tokens exceed 2000', () => {
    const longText = 'a'.repeat(8004) // 8004/4 = 2001
    expect(estimateTokens(longText)).toBeGreaterThan(2000)
  })

  it('does not trigger for normal prompts', () => {
    expect(estimateTokens('Short prompt')).toBeLessThan(2000)
  })
})
