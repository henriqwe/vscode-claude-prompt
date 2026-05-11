import * as vscode from 'vscode'
import { countTokens } from './tokenizer'

const OUTPUT_CHANNEL_NAME = 'Claude Prompt — Token Breakdown'

export class TokenStatusBar implements vscode.Disposable {
  private item: vscode.StatusBarItem
  private outputChannel: vscode.OutputChannel
  private disposables: vscode.Disposable[] = []

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.item.command = 'claude-prompt.showTokenBreakdown'
    this.outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME)

    this.disposables.push(
      vscode.commands.registerCommand('claude-prompt.showTokenBreakdown', () =>
        this.showBreakdown(),
      ),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && isPromptFile(editor.document)) {
          this.update(editor.document)
          this.item.show()
        } else {
          this.item.hide()
        }
      }),
      vscode.workspace.onDidChangeTextDocument(e => {
        const active = vscode.window.activeTextEditor
        if (active && active.document === e.document && isPromptFile(e.document)) {
          this.update(e.document)
        }
      }),
    )

    // initialize for the currently active editor
    const active = vscode.window.activeTextEditor
    if (active && isPromptFile(active.document)) {
      this.update(active.document)
      this.item.show()
    }
  }

  private update(document: vscode.TextDocument): void {
    const tokens = countTokens(document.getText())
    this.item.text = `⚡ ~${tokens} tokens`
    this.item.tooltip = 'Click to see token breakdown by section'
  }

  private showBreakdown(): void {
    const editor = vscode.window.activeTextEditor
    if (!editor || !isPromptFile(editor.document)) return

    const text = editor.document.getText()
    const sections = parseSections(text)

    this.outputChannel.clear()
    this.outputChannel.appendLine(`Token breakdown — ${editor.document.fileName}`)
    this.outputChannel.appendLine('─'.repeat(60))

    let total = 0
    for (const { heading, content } of sections) {
      const tokens = countTokens(content)
      total += tokens
      this.outputChannel.appendLine(`${heading.padEnd(40)} ~${tokens} tokens`)
    }

    this.outputChannel.appendLine('─'.repeat(60))
    this.outputChannel.appendLine(`${'TOTAL'.padEnd(40)} ~${total} tokens`)
    this.outputChannel.show(true)
  }

  dispose(): void {
    this.item.dispose()
    this.outputChannel.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}

function isPromptFile(doc: vscode.TextDocument): boolean {
  return doc.fileName.endsWith('.prompt.md')
}

function parseSections(text: string): Array<{ heading: string; content: string }> {
  const lines = text.split('\n')
  const sections: Array<{ heading: string; content: string }> = []
  let currentHeading = '(preamble)'
  let currentLines: string[] = []

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      sections.push({ heading: currentHeading, content: currentLines.join('\n') })
      currentHeading = line.replace(/^#+\s*/, '')
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }
  sections.push({ heading: currentHeading, content: currentLines.join('\n') })

  return sections.filter(s => s.content.trim())
}
