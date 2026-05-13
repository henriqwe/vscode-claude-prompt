import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  extractDescription,
  extractTriggerConditions,
  extractSnippetTabStops,
} from '../skillRegistry'

// --- pure function tests (no vscode dependency) ---

describe('extractDescription', () => {
  it('returns first non-heading, non-empty line', () => {
    const content = `# My Skill\n\nDoes something useful.\n\nMore details.`
    expect(extractDescription(content)).toBe('Does something useful.')
  })

  it('skips heading lines', () => {
    const content = `# Title\n## Subtitle\nActual description`
    expect(extractDescription(content)).toBe('Actual description')
  })

  it('returns empty string when only headings', () => {
    expect(extractDescription('# Only Heading\n## Sub')).toBe('')
  })
})

describe('extractTriggerConditions', () => {
  it('extracts from "When to use" heading', () => {
    const content = `# Skill\n\nDoes stuff.\n\n## When to use\nWhen the user asks to refactor code`
    expect(extractTriggerConditions(content)).toBe('When the user asks to refactor code')
  })

  it('extracts from "TRIGGERS WHEN" inline', () => {
    const content = `TRIGGERS WHEN: user asks to create a service`
    expect(extractTriggerConditions(content)).toBe('user asks to create a service')
  })

  it('extracts bullet list item after heading', () => {
    const content = `# Skill\n\n## When to use\n- user asks to add a test\n- user mentions coverage`
    expect(extractTriggerConditions(content)).toBe('user asks to add a test')
  })

  it('returns empty string when no trigger section', () => {
    expect(extractTriggerConditions('# Skill\n\nJust a description.')).toBe('')
  })
})

describe('extractSnippetTabStops', () => {
  it('builds tab stops from ARGUMENTS bullet list', () => {
    const content = `# Skill\n\n## ARGUMENTS\n- endpoint: the API path\n- domain: business domain`
    const result = extractSnippetTabStops(content)
    expect(result).toContain('endpoint: ${1:endpoint}')
    expect(result).toContain('domain: ${2:domain}')
  })

  it('falls back to first bullet list in content', () => {
    const content = `# Skill\n\nDescription.\n\n- param1: first param\n- param2: second param`
    const result = extractSnippetTabStops(content)
    expect(result).toContain('param1')
    expect(result).toContain('param2')
  })

  it('returns null when no bullet list found', () => {
    expect(extractSnippetTabStops('# Skill\n\nJust prose, no lists.')).toBeNull()
  })
})

// --- SkillRegistry integration test with real filesystem ---

describe('SkillRegistry (filesystem)', () => {
  let tmpDir: string
  let globalDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-registry-test-'))
    globalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-registry-global-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    fs.rmSync(globalDir, { recursive: true, force: true })
  })

  function createSkill(name: string, readme: string): void {
    const skillDir = path.join(tmpDir, '.claude', 'skills', name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'README.md'), readme)
  }

  it('discovers skills from .claude/skills/ directories', async () => {
    createSkill('my-skill', '# My Skill\n\nDoes something.\n\n## When to use\nWhen needed')

    // import SkillRegistry after setting up workspace mock
    const vscode = await import('./mocks/vscode')
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }]

    const { SkillRegistry } = await import('../skillRegistry')
    const registry = new SkillRegistry(globalDir)

    const skills = registry.getAll()
    expect(skills).toHaveLength(1)
    expect(skills[0].name).toBe('my-skill')
    expect(skills[0].description).toBe('Does something.')
    registry.dispose()
  })

  it('deduplicates skills with same name from multiple sources', async () => {
    createSkill('shared-skill', '# Shared\n\nA shared skill.')

    // also add to settings.json
    const claudeDir = path.join(tmpDir, '.claude')
    fs.mkdirSync(claudeDir, { recursive: true })
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ skills: ['shared-skill', 'settings-only-skill'] }),
    )

    const vscode = await import('./mocks/vscode')
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: tmpDir } }]

    const { SkillRegistry } = await import('../skillRegistry')
    const registry = new SkillRegistry(globalDir)

    const names = registry.getAll().map(s => s.name)
    expect(names).toContain('shared-skill')
    expect(names).toContain('settings-only-skill')
    // no duplicates
    expect(names.filter(n => n === 'shared-skill')).toHaveLength(1)
    registry.dispose()
  })
})
