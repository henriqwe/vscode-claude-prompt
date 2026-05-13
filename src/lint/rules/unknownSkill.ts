import * as vscode from 'vscode'
import { LintRule, LintContext, makeDiag } from '../types'

const SKILL_PATTERN = /(?:^|\s)(\/([a-z][a-z0-9-]*))/g

export const unknownSkillRule: LintRule = {
  code: 'unknown-skill',
  run({ document, registry }: LintContext): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = []
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text
      SKILL_PATTERN.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = SKILL_PATTERN.exec(line)) !== null) {
        const slashToken = match[1]
        const name = match[2]
        const tokenStart = match.index + (match[0].length - slashToken.length)
        if (!registry.has(name)) {
          diagnostics.push(makeDiag(
            new vscode.Range(i, tokenStart, i, tokenStart + slashToken.length),
            `Unknown skill: "${slashToken}" is not registered in .claude/skills/ or settings.json.`,
            vscode.DiagnosticSeverity.Error,
            'unknown-skill',
          ))
        }
      }
    }
    return diagnostics
  },
}
