import { describe, it, expect } from 'vitest'
import { extractFirstHeading } from '../promptIndex'

describe('extractFirstHeading', () => {
  it('returns first H1', () => {
    expect(extractFirstHeading('# Hello\nWorld')).toBe('Hello')
  })

  it('skips frontmatter', () => {
    expect(extractFirstHeading('---\nfoo: bar\n---\n# Real heading')).toBe('Real heading')
  })

  it('skips code-block H1', () => {
    expect(extractFirstHeading('```\n# fake\n```\n# real')).toBe('real')
  })

  it('ignores H2/H3', () => {
    expect(extractFirstHeading('## Sub')).toBeNull()
  })

  it('returns null when no heading', () => {
    expect(extractFirstHeading('plain prose')).toBeNull()
  })
})
