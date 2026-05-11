import * as vscode from 'vscode'
import { expand, ExpandedSection } from './promptExpander'
import { SkillRegistry } from './skillRegistry'

const DEBOUNCE_MS = 300

export class TokenDecorations implements vscode.Disposable {
  private enabled = true
  private disposables: vscode.Disposable[] = []
  private timers = new Map<string, NodeJS.Timeout>()

  private green: vscode.TextEditorDecorationType
  private yellow: vscode.TextEditorDecorationType
  private red: vscode.TextEditorDecorationType

  constructor(private readonly registry: SkillRegistry) {
    this.green = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(120, 200, 120, 0.08)',
      isWholeLine: true,
    })
    this.yellow = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(230, 200, 80, 0.10)',
      isWholeLine: true,
    })
    this.red = vscode.window.createTextEditorDecorationType({
      backgroundColor: 'rgba(230, 100, 100, 0.12)',
      isWholeLine: true,
    })

    this.enabled = vscode.workspace
      .getConfiguration('claude-prompt')
      .get<boolean>('decorations.enabled', true)

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        const editor = vscode.window.activeTextEditor
        if (!editor || editor.document !== e.document) return
        if (!editor.document.fileName.endsWith('.prompt.md')) return
        this.schedule(editor)
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && editor.document.fileName.endsWith('.prompt.md')) this.schedule(editor)
      }),
      vscode.workspace.onDidChangeConfiguration(e => {
        if (!e.affectsConfiguration('claude-prompt.decorations')) return
        this.enabled = vscode.workspace
          .getConfiguration('claude-prompt')
          .get<boolean>('decorations.enabled', true)
        this.refreshAll()
      }),
      vscode.commands.registerCommand('claude-prompt.toggleDecorations', () => this.toggle()),
    )

    const active = vscode.window.activeTextEditor
    if (active && active.document.fileName.endsWith('.prompt.md')) this.schedule(active)
  }

  private async toggle(): Promise<void> {
    this.enabled = !this.enabled
    await vscode.workspace
      .getConfiguration('claude-prompt')
      .update('decorations.enabled', this.enabled, vscode.ConfigurationTarget.Global)
    this.refreshAll()
  }

  private refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.fileName.endsWith('.prompt.md')) this.apply(editor)
    }
  }

  private schedule(editor: vscode.TextEditor): void {
    const key = editor.document.uri.toString()
    const existing = this.timers.get(key)
    if (existing) clearTimeout(existing)
    this.timers.set(key, setTimeout(() => {
      this.timers.delete(key)
      this.apply(editor)
    }, DEBOUNCE_MS))
  }

  private async apply(editor: vscode.TextEditor): Promise<void> {
    if (!this.enabled) {
      editor.setDecorations(this.green, [])
      editor.setDecorations(this.yellow, [])
      editor.setDecorations(this.red, [])
      return
    }

    const workspaceRoot = vscode.workspace.getWorkspaceFolder(editor.document.uri)?.uri.fsPath
    if (!workspaceRoot) return

    const result = await expand(editor.document.getText(), {
      workspaceRoot,
      registry: this.registry,
    })

    const buckets = { green: [] as vscode.DecorationOptions[], yellow: [] as vscode.DecorationOptions[], red: [] as vscode.DecorationOptions[] }
    for (const section of result.sections) {
      const bucket = section.tokens < 500 ? buckets.green : section.tokens < 2000 ? buckets.yellow : buckets.red
      bucket.push({
        range: toVsRange(section),
        hoverMessage: `${section.kind} · ${section.tokens} tokens · ${section.source}`,
      })
    }
    editor.setDecorations(this.green, buckets.green)
    editor.setDecorations(this.yellow, buckets.yellow)
    editor.setDecorations(this.red, buckets.red)
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.green.dispose()
    this.yellow.dispose()
    this.red.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}

function toVsRange(section: ExpandedSection): vscode.Range {
  return new vscode.Range(
    section.range.startLine,
    section.range.startCol,
    section.range.endLine,
    section.range.endCol,
  )
}
