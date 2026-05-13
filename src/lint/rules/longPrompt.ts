import * as vscode from 'vscode'
import { LintRule, LintContext, makeDiag, makeRange } from '../types'
import { countTokens } from '../../tokenizer'
import { MAX_LONG_PROMPT_TOKENS } from '../../utils/constants'

export const longPromptRule: LintRule = {
  code: 'long-prompt',
  run({ document, text }: LintContext): vscode.Diagnostic[] {
    const tokens = countTokens(text)
    if (tokens > MAX_LONG_PROMPT_TOKENS) {
      return [makeDiag(
        makeRange(document, 0),
        `Long prompt: ~${tokens} estimated tokens (> ${MAX_LONG_PROMPT_TOKENS}). Consider breaking it up.`,
        vscode.DiagnosticSeverity.Information,
        'long-prompt',
      )]
    }
    return []
  },
}
