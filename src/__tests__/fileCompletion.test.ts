import { describe, it, expect } from 'vitest'

// Test the path-parsing logic extracted from FileCompletionProvider

function parsePath(typed: string): { dirPrefix: string; filter: string } {
  const lastSlash = typed.lastIndexOf('/')
  const dirPrefix = lastSlash === -1 ? '' : typed.slice(0, lastSlash + 1)
  const filter = lastSlash === -1 ? typed.toLowerCase() : typed.slice(lastSlash + 1).toLowerCase()
  return { dirPrefix, filter }
}

function shouldActivate(linePrefix: string): { active: boolean; typed: string } {
  const atIndex = linePrefix.lastIndexOf('@')
  if (atIndex === -1) return { active: false, typed: '' }
  const charBefore = linePrefix[atIndex - 1]
  if (charBefore !== undefined && charBefore !== ' ' && charBefore !== '\t') {
    return { active: false, typed: '' }
  }
  return { active: true, typed: linePrefix.slice(atIndex + 1) }
}

// ─── activation guard ────────────────────────────────────────────────────────

describe('@ activation guard', () => {
  it('activates when @ is at start of line', () => {
    expect(shouldActivate('@src').active).toBe(true)
  })

  it('activates when @ is after a space', () => {
    expect(shouldActivate('See @src').active).toBe(true)
  })

  it('activates when @ is after a tab', () => {
    expect(shouldActivate('\t@src').active).toBe(true)
  })

  it('does not activate when @ is inside a word (e.g. email)', () => {
    expect(shouldActivate('user@example.com').active).toBe(false)
  })

  it('does not activate when no @ is present', () => {
    expect(shouldActivate('just some text').active).toBe(false)
  })

  it('extracts typed path correctly', () => {
    expect(shouldActivate('Context: @src/components').typed).toBe('src/components')
  })
})

// ─── path parsing ────────────────────────────────────────────────────────────

describe('parsePath', () => {
  it('root level with no slash: empty dirPrefix, typed as filter', () => {
    expect(parsePath('src')).toEqual({ dirPrefix: '', filter: 'src' })
  })

  it('empty string: shows root', () => {
    expect(parsePath('')).toEqual({ dirPrefix: '', filter: '' })
  })

  it('trailing slash: dirPrefix is full path, empty filter', () => {
    expect(parsePath('src/')).toEqual({ dirPrefix: 'src/', filter: '' })
  })

  it('partial name after slash: dirPrefix + filter split', () => {
    expect(parsePath('src/comp')).toEqual({ dirPrefix: 'src/', filter: 'comp' })
  })

  it('nested path with trailing slash', () => {
    expect(parsePath('src/components/')).toEqual({ dirPrefix: 'src/components/', filter: '' })
  })

  it('nested path with partial name', () => {
    expect(parsePath('src/components/But')).toEqual({
      dirPrefix: 'src/components/',
      filter: 'but',  // lowercased
    })
  })

  it('filter is always lowercased for case-insensitive matching', () => {
    expect(parsePath('src/AUTH').filter).toBe('auth')
  })
})

// ─── ignored directories ─────────────────────────────────────────────────────

describe('IGNORED pattern', () => {
  const IGNORED = /^(node_modules|\.git|out|dist|\.next|coverage|\.vscode)$/

  it.each(['node_modules', '.git', 'out', 'dist', '.next', 'coverage', '.vscode'])(
    'ignores %s',
    (name) => expect(IGNORED.test(name)).toBe(true),
  )

  it('does not ignore src', () => expect(IGNORED.test('src')).toBe(false))
  it('does not ignore components', () => expect(IGNORED.test('components')).toBe(false))
  it('does not ignore a regular file', () => expect(IGNORED.test('Button.tsx')).toBe(false))
})
