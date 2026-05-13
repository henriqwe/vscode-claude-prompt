import * as vscode from 'vscode'
import { LintRule, LintContext, makeDiag } from '../types'

const TABSTOP_PATTERN = /\$\{?\d+(:[^}]*)?\}?/g

export const missingTabstopsRule: LintRule = {
  code: 'missing-tabstops',
  configKey: 'missing-tabstops',
  run({ document }: LintContext): vscode.Diagnostic[] {
    const out: vscode.Diagnostic[] = []
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text
      TABSTOP_PATTERN.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = TABSTOP_PATTERN.exec(line)) !== null) {
        out.push(makeDiag(
          new vscode.Range(i, m.index, i, m.index + m[0].length),
          `Unfilled snippet placeholder: "${m[0]}".`,
          vscode.DiagnosticSeverity.Warning,
          'missing-tabstops',
        ))
      }
    }
    return out
  },
}
