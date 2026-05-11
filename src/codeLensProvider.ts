import * as vscode from 'vscode'
import { countTokens } from './tokenizer'

export class CodeLensProvider implements vscode.CodeLensProvider {
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>()
  readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event

  private disposables: vscode.Disposable[] = []

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.fileName.endsWith('.prompt.md')) {
          this._onDidChangeCodeLenses.fire()
        }
      }),
    )
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const topRange = new vscode.Range(0, 0, 0, 0)
    const tokens = countTokens(document.getText())

    const tokenLens = new vscode.CodeLens(topRange, {
      title: `⚡ ~${tokens} tokens`,
      command: 'claude-prompt.showTokenBreakdown',
      tooltip: 'Click to see token breakdown by section',
    })

    const runLens = new vscode.CodeLens(topRange, {
      title: '▶ Run in Claude',
      command: 'claude-prompt.run',
      tooltip: 'Open Claude Code in the integrated terminal',
    })

    const optionsLens = new vscode.CodeLens(topRange, {
      title: '⚙ Run with options',
      command: 'claude-prompt.runWithOptions',
      tooltip: 'Pick model, thinking, and extra flags',
    })

    return [runLens, optionsLens, tokenLens]
  }

  dispose(): void {
    this._onDidChangeCodeLenses.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}
