import * as vscode from 'vscode'
import type { SkillRegistry } from '../skillRegistry'

export const LINT_SOURCE = 'claude-prompt'

export interface LintContext {
  document: vscode.TextDocument
  text: string
  registry: SkillRegistry
  workspaceRoot: string | undefined
}

export interface LintRule {
  readonly code: string
  /** If set, the rule is skipped when `claude-prompt.lint.<configKey>` is false. */
  readonly configKey?: string
  /** If true, the rule is skipped when no workspace root is available. */
  readonly needsWorkspaceRoot?: boolean
  run(ctx: LintContext): vscode.Diagnostic[]
}

export function makeRange(document: vscode.TextDocument, lineIndex: number): vscode.Range {
  return document.lineAt(lineIndex).range
}

export function makeDiag(
  range: vscode.Range,
  message: string,
  severity: vscode.DiagnosticSeverity,
  code: string,
): vscode.Diagnostic {
  const diag = new vscode.Diagnostic(range, message, severity)
  diag.source = LINT_SOURCE
  diag.code = code
  return diag
}
