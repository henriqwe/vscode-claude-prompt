import * as vscode from 'vscode'
import * as fs from 'fs'
import { SkillRegistry } from './skillRegistry'

const SKILL_TOKEN = /\/([a-z][a-z0-9-]*)/g

export class HoverProvider implements vscode.HoverProvider {
  private cache = new Map<string, vscode.MarkdownString>()

  constructor(private readonly registry: SkillRegistry) {
    registry.onDidChange(() => this.cache.clear())
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | undefined {
    const line = document.lineAt(position).text
    let match: RegExpExecArray | null

    SKILL_TOKEN.lastIndex = 0
    while ((match = SKILL_TOKEN.exec(line)) !== null) {
      const start = match.index
      const end = start + match[0].length
      if (position.character < start || position.character > end) continue

      const skillName = match[1]
      const skill = this.registry.get(skillName)
      if (!skill) continue

      const range = new vscode.Range(position.line, start, position.line, end)
      return new vscode.Hover(this.buildHoverContent(skill), range)
    }

    return undefined
  }

  private buildHoverContent(skill: ReturnType<SkillRegistry['get']> & object): vscode.MarkdownString {
    if (this.cache.has(skill.name)) return this.cache.get(skill.name)!

    const md = new vscode.MarkdownString('', true)
    md.isTrusted = true
    md.supportHtml = false

    md.appendMarkdown(`**\`SKILL\`** \`/${skill.name}\`\n\n`)

    const description = skill.description || readFirstParagraph(skill.readmePath)
    if (description) md.appendMarkdown(`${description}\n\n`)

    if (skill.triggerConditions) {
      md.appendMarkdown(`**Triggers when:** ${skill.triggerConditions}\n\n`)
    }

    md.appendMarkdown(`**Source:** \`${skill.sourcePath}\``)

    this.cache.set(skill.name, md)
    return md
  }
}

function readFirstParagraph(readmePath: string | null): string {
  if (!readmePath) return ''
  try {
    const content = fs.readFileSync(readmePath, 'utf8')
    const lines = content.split('\n')
    const para: string[] = []
    let started = false
    for (const line of lines) {
      const trimmed = line.trim()
      if (!started && (trimmed === '' || trimmed.startsWith('#'))) continue
      started = true
      if (trimmed === '') break
      para.push(trimmed)
    }
    return para.join(' ')
  } catch {
    return ''
  }
}
