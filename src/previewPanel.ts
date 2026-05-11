import * as vscode from 'vscode'
import { expand, ExpansionResult } from './promptExpander'
import { SkillRegistry } from './skillRegistry'
import { countTokens } from './tokenizer'

const DEBOUNCE_MS = 300

export class PreviewPanel implements vscode.Disposable {
  private static current: PreviewPanel | null = null

  private panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []
  private timer: NodeJS.Timeout | null = null
  private sourceUri: vscode.Uri

  static show(registry: SkillRegistry, source: vscode.TextDocument): void {
    if (PreviewPanel.current) {
      PreviewPanel.current.sourceUri = source.uri
      PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside, true)
      PreviewPanel.current.render()
      return
    }
    PreviewPanel.current = new PreviewPanel(registry, source)
  }

  private constructor(private registry: SkillRegistry, source: vscode.TextDocument) {
    this.sourceUri = source.uri
    this.panel = vscode.window.createWebviewPanel(
      'claudePromptPreview',
      'Prompt Preview',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    )

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.uri.toString() === this.sourceUri.toString()) this.schedule()
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (editor && editor.document.fileName.endsWith('.prompt.md')) {
          this.sourceUri = editor.document.uri
          this.schedule()
        }
      }),
      this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg)),
    )

    this.render()
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.timer = null; this.render() }, DEBOUNCE_MS)
  }

  private async handleMessage(msg: any): Promise<void> {
    if (msg?.kind === 'jumpTo' && typeof msg.line === 'number') {
      const doc = await vscode.workspace.openTextDocument(this.sourceUri)
      const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One)
      const pos = new vscode.Position(msg.line, 0)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
      editor.selection = new vscode.Selection(pos, pos)
    } else if (msg?.kind === 'copy' && typeof msg.text === 'string') {
      await vscode.env.clipboard.writeText(msg.text)
      vscode.window.showInformationMessage('Expanded prompt copied.')
    }
  }

  private async render(): Promise<void> {
    let doc: vscode.TextDocument
    try {
      doc = await vscode.workspace.openTextDocument(this.sourceUri)
    } catch {
      this.panel.webview.html = renderHtml({ error: 'Source document closed.' })
      return
    }
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ?? ''
    const result = await expand(doc.getText(), { workspaceRoot, registry: this.registry })
    const total = countTokens(result.expanded)
    this.panel.title = `Preview: ${doc.fileName.split('/').pop()}`
    this.panel.webview.html = renderHtml({ result, total })
  }

  dispose(): void {
    PreviewPanel.current = null
    if (this.timer) clearTimeout(this.timer)
    this.panel.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ))
}

function renderHtml(state: { result?: ExpansionResult; total?: number; error?: string }): string {
  if (state.error) {
    return `<!doctype html><html><body><p>${escapeHtml(state.error)}</p></body></html>`
  }
  const result = state.result!
  const total = state.total ?? 0

  const sectionsHtml = result.sections.map(s => `
    <div class="section">
      <div class="chip" data-line="${s.range.startLine}">
        <span class="kind kind-${s.kind}">${s.kind}</span>
        <span class="src">${escapeHtml(s.source || '(inline)')}</span>
        <span class="tok">${s.tokens} tokens</span>
      </div>
    </div>
  `).join('')

  const unresolvedHtml = result.unresolved.length
    ? `<div class="unresolved">
        <h3>Unresolved (${result.unresolved.length})</h3>
        <ul>${result.unresolved.map(u =>
          `<li><code>${escapeHtml(u.kind)}: ${escapeHtml(u.ref)}</code> — ${escapeHtml(u.reason)}</li>`).join('')}</ul>
      </div>`
    : ''

  const escapedExpanded = escapeHtml(result.expanded)

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: var(--vscode-font-family); padding: 12px; color: var(--vscode-foreground); }
    header { display: flex; align-items: center; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .total { font-weight: 600; }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 10px; cursor: pointer; }
    .section { margin: 6px 0; }
    .chip { display: inline-flex; gap: 8px; padding: 2px 8px; border-radius: 3px; background: var(--vscode-editor-inactiveSelectionBackground); cursor: pointer; font-size: 12px; }
    .kind { font-weight: 600; text-transform: uppercase; font-size: 10px; }
    .kind-file { color: #5db0ff; }
    .kind-skill { color: #c586ff; }
    .kind-include { color: #ffb86b; }
    .tok { opacity: 0.8; }
    .unresolved { margin-top: 16px; padding: 8px; border: 1px solid #d04444; border-radius: 4px; }
    pre { background: var(--vscode-textCodeBlock-background); padding: 8px; overflow: auto; white-space: pre-wrap; max-height: 60vh; }
  </style></head><body>
    <header>
      <span class="total">⚡ ${total} tokens</span>
      <span>${result.sections.length} section(s)</span>
      <button onclick="copyExpanded()">Copy expanded</button>
    </header>
    ${sectionsHtml}
    ${unresolvedHtml}
    <h3>Expanded prompt</h3>
    <pre id="expanded">${escapedExpanded}</pre>
    <script>
      const vscode = acquireVsCodeApi()
      document.querySelectorAll('.chip').forEach(el => {
        el.addEventListener('click', () => {
          vscode.postMessage({ kind: 'jumpTo', line: Number(el.dataset.line) })
        })
      })
      function copyExpanded() {
        const text = document.getElementById('expanded').textContent || ''
        vscode.postMessage({ kind: 'copy', text })
      }
    </script>
  </body></html>`
}
