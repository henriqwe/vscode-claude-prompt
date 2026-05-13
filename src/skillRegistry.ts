import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { parseFrontmatter } from './utils/frontmatter'

export interface Skill {
  name: string
  description: string
  triggerConditions: string
  sourcePath: string
  readmePath: string | null
  source: 'project' | 'global'
}

/**
 * Central registry of all known skills, merged from four sources in priority order:
 *   1. project `.claude/skills/<name>/`
 *   2. project `.claude/settings.json` `skills` array
 *   3. global `~/.claude/skills/<name>/`
 *   4. global `~/.claude/settings.json` `skills` array
 *
 * Project skills win over global on name collisions (first-writer wins in `refresh`).
 * FileSystemWatchers on all four sources trigger `refresh()` automatically.
 */
export class SkillRegistry implements vscode.Disposable {
  private skills = new Map<string, Skill>()
  private watchers: vscode.FileSystemWatcher[] = []
  private readonly globalClaudeDir: string

  private _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  constructor(globalClaudeDir?: string) {
    this.globalClaudeDir = globalClaudeDir ?? path.join(os.homedir(), '.claude')
    this.setupWatchers()
    this.refresh()
  }

  getAll(): Skill[] {
    return Array.from(this.skills.values()).sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name)
  }

  has(name: string): boolean {
    return this.skills.has(name)
  }

  /** Clears and reloads all skill sources; fires `onDidChange` when done. */
  refresh(): void {
    this.skills.clear()
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const claudeDir = path.join(folder.uri.fsPath, '.claude')
      this.loadSkillSource(path.join(claudeDir, 'skills'), path.join(claudeDir, 'settings.json'), 'project')
    }
    this.loadSkillSource(
      path.join(this.globalClaudeDir, 'skills'),
      path.join(this.globalClaudeDir, 'settings.json'),
      'global',
    )
    this._onDidChange.fire()
  }

  private setupWatchers(): void {
    this.watchSource('**/.claude/skills/**')
    this.watchSource('**/.claude/settings.json')
    const globalUri = vscode.Uri.file(this.globalClaudeDir)
    this.watchSource(new vscode.RelativePattern(globalUri, 'skills/**'))
    this.watchSource(new vscode.RelativePattern(globalUri, 'settings.json'))
  }

  private watchSource(pattern: string | vscode.RelativePattern): void {
    const w = vscode.workspace.createFileSystemWatcher(pattern)
    w.onDidCreate(() => this.refresh())
    w.onDidDelete(() => this.refresh())
    w.onDidChange(() => this.refresh())
    this.watchers.push(w)
  }

  private loadSkillSource(skillsDir: string, settingsPath: string, source: Skill['source']): void {
    if (fs.existsSync(skillsDir)) {
      let entries: fs.Dirent[]
      try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }) } catch { entries = [] }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skill = this.parseSkillDir(entry.name, path.join(skillsDir, entry.name), source)
        if (!this.skills.has(skill.name)) this.skills.set(skill.name, skill)
      }
    }

    if (fs.existsSync(settingsPath)) {
      try {
        const json = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
        const names: unknown[] = json?.skills ?? []
        for (const entry of names) {
          if (typeof entry === 'string' && !this.skills.has(entry)) {
            this.skills.set(entry, {
              name: entry, description: '', triggerConditions: '',
              sourcePath: settingsPath, readmePath: null, source,
            })
          }
        }
      } catch {
        // malformed JSON — skip
      }
    }
  }

  private parseSkillDir(name: string, dirPath: string, source: Skill['source']): Skill {
    const readmePath = this.findReadme(dirPath)
    let description = ''
    let triggerConditions = ''

    if (readmePath) {
      const content = fs.readFileSync(readmePath, 'utf8')
      description = extractDescription(content)
      triggerConditions = extractTriggerConditions(content)
    }

    return { name, description, triggerConditions, sourcePath: dirPath, readmePath, source }
  }

  private findReadme(dirPath: string): string | null {
    const candidates = ['README.md', 'readme.md', 'SKILL.md', 'skill.md']
    for (const candidate of candidates) {
      const full = path.join(dirPath, candidate)
      if (fs.existsSync(full)) return full
    }
    // fall back to first .md file
    try {
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.md'))
      if (files.length > 0) return path.join(dirPath, files[0])
    } catch {
      // ignore
    }
    return null
  }

  dispose(): void {
    this.watchers.forEach(w => w.dispose())
    this._onDidChange.dispose()
  }
}

/**
 * Returns the skill description from the README.
 * Checks the frontmatter `description` field first; falls back to the first
 * non-heading, non-empty line in the body.
 */
export function extractDescription(content: string): string {
  const { body, fields } = parseFrontmatter(content)
  if (fields.description) return fields.description

  const lines = body.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) return trimmed
  }
  return ''
}

/**
 * Returns the first bullet under a heading matching `when to use|triggers when|use this skill when`.
 * Falls back to an inline `TRIGGERS WHEN: …` or `Use this skill when: …` phrase if no heading matches.
 */
export function extractTriggerConditions(content: string): string {
  const { body } = parseFrontmatter(content)
  const triggerHeadings = /^#{1,3}\s+(when to use|triggers when|use this skill when)/i
  const lines = body.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (triggerHeadings.test(lines[i])) {
      for (let j = i + 1; j < lines.length; j++) {
        const trimmed = lines[j].trim().replace(/^[-*]\s*/, '')
        if (trimmed && !trimmed.startsWith('#')) return trimmed
      }
    }
  }
  const inlineMatch = body.match(/(?:TRIGGER[S]? WHEN|Use this skill when)[:\s]+([^\n.]+)/i)
  return inlineMatch ? inlineMatch[1].trim() : ''
}

/**
 * Builds a VS Code snippet string from the skill's ARGUMENTS bullet list.
 * Each bullet becomes a tab stop: `label: ${N:label}`.
 * Returns null when no bullets are found (no snippet expansion needed).
 */
export function extractSnippetTabStops(content: string): string | null {
  // Look for ARGUMENTS section first
  const argsMatch = content.match(/^#{1,3}\s+ARGUMENTS\s*\n([\s\S]*?)(?=^#{1,3}|\Z)/im)
  const source = argsMatch ? argsMatch[1] : content

  const bulletLines = source
    .split('\n')
    .map(l => l.trim())
    .filter(l => /^[-*]/.test(l))
    .map(l => l.replace(/^[-*]\s*/, '').split(':')[0].trim())
    .filter(Boolean)

  if (bulletLines.length === 0) return null

  const tabStops = bulletLines.map((label, i) => `${label}: $\{${i + 1}:${label}}`).join('\n')
  return tabStops
}
