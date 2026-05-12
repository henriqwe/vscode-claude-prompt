import { describe, it, expect } from 'vitest'
import { countTokens } from '../tokenizer'

// ─── countTokens (real BPE tokenizer) ────────────────────────────────────────

describe('countTokens', () => {
  it('returns 0 for empty string', () => {
    expect(countTokens('')).toBe(0)
  })

  it('produces positive counts for non-empty text', () => {
    expect(countTokens('a')).toBeGreaterThan(0)
    expect(countTokens('Hello world')).toBeGreaterThan(0)
  })

  it('scales monotonically with input size', () => {
    const small = countTokens('hello world')
    const large = countTokens('hello world '.repeat(50))
    expect(large).toBeGreaterThan(small)
  })
})

// ─── helpers mirroring lintProvider logic ────────────────────────────────────

function wordCount(text: string): number {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length
}
function hasFilePath(text: string): boolean {
  return /[^\s]+\.[a-z]{1,5}(\/|$)/i.test(text)
}
function hasAtReference(text: string): boolean {
  return /@[^\s]/.test(text)
}
function hasCodeBlock(text: string): boolean {
  return /```/.test(text)
}
// mirrors the fixed pattern that ignores path segments like @src/foo
function matchesSkillPattern(line: string): RegExpMatchArray[] {
  return Array.from(line.matchAll(/(^|\s)(\/([a-z][a-z0-9-]*))/g))
}

// ─── no-context rule ─────────────────────────────────────────────────────────

describe('no-context rule', () => {
  it('triggers on a short prompt with no context indicators', () => {
    const text = 'Fix the bug.'
    expect(wordCount(text)).toBeLessThan(20)
    expect(hasFilePath(text)).toBe(false)
    expect(hasAtReference(text)).toBe(false)
    expect(hasCodeBlock(text)).toBe(false)
  })

  it('does not trigger when a file path is present', () => {
    expect(hasFilePath('Fix the bug in src/auth.ts')).toBe(true)
  })

  it('does not trigger when an @reference is present', () => {
    expect(hasAtReference('See @src/components/Button.tsx for the pattern')).toBe(true)
  })

  it('does not trigger when a code block is present', () => {
    expect(hasCodeBlock('Fix this:\n```ts\nconst x = 1\n```')).toBe(true)
  })

  it('does not trigger when the prompt is long enough', () => {
    expect(wordCount('word '.repeat(25))).toBeGreaterThanOrEqual(20)
  })

  it('@reference with nested path counts as context', () => {
    expect(hasAtReference('@src/services/auth.ts')).toBe(true)
  })
})

// ─── vague-scope rule ────────────────────────────────────────────────────────

describe('vague-scope rule', () => {
  const pattern = () => /\b(everything|all files|entire codebase)\b/gi

  it('matches "everything"', () => {
    expect(pattern().test('Refactor everything')).toBe(true)
  })

  it('matches "all files"', () => {
    expect(pattern().test('Update all files to use the new API')).toBe(true)
  })

  it('matches "entire codebase"', () => {
    expect(pattern().test('Lint the entire codebase')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(pattern().test('Fix EVERYTHING')).toBe(true)
  })

  it('does not match specific scopes', () => {
    expect(pattern().test('Refactor src/auth.ts')).toBe(false)
  })
})

// ─── unknown-skill rule (pattern only) ───────────────────────────────────────

describe('unknown-skill pattern', () => {
  it('matches /skill-name at start of line', () => {
    const matches = matchesSkillPattern('/create-service')
    expect(matches).toHaveLength(1)
    expect(matches[0][3]).toBe('create-service')
  })

  it('matches /skill-name after a space', () => {
    const matches = matchesSkillPattern('Use /create-service to scaffold')
    expect(matches).toHaveLength(1)
    expect(matches[0][3]).toBe('create-service')
  })

  it('does NOT match /segment inside an @path like @src/components', () => {
    expect(matchesSkillPattern('@src/components/Button.tsx')).toHaveLength(0)
  })

  it('does NOT match /segment inside a plain file path', () => {
    expect(matchesSkillPattern('src/auth/index.ts')).toHaveLength(0)
  })

  it('matches multiple skills on one line (multi-skill detection)', () => {
    const matches = matchesSkillPattern('/create-service /create-query')
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── long-prompt rule ────────────────────────────────────────────────────────

// ─── new lint helpers (Phase 2) ──────────────────────────────────────────────

import { findFileRefs, findSkillInvocations } from '../lintProvider'

function makeDoc(text: string): any {
  const lines = text.split('\n')
  return {
    lineCount: lines.length,
    lineAt: (i: number) => ({ text: lines[i], range: {} }),
    uri: {},
    getText: () => text,
  }
}

describe('findFileRefs', () => {
  it('finds @file refs', () => {
    const doc = makeDoc('See @src/auth.ts and @lib/util.js')
    const refs = findFileRefs(doc)
    expect(refs.map(r => r.ref)).toEqual(['src/auth.ts', 'lib/util.js'])
  })

  it('ignores refs inside fences', () => {
    const doc = makeDoc('```\n@inside.ts\n```\n@outside.ts')
    expect(findFileRefs(doc).map(r => r.ref)).toEqual(['outside.ts'])
  })

  it('returns empty when no refs', () => {
    expect(findFileRefs(makeDoc('plain text'))).toHaveLength(0)
  })

  it('captures leading-slash refs (workspace-root style)', () => {
    const doc = makeDoc('can u read this file? @/src/App.tsx')
    expect(findFileRefs(doc).map(r => r.ref)).toEqual(['/src/App.tsx'])
  })
})

describe('findSkillInvocations', () => {
  it('finds /skill invocations', () => {
    const doc = makeDoc('Use /refactor and /code-review')
    expect(findSkillInvocations(doc).map(s => s.name)).toEqual(['refactor', 'code-review'])
  })

  it('ignores skills inside fences', () => {
    const doc = makeDoc('```\n/inside\n```\n/outside')
    expect(findSkillInvocations(doc).map(s => s.name)).toEqual(['outside'])
  })

  it('does not match path segments like @src/foo', () => {
    expect(findSkillInvocations(makeDoc('@src/components/Button.tsx'))).toHaveLength(0)
  })
})

describe('long-prompt rule', () => {
  it('triggers for very large prompts', () => {
    const huge = 'The quick brown fox jumps over the lazy dog. '.repeat(500)
    expect(countTokens(huge)).toBeGreaterThan(2000)
  })

  it('does not trigger for a normal prompt', () => {
    expect(countTokens('Short prompt')).toBeLessThan(2000)
  })
})
