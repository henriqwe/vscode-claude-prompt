import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { LintRule, LintContext, makeDiag } from '../types'
import { findFileRefs } from '../scanners'

function resolveRef(workspaceRoot: string, ref: string): string {
  return path.resolve(workspaceRoot, ref.startsWith('/') ? ref.slice(1) : ref)
}

export const unresolvedFileRefRule: LintRule = {
  code: 'unresolved-file-ref',
  configKey: 'unresolved-file-ref',
  needsWorkspaceRoot: true,
  run({ document, workspaceRoot }: LintContext): vscode.Diagnostic[] {
    const out: vscode.Diagnostic[] = []
    for (const { ref, range } of findFileRefs(document)) {
      if (!fs.existsSync(resolveRef(workspaceRoot!, ref))) {
        out.push(makeDiag(range, `Unresolved reference: "@${ref}" does not exist.`, vscode.DiagnosticSeverity.Error, 'unresolved-file-ref'))
      }
    }
    return out
  },
}
