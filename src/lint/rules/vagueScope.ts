import * as vscode from 'vscode'
import { LintRule, LintContext, makeDiag } from '../types'

const VAGUE_PATTERN = /\b(everything|all files|entire codebase)\b/gi

export const vagueScopeRule: LintRule = {
  code: 'vague-scope',
  run({ document }: LintContext): vscode.Diagnostic[] {
    const diagnostics: vscode.Diagnostic[] = []
    for (let i = 0; i < document.lineCount; i++) {
      const line = document.lineAt(i).text
      VAGUE_PATTERN.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = VAGUE_PATTERN.exec(line)) !== null) {
        diagnostics.push(makeDiag(
          new vscode.Range(i, match.index, i, match.index + match[0].length),
          `Vague scope: "${match[0]}" may produce unpredictable results.`,
          vscode.DiagnosticSeverity.Warning,
          'vague-scope',
        ))
      }
    }
    return diagnostics
  },
}
