import * as vscode from 'vscode'
import { SkillRegistry } from './skillRegistry'
import { CompletionProvider } from './completionProvider'
import { HoverProvider } from './hoverProvider'
import { LintProvider } from './lintProvider'
import { TokenStatusBar } from './statusBarItem'

const PROMPT_SELECTOR: vscode.DocumentSelector = [
  { pattern: '**/*.prompt.md', scheme: 'file' },
]

export function activate(context: vscode.ExtensionContext): void {
  const registry = new SkillRegistry()
  const lintProvider = new LintProvider(registry)
  const statusBar = new TokenStatusBar()

  context.subscriptions.push(
    registry,
    lintProvider,
    statusBar,
    vscode.languages.registerCompletionItemProvider(
      PROMPT_SELECTOR,
      new CompletionProvider(registry),
      '/',
    ),
    vscode.languages.registerHoverProvider(PROMPT_SELECTOR, new HoverProvider(registry)),
  )

  // lint any already-open prompt files
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.fileName.endsWith('.prompt.md')) lintProvider.lint(doc)
  }
}

export function deactivate(): void {
  // VS Code disposes context.subscriptions automatically
}
