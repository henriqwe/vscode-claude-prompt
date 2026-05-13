import * as vscode from 'vscode'
import { LintRule, LintContext, makeDiag } from '../types'
import { findSkillInvocations } from '../scanners'

export const duplicateSkillRule: LintRule = {
  code: 'duplicate-skill',
  configKey: 'duplicate-skill',
  run({ document }: LintContext): vscode.Diagnostic[] {
    const seen = new Map<string, vscode.Range>()
    const out: vscode.Diagnostic[] = []
    for (const { name, range } of findSkillInvocations(document)) {
      if (seen.has(name)) {
        out.push(makeDiag(range, `Duplicate skill invocation: "/${name}" appears more than once.`, vscode.DiagnosticSeverity.Information, 'duplicate-skill'))
      } else {
        seen.set(name, range)
      }
    }
    return out
  },
}
