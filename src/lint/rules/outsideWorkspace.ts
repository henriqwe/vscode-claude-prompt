import * as path from 'path'
import * as vscode from 'vscode'
import { LintRule, LintContext, makeDiag } from '../types'
import { findFileRefs } from '../scanners'

function resolveRef(workspaceRoot: string, ref: string): string {
  return path.resolve(workspaceRoot, ref.startsWith('/') ? ref.slice(1) : ref)
}

export const outsideWorkspaceRule: LintRule = {
  code: 'outside-workspace',
  configKey: 'outside-workspace',
  needsWorkspaceRoot: true,
  run({ document, workspaceRoot }: LintContext): vscode.Diagnostic[] {
    const out: vscode.Diagnostic[] = []
    const rootResolved = path.resolve(workspaceRoot!) + path.sep
    for (const { ref, range } of findFileRefs(document)) {
      const abs = resolveRef(workspaceRoot!, ref)
      if (!abs.startsWith(rootResolved) && abs !== path.resolve(workspaceRoot!)) {
        out.push(makeDiag(range, `Reference resolves outside the workspace: "@${ref}".`, vscode.DiagnosticSeverity.Warning, 'outside-workspace'))
      }
    }
    return out
  },
}
