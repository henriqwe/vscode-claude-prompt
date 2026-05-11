import * as vscode from 'vscode'
import * as path from 'path'
import * as fs from 'fs'

export interface Skill {
  name: string
  description: string
  triggerConditions: string
  sourcePath: string
  readmePath: string | null
}

export class SkillRegistry implements vscode.Disposable {
  private skills = new Map<string, Skill>()
  private watchers: vscode.FileSystemWatcher[] = []

  private _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  constructor() {
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

  refresh(): void {
    this.skills.clear()
    this.loadFromSkillDirs()
    this.loadFromSettings()
    this._onDidChange.fire()
  }

  private setupWatchers(): void {
    const skillsWatcher = vscode.workspace.createFileSystemWatcher('**/.claude/skills/**')
    skillsWatcher.onDidCreate(() => this.refresh())
    skillsWatcher.onDidDelete(() => this.refresh())
    skillsWatcher.onDidChange(() => this.refresh())

    const settingsWatcher = vscode.workspace.createFileSystemWatcher('**/.claude/settings.json')
    settingsWatcher.onDidCreate(() => this.refresh())
    settingsWatcher.onDidDelete(() => this.refresh())
    settingsWatcher.onDidChange(() => this.refresh())

    this.watchers.push(skillsWatcher, settingsWatcher)
  }

  private loadFromSkillDirs(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? []
    for (const folder of workspaceFolders) {
      const skillsRoot = path.join(folder.uri.fsPath, '.claude', 'skills')
      if (!fs.existsSync(skillsRoot)) continue

      const entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const skillDir = path.join(skillsRoot, entry.name)
        const skill = this.parseSkillDir(entry.name, skillDir)
        if (!this.skills.has(skill.name)) {
          this.skills.set(skill.name, skill)
        }
      }
    }
  }

  private parseSkillDir(name: string, dirPath: string): Skill {
    const readmePath = this.findReadme(dirPath)
    let description = ''
    let triggerConditions = ''

    if (readmePath) {
      const content = fs.readFileSync(readmePath, 'utf8')
      description = extractDescription(content)
      triggerConditions = extractTriggerConditions(content)
    }

    return { name, description, triggerConditions, sourcePath: dirPath, readmePath }
  }

  private findReadme(dirPath: string): string | null {
    const candidates = ['README.md', 'readme.md']
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

  private loadFromSettings(): void {
    const workspaceFolders = vscode.workspace.workspaceFolders ?? []
    for (const folder of workspaceFolders) {
      const settingsPath = path.join(folder.uri.fsPath, '.claude', 'settings.json')
      if (!fs.existsSync(settingsPath)) continue

      try {
        const raw = fs.readFileSync(settingsPath, 'utf8')
        const json = JSON.parse(raw)
        const skills: unknown[] = json?.skills ?? []
        for (const entry of skills) {
          if (typeof entry === 'string' && !this.skills.has(entry)) {
            this.skills.set(entry, {
              name: entry,
              description: '',
              triggerConditions: '',
              sourcePath: settingsPath,
              readmePath: null,
            })
          }
        }
      } catch {
        // malformed JSON — skip
      }
    }
  }

  dispose(): void {
    this.watchers.forEach(w => w.dispose())
    this._onDidChange.dispose()
  }
}

export function extractDescription(content: string): string {
  const lines = content.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed && !trimmed.startsWith('#')) return trimmed
  }
  return ''
}

export function extractTriggerConditions(content: string): string {
  const triggerHeadings = /^#{1,3}\s+(when to use|triggers when|use this skill when)/i
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (triggerHeadings.test(lines[i])) {
      // return first non-empty line after the heading
      for (let j = i + 1; j < lines.length; j++) {
        const trimmed = lines[j].trim().replace(/^[-*]\s*/, '')
        if (trimmed && !trimmed.startsWith('#')) return trimmed
      }
    }
  }
  // also check inline "TRIGGERS WHEN" or "Use this skill when" in body
  const inlineMatch = content.match(/(?:TRIGGER[S]? WHEN|Use this skill when)[:\s]+([^\n.]+)/i)
  return inlineMatch ? inlineMatch[1].trim() : ''
}

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
