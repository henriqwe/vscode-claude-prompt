import * as vscode from 'vscode'
import { SkillRegistry } from './skillRegistry'
import { ALL_RULES, LintContext } from './lint/index'

export { findFileRefs, findSkillInvocations } from './lint/index'

const SOURCE = 'claude-prompt'

function isLintEnabled(rule: string): boolean {
  return vscode.workspace.getConfiguration('claude-prompt').get<boolean>(`lint.${rule}`, true)
}

function isPromptFile(doc: vscode.TextDocument): boolean {
  return doc.fileName.endsWith('.prompt.md')
}

/**
 * Runs all lint rules against every `.prompt.md` document and publishes diagnostics
 * to a single `DiagnosticCollection`. Re-lints on text change, file open/close,
 * registry change (new/removed skills), and `claude-prompt.lint.*` config change.
 */
export class LintProvider implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection
  private disposables: vscode.Disposable[] = []

  constructor(private readonly registry: SkillRegistry) {
    this.collection = vscode.languages.createDiagnosticCollection(SOURCE)

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (isPromptFile(e.document)) this.lint(e.document)
      }),
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (isPromptFile(doc)) this.lint(doc)
      }),
      vscode.workspace.onDidCloseTextDocument(doc => {
        this.collection.delete(doc.uri)
      }),
      registry.onDidChange(() => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (isPromptFile(editor.document)) this.lint(editor.document)
        }
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('claude-prompt.lint')) return
        for (const editor of vscode.window.visibleTextEditors) {
          if (isPromptFile(editor.document)) this.lint(editor.document)
        }
      }),
    )
  }

  lint(document: vscode.TextDocument): void {
    const text = document.getText()
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath
    const ctx: LintContext = { document, text, registry: this.registry, workspaceRoot }

    const diagnostics = ALL_RULES.flatMap(rule => {
      if (rule.configKey && !isLintEnabled(rule.configKey)) return []
      if (rule.needsWorkspaceRoot && !workspaceRoot) return []
      return rule.run(ctx)
    })

    this.collection.set(document.uri, diagnostics)
  }

  dispose(): void {
    this.collection.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}
