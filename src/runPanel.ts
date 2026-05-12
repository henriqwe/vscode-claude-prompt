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

type WebviewEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool-start'; id: string; name: string; input: unknown }
  | { kind: 'tool-result'; id: string; output: string; isError: boolean }
  | { kind: 'system'; model?: string; sessionId?: string; cwd?: string; tools?: string[] }
  | { kind: 'log'; text: string }
  | { kind: 'done'; exitCode: number | null; durationMs: number; stats?: ResultStats }

interface ResultStats {
  numTurns?: number
  totalCostUsd?: number
  inputTokens?: number
  outputTokens?: number
}

export class RunPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []
  private child: ChildProcessWithoutNullStreams | null = null
  private textBuffer = ''
  private lineBuffer = ''
  private startedAt = 0
  private stats: ResultStats = {}

  constructor(private readonly history: RunHistory, private readonly input: RunPanelInput) {
    this.panel = vscode.window.createWebviewPanel(
      'claudePromptRun',
      `Claude · ${pathBase(input.filePath)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    this.panel.webview.html = renderHtml({ running: true, model: input.model, output: '' })

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
    const args = [
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      ...this.input.args,
    ]
    this.child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', TERM: 'dumb', NO_COLOR: '1' },
    })
    this.child.stdin.write(this.input.expandedText)
    this.child.stdin.end()

    this.child.stdout.on('data', chunk => this.handleStdout(chunk.toString('utf8')))
    this.child.stderr.on('data', chunk => this.post({ kind: 'log', text: stripAnsi(chunk.toString('utf8')) }))
    this.child.on('error', err => this.post({ kind: 'log', text: `[error spawning claude: ${err.message}]` }))
    this.child.on('close', code => this.finish(code))
  }

  private handleStdout(chunk: string): void {
    this.lineBuffer += chunk
    let nl: number
    while ((nl = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, nl).trim()
      this.lineBuffer = this.lineBuffer.slice(nl + 1)
      if (line) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let evt: any
    try { evt = JSON.parse(line) } catch {
      // Fallback: treat as plain text
      this.textBuffer += line + '\n'
      this.post({ kind: 'text', text: line + '\n' })
      return
    }
    if (!evt || typeof evt !== 'object') return

    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init') {
          this.post({
            kind: 'system',
            model: evt.model,
            sessionId: evt.session_id,
            cwd: evt.cwd,
            tools: Array.isArray(evt.tools) ? evt.tools : undefined,
          })
        }
        break
      case 'assistant':
        this.handleAssistant(evt.message)
        break
      case 'user':
        this.handleUserToolResult(evt.message)
        break
      case 'result':
        if (typeof evt.result === 'string' && this.textBuffer === '') {
          this.textBuffer = evt.result
          this.post({ kind: 'text', text: evt.result })
        }
        this.stats = {
          numTurns: evt.num_turns,
          totalCostUsd: evt.total_cost_usd,
          inputTokens: evt.usage?.input_tokens,
          outputTokens: evt.usage?.output_tokens,
        }
        break
    }
  }

  private handleAssistant(message: any): void {
    const content = message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') {
        this.textBuffer += block.text
        this.post({ kind: 'text', text: block.text })
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        this.post({ kind: 'thinking', text: block.thinking })
      } else if (block.type === 'tool_use') {
        this.post({ kind: 'tool-start', id: block.id, name: block.name, input: block.input })
      }
    }
  }

  private handleUserToolResult(message: any): void {
    const content = message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_result') {
        const out = typeof block.content === 'string'
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((c: any) => c?.text ?? '').join('')
            : ''
        this.post({
          kind: 'tool-result',
          id: block.tool_use_id,
          output: out,
          isError: !!block.is_error,
        })
      }
    }
  }

  private post(evt: WebviewEvent): void {
    this.panel.webview.postMessage(evt)
  }

  private async finish(exitCode: number | null): Promise<void> {
    const durationMs = Date.now() - this.startedAt
    if (this.lineBuffer.trim()) {
      this.handleLine(this.lineBuffer.trim())
      this.lineBuffer = ''
    }
    this.post({ kind: 'done', exitCode, durationMs, stats: this.stats })
    const record: RunRecord = {
      id: randomUUID(),
      filePath: this.input.filePath,
      fileLabel: pathBase(this.input.filePath),
      timestamp: this.startedAt,
      durationMs,
      exitCode,
      model: this.input.model,
      tokensIn: this.stats.inputTokens ?? countTokens(this.input.expandedText),
      tokensOut: this.stats.outputTokens ?? countTokens(this.textBuffer),
      output: this.textBuffer,
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

function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b[=>]/g, '')
}

function pathBase(p: string): string {
  return p.split('/').pop() ?? p
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
  ))
}

interface RenderState {
  output: string
  running: boolean
  model: string
  exitCode?: number
  durationMs?: number
}

function renderHtml(state: RenderState): string {
  const initialStatus = state.running ? 'Thinking' : state.exitCode === 0 ? 'Done' : `Exit ${state.exitCode ?? '?'}`
  const initialDot = state.running ? 'running' : state.exitCode === 0 ? 'ok' : 'err'
  const initialDuration = state.durationMs ? formatDurationStatic(state.durationMs) : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    :root {
      --gap: 12px;
      --radius: 6px;
      --muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --bg-soft: var(--vscode-editorWidget-background);
      --bg-code: var(--vscode-textCodeBlock-background);
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 0;
      margin: 0;
    }
    .container { padding: 16px; max-width: 980px; margin: 0 auto; }
    header {
      display: flex; align-items: center; gap: var(--gap);
      padding: 10px 12px;
      background: var(--bg-soft);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 14px;
      position: sticky; top: 8px; z-index: 5;
      backdrop-filter: blur(6px);
    }
    .status { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
    .dot.running {
      background: #f0b400;
      box-shadow: 0 0 0 0 rgba(240,180,0,0.6);
      animation: pulse 1.6s infinite;
    }
    .dot.ok { background: #2ea043; }
    .dot.err { background: #d04444; }
    @keyframes pulse {
      0%   { box-shadow: 0 0 0 0 rgba(240,180,0,0.55); }
      70%  { box-shadow: 0 0 0 10px rgba(240,180,0,0); }
      100% { box-shadow: 0 0 0 0 rgba(240,180,0,0); }
    }
    .pill {
      padding: 2px 8px; border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 0.85em;
    }
    .muted { color: var(--muted); font-size: 0.9em; }
    .grow { flex: 1; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 0; padding: 4px 12px; cursor: pointer;
      border-radius: 4px; font-size: 0.9em;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary {
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--border);
    }
    button[hidden] { display: none; }

    section.progress {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 14px;
      overflow: hidden;
    }
    section.progress summary {
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      background: var(--bg-soft);
      list-style: none;
      display: flex; align-items: center; gap: 8px;
    }
    section.progress summary::-webkit-details-marker { display: none; }
    section.progress summary::before {
      content: '▸'; transition: transform 0.15s ease;
      color: var(--muted);
    }
    section.progress[open] summary::before { transform: rotate(90deg); }
    section.progress .items { padding: 6px 12px 10px; }
    .step {
      border-left: 2px solid var(--border);
      padding: 6px 10px;
      margin: 6px 0;
      font-size: 0.92em;
    }
    .step.thinking { border-color: #b08af0; }
    .step.tool { border-color: #4fa3ff; }
    .step.tool.done { border-color: #2ea043; }
    .step.tool.error { border-color: #d04444; }
    .step .label {
      font-weight: 600;
      display: flex; align-items: center; gap: 6px;
    }
    .step .label .name { font-family: var(--vscode-editor-font-family, monospace); }
    .step pre {
      margin: 4px 0 0; padding: 6px 8px;
      background: var(--bg-code);
      border-radius: 4px;
      overflow-x: auto;
      font-size: 0.9em;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 180px; overflow-y: auto;
    }

    #output {
      line-height: 1.55;
    }
    #output h1, #output h2, #output h3, #output h4 { margin: 1em 0 0.4em; line-height: 1.25; }
    #output h1 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
    #output h2 { font-size: 1.25em; }
    #output h3 { font-size: 1.1em; }
    #output p { margin: 0.6em 0; }
    #output ul, #output ol { padding-left: 1.6em; margin: 0.5em 0; }
    #output li { margin: 0.2em 0; }
    #output blockquote {
      border-left: 3px solid var(--border);
      padding: 2px 12px;
      margin: 0.6em 0;
      color: var(--muted);
    }
    #output code {
      background: var(--bg-code);
      padding: 1px 5px;
      border-radius: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
    }
    #output pre {
      background: var(--bg-code);
      padding: 10px 12px;
      border-radius: var(--radius);
      overflow-x: auto;
      font-size: 0.9em;
      line-height: 1.45;
    }
    #output pre code { background: transparent; padding: 0; }
    #output a { color: var(--vscode-textLink-foreground); }
    #output hr { border: 0; border-top: 1px solid var(--border); margin: 1em 0; }
    #output table {
      border-collapse: collapse; margin: 0.8em 0;
      display: block; max-width: 100%; overflow-x: auto;
      font-size: 0.95em;
    }
    #output th, #output td {
      border: 1px solid var(--border);
      padding: 6px 10px; vertical-align: top;
    }
    #output thead th {
      background: var(--bg-soft);
      font-weight: 600;
      text-align: left;
    }
    #output tbody tr:nth-child(even) { background: var(--bg-soft); }

    .cursor {
      display: inline-block; width: 7px; height: 1em;
      vertical-align: text-bottom; background: var(--vscode-foreground);
      margin-left: 1px; animation: blink 1s infinite;
    }
    @keyframes blink { 50% { opacity: 0; } }

    .empty { color: var(--muted); font-style: italic; }
  </style></head><body>
    <div class="container">
      <header>
        <span class="status"><span id="dot" class="dot ${initialDot}"></span><span id="status">${initialStatus}</span></span>
        <span class="pill" id="modelPill">${escapeHtml(state.model)}</span>
        <span class="muted" id="elapsed">${initialDuration}</span>
        <span class="muted" id="stats"></span>
        <span class="grow"></span>
        <button id="copyBtn" class="secondary" onclick="copyOutput()">Copy</button>
        <button id="cancelBtn" onclick="cancel()" ${state.running ? '' : 'hidden'}>Cancel</button>
      </header>

      <section class="progress" id="progress" ${state.running ? 'open' : ''} hidden>
        <summary><span>Activity</span><span class="muted" id="stepCount"></span></summary>
        <div class="items" id="steps"></div>
      </section>

      <div id="output">${state.output ? '' : '<div class="empty" id="placeholder">Waiting for response…</div>'}</div>
    </div>
    <script>
      const vscode = acquireVsCodeApi()
      const out = document.getElementById('output')
      const placeholder = document.getElementById('placeholder')
      const statusEl = document.getElementById('status')
      const dotEl = document.getElementById('dot')
      const elapsedEl = document.getElementById('elapsed')
      const statsEl = document.getElementById('stats')
      const cancelBtn = document.getElementById('cancelBtn')
      const progressEl = document.getElementById('progress')
      const stepsEl = document.getElementById('steps')
      const stepCount = document.getElementById('stepCount')
      const modelPill = document.getElementById('modelPill')

      let textBuffer = ${JSON.stringify(state.output || '')}
      let stepN = 0
      let running = ${state.running ? 'true' : 'false'}
      const startedAt = Date.now() - ${state.durationMs ?? 0}
      const toolNodes = new Map()

      if (textBuffer) renderOutput()

      function renderOutput() {
        if (placeholder) placeholder.remove()
        const html = renderMarkdown(textBuffer) + (running ? '<span class="cursor"></span>' : '')
        out.innerHTML = html
        window.scrollTo(0, document.body.scrollHeight)
      }

      function addStep(node) {
        progressEl.hidden = false
        stepsEl.appendChild(node)
        stepN++
        stepCount.textContent = stepN + ' step' + (stepN === 1 ? '' : 's')
      }

      function makeStep(cls, label, body) {
        const div = document.createElement('div')
        div.className = 'step ' + cls
        const labelDiv = document.createElement('div')
        labelDiv.className = 'label'
        labelDiv.innerHTML = label
        div.appendChild(labelDiv)
        if (body) {
          const pre = document.createElement('pre')
          pre.textContent = body
          div.appendChild(pre)
        }
        return div
      }

      window.addEventListener('message', e => {
        const msg = e.data
        if (!msg || typeof msg !== 'object') return
        switch (msg.kind) {
          case 'text': {
            if (typeof msg.text === 'string') {
              textBuffer += msg.text
              renderOutput()
            }
            break
          }
          case 'thinking': {
            const node = makeStep('thinking', '<span>🧠 Thinking</span>', String(msg.text || ''))
            addStep(node)
            break
          }
          case 'tool-start': {
            const inputStr = typeof msg.input === 'string' ? msg.input : safeJson(msg.input)
            const node = makeStep('tool', '<span>🔧 <span class="name">' + escapeHtmlJs(String(msg.name || 'tool')) + '</span></span>', inputStr)
            toolNodes.set(msg.id, node)
            addStep(node)
            break
          }
          case 'tool-result': {
            const node = toolNodes.get(msg.id)
            if (node) {
              node.classList.add(msg.isError ? 'error' : 'done')
              const result = document.createElement('pre')
              result.textContent = (msg.isError ? '⚠ ' : '✓ ') + String(msg.output || '')
              node.appendChild(result)
            }
            break
          }
          case 'system': {
            if (msg.model) modelPill.textContent = msg.model
            break
          }
          case 'log': {
            if (msg.text && msg.text.trim()) {
              const node = makeStep('tool error', '<span>⚠ stderr</span>', msg.text)
              addStep(node)
            }
            break
          }
          case 'done': {
            running = false
            dotEl.className = 'dot ' + (msg.exitCode === 0 ? 'ok' : 'err')
            statusEl.textContent = msg.exitCode === 0 ? 'Done' : ('Exit ' + (msg.exitCode ?? '?'))
            elapsedEl.textContent = formatDuration(msg.durationMs)
            cancelBtn.hidden = true
            if (msg.stats) {
              const parts = []
              if (msg.stats.inputTokens != null) parts.push(msg.stats.inputTokens + ' in')
              if (msg.stats.outputTokens != null) parts.push(msg.stats.outputTokens + ' out')
              if (msg.stats.totalCostUsd != null) parts.push('$' + msg.stats.totalCostUsd.toFixed(4))
              if (parts.length) statsEl.textContent = '· ' + parts.join(' · ')
            }
            renderOutput()
            break
          }
        }
      })

      function cancel() { vscode.postMessage({ kind: 'cancel' }) }
      function copyOutput() {
        navigator.clipboard.writeText(textBuffer)
        const btn = document.getElementById('copyBtn')
        const orig = btn.textContent
        btn.textContent = 'Copied'
        setTimeout(() => { btn.textContent = orig }, 1200)
      }

      function safeJson(v) { try { return JSON.stringify(v, null, 2) } catch { return String(v) } }
      function escapeHtmlJs(s) {
        return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
      }

      function tick() {
        if (running) {
          elapsedEl.textContent = formatDuration(Date.now() - startedAt)
          requestAnimationFrame(() => setTimeout(tick, 250))
        }
      }
      if (running) tick()
      function formatDuration(ms) {
        if (ms == null) return ''
        const s = Math.floor(ms / 1000)
        if (s < 60) return s + '.' + Math.floor((ms % 1000) / 100) + 's'
        return Math.floor(s / 60) + 'm ' + (s % 60) + 's'
      }

      // ---- Minimal Markdown renderer (block + inline) ----
      function renderMarkdown(src) {
        const lines = src.split('\\n')
        const out = []
        let i = 0
        while (i < lines.length) {
          const line = lines[i]
          // Fenced code block
          const fence = /^\`\`\`(\\S*)\\s*$/.exec(line)
          if (fence) {
            const lang = fence[1] || ''
            const code = []
            i++
            while (i < lines.length && !/^\`\`\`\\s*$/.test(lines[i])) {
              code.push(lines[i]); i++
            }
            if (i < lines.length) i++ // skip closing fence
            out.push('<pre><code class="language-' + escapeHtmlJs(lang) + '">' + escapeHtmlJs(code.join('\\n')) + '</code></pre>')
            continue
          }
          // ATX heading
          const h = /^(#{1,6})\\s+(.*)$/.exec(line)
          if (h) {
            const level = h[1].length
            out.push('<h' + level + '>' + renderInline(h[2]) + '</h' + level + '>')
            i++; continue
          }
          // GFM table: header row followed by separator row
          if (/\\|/.test(line) && i + 1 < lines.length && /^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)+\\|?\\s*$/.test(lines[i + 1])) {
            const headerCells = splitTableRow(line)
            const aligns = splitTableRow(lines[i + 1]).map(c => {
              const left = c.startsWith(':')
              const right = c.endsWith(':')
              if (left && right) return 'center'
              if (right) return 'right'
              if (left) return 'left'
              return ''
            })
            i += 2
            const bodyRows = []
            while (i < lines.length && /\\|/.test(lines[i]) && lines[i].trim()) {
              bodyRows.push(splitTableRow(lines[i]))
              i++
            }
            const thead = '<thead><tr>' + headerCells.map((c, idx) =>
              '<th' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' + renderInline(c) + '</th>'
            ).join('') + '</tr></thead>'
            const tbody = '<tbody>' + bodyRows.map(row =>
              '<tr>' + row.map((c, idx) =>
                '<td' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' + renderInline(c) + '</td>'
              ).join('') + '</tr>'
            ).join('') + '</tbody>'
            out.push('<table>' + thead + tbody + '</table>')
            continue
          }
          // Horizontal rule
          if (/^---+\\s*$/.test(line) || /^\\*\\*\\*+\\s*$/.test(line)) {
            out.push('<hr/>'); i++; continue
          }
          // Blockquote
          if (/^>\\s?/.test(line)) {
            const quote = []
            while (i < lines.length && /^>\\s?/.test(lines[i])) {
              quote.push(lines[i].replace(/^>\\s?/, '')); i++
            }
            out.push('<blockquote>' + renderMarkdown(quote.join('\\n')) + '</blockquote>')
            continue
          }
          // Lists
          if (/^\\s*[-*+]\\s+/.test(line) || /^\\s*\\d+\\.\\s+/.test(line)) {
            const ordered = /^\\s*\\d+\\.\\s+/.test(line)
            const items = []
            while (i < lines.length && (ordered ? /^\\s*\\d+\\.\\s+/.test(lines[i]) : /^\\s*[-*+]\\s+/.test(lines[i]))) {
              const m = ordered ? /^\\s*\\d+\\.\\s+(.*)$/.exec(lines[i]) : /^\\s*[-*+]\\s+(.*)$/.exec(lines[i])
              items.push('<li>' + renderInline(m[1]) + '</li>')
              i++
              // Continuation lines (indented)
              while (i < lines.length && /^\\s{2,}\\S/.test(lines[i])) {
                items[items.length - 1] = items[items.length - 1].replace('</li>', ' ' + renderInline(lines[i].trim()) + '</li>')
                i++
              }
            }
            out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'))
            continue
          }
          // Blank line
          if (!line.trim()) { i++; continue }
          // Paragraph
          const para = []
          while (i < lines.length && lines[i].trim() && !/^(#{1,6}\\s|\`\`\`|>|---|\\s*[-*+]\\s+|\\s*\\d+\\.\\s+|\\|)/.test(lines[i])) {
            para.push(lines[i]); i++
          }
          out.push('<p>' + renderInline(para.join(' ')) + '</p>')
        }
        return out.join('\\n')
      }

      function splitTableRow(line) {
        let s = line.trim()
        if (s.startsWith('|')) s = s.slice(1)
        if (s.endsWith('|')) s = s.slice(0, -1)
        return s.split('|').map(c => c.trim())
      }

      function renderInline(s) {
        // Escape HTML first, then re-introduce formatting
        s = escapeHtmlJs(s)
        // Inline code
        s = s.replace(/\`([^\`]+)\`/g, (_m, c) => '<code>' + c + '</code>')
        // Bold
        s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>')
        // Italic
        s = s.replace(/(^|[^*])\\*([^*\\s][^*]*?)\\*/g, '$1<em>$2</em>')
        s = s.replace(/(^|[^_])_([^_\\s][^_]*?)_/g, '$1<em>$2</em>')
        // Links
        s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>')
        return s
      }
    </script>
  </body></html>`
}

function formatDurationStatic(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}.${Math.floor((ms % 1000) / 100)}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}
