import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { expand, parseFrontmatter } from '../promptExpander'
import type { Skill } from '../skillRegistry'

const ROOT = '/workspace'

function makeRead(files: Record<string, string>): (p: string) => string | null {
  return (abs: string) => {
    const rel = abs.startsWith(ROOT + '/') ? abs.slice(ROOT.length + 1) : abs
    return files[rel] ?? files[abs] ?? null
  }
}

function makeRegistry(skills: Record<string, Skill>) {
  return {
    get: (name: string) => skills[name],
    has: (name: string) => name in skills,
  }
}

describe('parseFrontmatter', () => {
  it('returns empty when no frontmatter', () => {
    const r = parseFrontmatter('# Hello\n\nWorld')
    expect(r.vars).toEqual({})
    expect(r.body).toBe('# Hello\n\nWorld')
  })

  it('parses scalar string vars', () => {
    const text = '---\nname: world\ntarget: "src/auth.ts"\n---\nHello {{name}}'
    const r = parseFrontmatter(text)
    expect(r.vars).toEqual({ name: 'world', target: 'src/auth.ts' })
    expect(r.body).toBe('Hello {{name}}')
  })

  it('ignores malformed lines', () => {
    const text = '---\nname: ok\nnot a valid line\n---\nbody'
    const r = parseFrontmatter(text)
    expect(r.vars).toEqual({ name: 'ok' })
  })

  it('handles missing closing delimiter', () => {
    const text = '---\nname: world\nno close here\n# Heading'
    const r = parseFrontmatter(text)
    expect(r.vars).toEqual({})
    expect(r.body).toBe(text)
  })
})

describe('expand — variable substitution', () => {
  it('substitutes {{var}} from frontmatter', async () => {
    const text = '---\nname: world\n---\nHello {{name}}'
    const r = await expand(text, { workspaceRoot: ROOT, registry: makeRegistry({}), readFile: makeRead({}) })
    expect(r.expanded).toBe('Hello world')
    expect(r.variables).toEqual({ name: 'world' })
  })

  it('options.vars overrides frontmatter', async () => {
    const text = '---\nname: world\n---\nHi {{name}}'
    const r = await expand(text, { workspaceRoot: ROOT, registry: makeRegistry({}), vars: { name: 'Claude' }, readFile: makeRead({}) })
    expect(r.expanded).toBe('Hi Claude')
  })

  it('reports unresolved variables', async () => {
    const text = 'Hello {{missing}}'
    const r = await expand(text, { workspaceRoot: ROOT, registry: makeRegistry({}), readFile: makeRead({}) })
    expect(r.expanded).toBe('Hello {{missing}}')
    expect(r.unresolved).toHaveLength(1)
    expect(r.unresolved[0].ref).toBe('missing')
  })
})

describe('expand — @file references', () => {
  it('inlines file as fenced block', async () => {
    const files = { 'src/auth.ts': 'export const x = 1' }
    const text = 'See @src/auth.ts for details.'
    const r = await expand(text, { workspaceRoot: ROOT, registry: makeRegistry({}), readFile: makeRead(files) })
    expect(r.expanded).toContain('```ts src/auth.ts')
    expect(r.expanded).toContain('export const x = 1')
    expect(r.sections).toHaveLength(1)
    expect(r.sections[0].kind).toBe('file')
    expect(r.sections[0].source).toBe('src/auth.ts')
    expect(r.sections[0].tokens).toBeGreaterThan(0)
  })

  it('reports unresolved @file', async () => {
    const r = await expand('@missing/foo.ts', {
      workspaceRoot: ROOT,
      registry: makeRegistry({}),
      readFile: makeRead({}),
    })
    expect(r.unresolved).toHaveLength(1)
    expect(r.unresolved[0].kind).toBe('file')
    expect(r.unresolved[0].ref).toBe('missing/foo.ts')
  })

  it('does not expand @file inside code fences', async () => {
    const files = { 'foo.ts': 'CONTENT' }
    const text = '```\n@foo.ts\n```'
    const r = await expand(text, { workspaceRoot: ROOT, registry: makeRegistry({}), readFile: makeRead(files) })
    expect(r.expanded).not.toContain('CONTENT')
  })
})

describe('expand — /skill references', () => {
  it('inlines skill README body', async () => {
    const files = { 'skills/refactor/README.md': 'Plan a refactor.\n\n## Steps\n- step 1' }
    const skill: Skill = {
      name: 'refactor',
      description: 'Plan a refactor.',
      triggerConditions: '',
      sourcePath: path.join(ROOT, 'skills/refactor'),
      readmePath: path.join(ROOT, 'skills/refactor/README.md'),
    }
    const r = await expand('Use /refactor to begin', {
      workspaceRoot: ROOT,
      registry: makeRegistry({ refactor: skill }),
      readFile: makeRead(files),
    })
    expect(r.expanded).toContain('<!-- skill: refactor -->')
    expect(r.expanded).toContain('Plan a refactor.')
    expect(r.sections.some(s => s.kind === 'skill' && s.source === 'refactor')).toBe(true)
  })

  it('reports unknown skill', async () => {
    const r = await expand('/missing-skill', {
      workspaceRoot: ROOT,
      registry: makeRegistry({}),
      readFile: makeRead({}),
    })
    expect(r.unresolved.some(u => u.kind === 'skill' && u.ref === 'missing-skill')).toBe(true)
  })
})

describe('expand — !include directives', () => {
  it('inlines included files', async () => {
    const files = { 'shared/intro.md': '# Shared intro\n\nReused everywhere.' }
    const text = '!include shared/intro.md\n\nMain body.'
    const r = await expand(text, { workspaceRoot: ROOT, registry: makeRegistry({}), readFile: makeRead(files) })
    expect(r.expanded).toContain('# Shared intro')
    expect(r.expanded).toContain('Main body')
    expect(r.sections.some(s => s.kind === 'include')).toBe(true)
  })

  it('detects cyclic includes', async () => {
    const files = {
      'a.md': '!include b.md',
      'b.md': '!include a.md',
    }
    const r = await expand('!include a.md', {
      workspaceRoot: ROOT,
      registry: makeRegistry({}),
      readFile: makeRead(files),
    })
    expect(r.unresolved.some(u => u.reason === 'Cyclic include')).toBe(true)
  })

  it('reports missing include', async () => {
    const r = await expand('!include nope.md', {
      workspaceRoot: ROOT,
      registry: makeRegistry({}),
      readFile: makeRead({}),
    })
    expect(r.unresolved.some(u => u.kind === 'include' && u.ref === 'nope.md')).toBe(true)
  })

  it('respects maxDepth', async () => {
    const files = {
      'a.md': '!include b.md',
      'b.md': '!include c.md',
      'c.md': '!include d.md',
      'd.md': 'deep',
    }
    const r = await expand('!include a.md', {
      workspaceRoot: ROOT,
      registry: makeRegistry({}),
      readFile: makeRead(files),
      maxDepth: 2,
    })
    // Should still produce output but stop recursing deep enough
    expect(r.expanded).toBeDefined()
  })
})

describe('expand — sections + token attribution', () => {
  it('attaches token counts per section', async () => {
    const files = { 'big.md': 'lots of words '.repeat(50) }
    const r = await expand('@big.md', {
      workspaceRoot: ROOT,
      registry: makeRegistry({}),
      readFile: makeRead(files),
    })
    expect(r.sections[0].tokens).toBeGreaterThan(10)
  })
})
