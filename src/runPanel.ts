import * as vscode from 'vscode'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { RunHistory, RunRecord } from './runHistory'
import { countTokens } from './tokenizer'

export interface RunPanelInput {
  filePath: string
  tempPath: string
  expandedText: string
  model: string
  args: string[]
}

export class RunPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []
  private child: ChildProcessWithoutNullStreams | null = null
  private buffer = ''
  private startedAt = 0

  constructor(private readonly history: RunHistory, private readonly input: RunPanelInput) {
    this.panel = vscode.window.createWebviewPanel(
      'claudePromptRun',
      `Claude · ${pathBase(input.filePath)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    this.panel.webview.html = renderHtml({ output: '', running: true, model: input.model })

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg)),
    )

    this.start()
  }

  static replay(history: RunHistory, record: RunRecord): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'claudePromptRun',
      `Claude · ${record.fileLabel} (replay)`,
      vscode.ViewColumn.Beside,
      { enableScripts: true },
    )
    panel.webview.html = renderHtml({
      output: record.output,
      running: false,
      model: record.model,
      exitCode: record.exitCode ?? undefined,
      durationMs: record.durationMs,
    })
    return panel
  }

  private start(): void {
    this.startedAt = Date.now()
    this.child = spawn('claude', this.input.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdin.write(this.input.expandedText)
    this.child.stdin.end()

    this.child.stdout.on('data', chunk => this.appendChunk(chunk.toString('utf8')))
    this.child.stderr.on('data', chunk => this.appendChunk(chunk.toString('utf8')))
    this.child.on('error', err => this.appendChunk(`\n[error spawning claude: ${err.message}]\n`))
    this.child.on('close', code => this.finish(code))
  }

  private appendChunk(text: string): void {
    this.buffer += text
    this.panel.webview.postMessage({ kind: 'append', text })
  }

  private async finish(exitCode: number | null): Promise<void> {
    const durationMs = Date.now() - this.startedAt
    this.panel.webview.postMessage({ kind: 'done', exitCode, durationMs })
    const record: RunRecord = {
      id: randomUUID(),
      filePath: this.input.filePath,
      fileLabel: pathBase(this.input.filePath),
      timestamp: this.startedAt,
      durationMs,
      exitCode,
      model: this.input.model,
      tokensIn: countTokens(this.input.expandedText),
      tokensOut: countTokens(this.buffer),
      output: this.buffer,
    }
    await this.history.add(record)
    this.child = null
  }

  private handleMessage(msg: any): void {
    if (msg?.kind === 'cancel' && this.child) {
      this.child.kill('SIGINT')
    }
  }

  dispose(): void {
    if (this.child && !this.child.killed) this.child.kill('SIGINT')
    this.panel.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}

function pathBase(p: string): string {
  return p.split('/').pop() ?? p
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ))
}

function renderHtml(state: { output: string; running: boolean; model: string; exitCode?: number; durationMs?: number }): string {
  const status = state.running
    ? '<span class="dot running"></span> running'
    : state.exitCode === 0
      ? '<span class="dot ok"></span> done'
      : `<span class="dot err"></span> exit ${state.exitCode ?? '?'}`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { font-family: var(--vscode-editor-font-family, monospace); padding: 12px; color: var(--vscode-foreground); }
    header { display: flex; align-items: center; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; vertical-align: middle; margin-right: 6px; }
    .dot.running { background: #f0b400; animation: pulse 1.4s infinite; }
    .dot.ok { background: #2ea043; }
    .dot.err { background: #d04444; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
    pre { white-space: pre-wrap; word-break: break-word; padding: 8px; background: var(--vscode-textCodeBlock-background); }
    button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 4px 10px; cursor: pointer; }
  </style></head><body>
    <header>
      <span>${status}</span>
      <span>${escapeHtml(state.model)}</span>
      ${state.durationMs ? `<span>${Math.round(state.durationMs / 1000)}s</span>` : ''}
      ${state.running ? '<button onclick="cancel()">Cancel</button>' : ''}
    </header>
    <pre id="out">${escapeHtml(state.output)}</pre>
    <script>
      const vscode = acquireVsCodeApi()
      const out = document.getElementById('out')
      window.addEventListener('message', e => {
        const msg = e.data
        if (msg.kind === 'append') {
          out.textContent += msg.text
          window.scrollTo(0, document.body.scrollHeight)
        } else if (msg.kind === 'done') {
          location.reload()
        }
      })
      function cancel() { vscode.postMessage({ kind: 'cancel' }) }
    </script>
  </body></html>`
}
