import * as vscode from 'vscode'
import { LintRule, LintContext, makeDiag, makeRange } from '../types'

export const noContextRule: LintRule = {
  code: 'no-context',
  configKey: 'no-context',
  run({ document, text }: LintContext): vscode.Diagnostic[] {
    const wordCount = text.trim().split(/\s+/).length
    const hasFilePath = /[^\s]+\.[a-z]{1,5}(\/|$)/i.test(text)
    const hasAtReference = /@[^\s]/.test(text)
    const hasCodeBlock = /```/.test(text)
    const codeIntent = /\b(fix|bug|refactor|debug|implement|function|class|method|variable|import|module|api|endpoint|route|component|test|typescript|javascript|python|rust|golang|sql|query|schema|migration|error|exception|stack ?trace|compile|build|lint|patch|diff)\b/i.test(text)

    if (codeIntent && wordCount < 20 && !hasFilePath && !hasAtReference && !hasCodeBlock) {
      return [makeDiag(
        makeRange(document, 0),
        'No context provided — include a file path, function name, or code block.',
        vscode.DiagnosticSeverity.Warning,
        'no-context',
      )]
    }
    return []
  },
}
