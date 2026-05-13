import * as vscode from 'vscode'
import { LintRule, LintContext, makeDiag, makeRange } from '../types'

const SKILL_PATTERN = /(^|\s)\/[a-z][a-z0-9-]*/g

export const multiSkillRule: LintRule = {
  code: 'multi-skill',
  run({ document }: LintContext): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = []
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text
      if (Array.from(line.matchAll(SKILL_PATTERN)).length > 1) {
        diagnostics.push(makeDiag(
          makeRange(document, i),
          'Multiple slash commands on one line — consider splitting into separate prompts.',
          vscode.DiagnosticSeverity.Warning,
          'multi-skill',
        ))
      }
    }
    return diagnostics
  },
}
