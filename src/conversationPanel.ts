import * as vscode from 'vscode'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { RunHistory, RunRecord, TurnRecord } from './runHistory'
import { countTokens } from './tokenizer'

export interface ConversationPanelInput {
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
  | { kind: 'system'; model?: string }
  | { kind: 'log'; text: string }
  | { kind: 'turn-start'; turnIndex: number; userMessage: string }
  | { kind: 'turn-done'; exitCode: number | null; durationMs: number; stats?: ResultStats; isError: boolean }

interface ResultStats {
  totalCostUsd?: number
  inputTokens?: number
  outputTokens?: number
}

/**
 * Webview panel that runs the Claude CLI and streams output as structured events.
 *
 * Lifecycle:
 *   constructor → `startTurn(initialPrompt)` → Claude process → `finishTurn()`
 *   User reply → `startTurn(followUpMessage)` → Claude process (with `--resume`) → …
 *
 * CLI flags used: `-p --verbose --output-format stream-json`
 * For turns > 0, `--resume <sessionId>` continues the same Claude session.
 * The process env sets `CI=1 TERM=dumb NO_COLOR=1` to suppress interactive prompts
 * and ANSI codes from the Claude CLI.
 *
 * After every turn the run record is upserted into `RunHistory` so the sidebar
 * reflects partial state while the conversation is still in progress.
 */
export class ConversationPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel
  private disposables: vscode.Disposable[] = []
  private child: ChildProcessWithoutNullStreams | null = null
  private lineBuffer = ''
  private stats: ResultStats = {}

  private readonly runId = randomUUID()
  private readonly startedAt = Date.now()
  private sessionId: string | null = null
  private turnIndex = 0
  private turnTextBuffer = ''
  private turnStartedAt = 0
  private currentTurnMessage = ''
  private allTurns: TurnRecord[] = []

  constructor(private readonly history: RunHistory, private readonly input: ConversationPanelInput) {
    this.panel = vscode.window.createWebviewPanel(
      'claudePromptRun',
      `Claude · ${pathBase(input.filePath)}`,
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    this.panel.webview.html = renderHtml({ running: true, model: input.model })

    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage(msg => this.handleMessage(msg)),
    )

    this.startTurn(input.expandedText)
  }

  static replay(_history: RunHistory, record: RunRecord): vscode.WebviewPanel {
    const panel = vscode.window.createWebviewPanel(
      'claudePromptRun',
      `Claude · ${record.fileLabel} (replay)`,
      vscode.ViewColumn.Beside,
      { enableScripts: true },
    )
    const replayTurns: TurnRecord[] = record.turns?.length
      ? record.turns
      : [{ userMessage: '', output: record.output, tokensIn: record.tokensIn, tokensOut: record.tokensOut, durationMs: record.durationMs, exitCode: record.exitCode }]
    panel.webview.html = renderHtml({ running: false, model: record.model, replayTurns })
    return panel
  }

  private startTurn(message: string): void {
    this.currentTurnMessage = message
    this.turnTextBuffer = ''
    this.stats = {}
    this.turnStartedAt = Date.now()

    const args = ['-p', '--verbose', '--output-format', 'stream-json']
    if (this.turnIndex > 0 && this.sessionId) {
      args.push('--resume', this.sessionId)
    } else {
      args.push(...this.input.args)
    }

    if (this.turnIndex > 0) {
      this.post({ kind: 'turn-start', turnIndex: this.turnIndex, userMessage: message })
    }

    this.child = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', TERM: 'dumb', NO_COLOR: '1' },
    })
    this.child.stdin.write(message)
    this.child.stdin.end()

    this.child.stdout.on('data', chunk => this.handleStdout(chunk.toString('utf8')))
    this.child.stderr.on('data', chunk => this.post({ kind: 'log', text: stripAnsi(chunk.toString('utf8')) }))
    this.child.on('error', err => this.post({ kind: 'log', text: `[error spawning claude: ${err.message}]` }))
    this.child.on('close', code => this.finishTurn(code))
  }

  /** Accumulates stdout into a line buffer and dispatches complete lines to `handleLine`. */
  private handleStdout(chunk: string): void {
    this.lineBuffer += chunk
    let nl: number
    while ((nl = this.lineBuffer.indexOf('\n')) >= 0) {
      const line = this.lineBuffer.slice(0, nl).trim()
      this.lineBuffer = this.lineBuffer.slice(nl + 1)
      if (line) this.handleLine(line)
    }
  }

  /**
   * Parses one `stream-json` line. Non-JSON lines (progress dots, warnings) are
   * forwarded as plain text so they still appear in the webview.
   */
  private handleLine(line: string): void {
    let evt: any
    try { evt = JSON.parse(line) } catch {
      this.turnTextBuffer += line + '\n'
      this.post({ kind: 'text', text: line + '\n' })
      return
    }
    if (!evt || typeof evt !== 'object') return

    switch (evt.type) {
      case 'system':
        if (evt.subtype === 'init') {
          if (evt.session_id && !this.sessionId) this.sessionId = evt.session_id
          this.post({ kind: 'system', model: evt.model })
        }
        break
      case 'assistant':
        this.handleAssistant(evt.message)
        break
      case 'user':
        this.handleUserToolResult(evt.message)
        break
      case 'result':
        if (typeof evt.result === 'string' && this.turnTextBuffer === '') {
          this.turnTextBuffer = evt.result
          this.post({ kind: 'text', text: evt.result })
        }
        this.stats = {
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
        this.turnTextBuffer += block.text
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
        this.post({ kind: 'tool-result', id: block.tool_use_id, output: out, isError: !!block.is_error })
      }
    }
  }

  private post(evt: WebviewEvent): void {
    this.panel.webview.postMessage(evt)
  }

  /**
   * Called when the Claude process exits. Flushes any buffered stdout, records
   * the turn, and upserts the full run record into history.
   * A non-zero exit on turn > 0 is treated as "session expired" in the webview
   * (Claude CLI sessions time out after a period of inactivity).
   */
  private async finishTurn(exitCode: number | null): Promise<void> {
    const durationMs = Date.now() - this.turnStartedAt
    if (this.lineBuffer.trim()) {
      this.handleLine(this.lineBuffer.trim())
      this.lineBuffer = ''
    }

    const isError = this.turnIndex > 0 && exitCode !== 0 && exitCode !== null

    const turn: TurnRecord = {
      userMessage: this.currentTurnMessage,
      output: this.turnTextBuffer,
      tokensIn: this.stats.inputTokens ?? countTokens(this.currentTurnMessage),
      tokensOut: this.stats.outputTokens ?? countTokens(this.turnTextBuffer),
      durationMs,
      exitCode,
    }
    this.allTurns.push(turn)
    this.turnIndex++

    this.post({ kind: 'turn-done', exitCode, durationMs, stats: this.stats, isError })

    const record: RunRecord = {
      id: this.runId,
      filePath: this.input.filePath,
      fileLabel: pathBase(this.input.filePath),
      timestamp: this.startedAt,
      durationMs: Date.now() - this.startedAt,
      exitCode,
      model: this.input.model,
      tokensIn: this.allTurns.reduce((s, t) => s + t.tokensIn, 0),
      tokensOut: this.allTurns.reduce((s, t) => s + t.tokensOut, 0),
      output: this.allTurns.map(t => t.output).join('\n\n---\n\n'),
      sessionId: this.sessionId,
      turns: this.allTurns,
    }
    await this.history.upsert(record)
    this.child = null
  }

  private handleMessage(msg: any): void {
    if (!msg || typeof msg !== 'object') return
    if (msg.kind === 'cancel' && this.child) {
      this.child.kill('SIGINT')
    } else if (msg.kind === 'reply' && typeof msg.text === 'string' && msg.text.trim()) {
      this.startTurn(msg.text.trim())
    }
  }

  dispose(): void {
    if (this.child && !this.child.killed) this.child.kill('SIGINT')
    this.panel.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}

/** Strips ANSI escape sequences from stderr output before forwarding to the webview. */
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
  running: boolean
  model: string
  replayTurns?: TurnRecord[]
}

function renderHtml(state: RenderState): string {
  const isReplay = !state.running && !!state.replayTurns
  const initialStatus = state.running ? 'Thinking' : 'Done'
  const initialDot = state.running ? 'running' : 'ok'
  const replayOutput = isReplay ? state.replayTurns!.map(t => t.output).join('\n\n---\n\n') : ''

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
      padding: 0; margin: 0;
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
    .dot.running { background: #f0b400; box-shadow: 0 0 0 0 rgba(240,180,0,0.6); animation: pulse 1.6s infinite; }
    .dot.ok { background: #2ea043; }
    .dot.err { background: #d04444; }
    @keyframes pulse {
      0%   { box-shadow: 0 0 0 0 rgba(240,180,0,0.55); }
      70%  { box-shadow: 0 0 0 10px rgba(240,180,0,0); }
      100% { box-shadow: 0 0 0 0 rgba(240,180,0,0); }
    }
    .pill { padding: 2px 8px; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); font-size: 0.85em; }
    .muted { color: var(--muted); font-size: 0.9em; }
    .grow { flex: 1; }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: 0; padding: 4px 12px; cursor: pointer;
      border-radius: 4px; font-size: 0.9em;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { background: transparent; color: var(--vscode-foreground); border: 1px solid var(--border); }
    button[hidden] { display: none; }

    section.progress { border: 1px solid var(--border); border-radius: var(--radius); margin-bottom: 14px; overflow: hidden; }
    section.progress summary { padding: 8px 12px; cursor: pointer; user-select: none; background: var(--bg-soft); list-style: none; display: flex; align-items: center; gap: 8px; }
    section.progress summary::-webkit-details-marker { display: none; }
    section.progress summary::before { content: '▸'; transition: transform 0.15s ease; color: var(--muted); }
    section.progress[open] summary::before { transform: rotate(90deg); }
    section.progress .items { padding: 6px 12px 10px; }
    .step { border-left: 2px solid var(--border); padding: 6px 10px; margin: 6px 0; font-size: 0.92em; }
    .step.thinking { border-color: #b08af0; }
    .step.tool { border-color: #4fa3ff; }
    .step.tool.done { border-color: #2ea043; }
    .step.tool.error { border-color: #d04444; }
    .step .label { font-weight: 600; display: flex; align-items: center; gap: 6px; }
    .step .label .name { font-family: var(--vscode-editor-font-family, monospace); }
    .step pre { margin: 4px 0 0; padding: 6px 8px; background: var(--bg-code); border-radius: 4px; overflow-x: auto; font-size: 0.9em; white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow-y: auto; }

    #output { line-height: 1.55; }
    #output h1, #output h2, #output h3, #output h4 { margin: 1em 0 0.4em; line-height: 1.25; }
    #output h1 { font-size: 1.5em; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
    #output h2 { font-size: 1.25em; }
    #output h3 { font-size: 1.1em; }
    #output p { margin: 0.6em 0; }
    #output ul, #output ol { padding-left: 1.6em; margin: 0.5em 0; }
    #output li { margin: 0.2em 0; }
    #output blockquote { border-left: 3px solid var(--border); padding: 2px 12px; margin: 0.6em 0; color: var(--muted); }
    #output code { background: var(--bg-code); padding: 1px 5px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); font-size: 0.92em; }
    #output pre { background: var(--bg-code); padding: 10px 12px; border-radius: var(--radius); overflow-x: auto; font-size: 0.9em; line-height: 1.45; }
    #output pre code { background: transparent; padding: 0; }
    #output a { color: var(--vscode-textLink-foreground); }
    #output hr { border: 0; border-top: 1px solid var(--border); margin: 1em 0; }
    #output table { border-collapse: collapse; margin: 0.8em 0; display: block; max-width: 100%; overflow-x: auto; font-size: 0.95em; }
    #output th, #output td { border: 1px solid var(--border); padding: 6px 10px; vertical-align: top; }
    #output thead th { background: var(--bg-soft); font-weight: 600; text-align: left; }
    #output tbody tr:nth-child(even) { background: var(--bg-soft); }

    .turn-sep {
      display: flex; align-items: center; gap: 10px;
      margin: 20px 0 12px;
      color: var(--muted); font-size: 0.85em;
    }
    .turn-sep::before, .turn-sep::after { content: ''; flex: 1; height: 1px; background: var(--border); }
    .turn-user {
      background: var(--bg-soft);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 8px 12px;
      margin-bottom: 12px;
      font-size: 0.92em;
      color: var(--muted);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .turn-user::before { content: 'You: '; font-weight: 600; color: var(--vscode-foreground); }

    #replyBar {
      margin-top: 20px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    #replyBar .reply-label {
      padding: 6px 12px;
      background: var(--bg-soft);
      font-size: 0.85em;
      font-weight: 600;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
    }
    #replyBar .reply-body { padding: 10px 12px; display: flex; gap: 8px; align-items: flex-end; }
    #replyBar textarea {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 4px;
      padding: 6px 8px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      resize: vertical;
      min-height: 60px;
    }
    #replyBar textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
    #replyBar .reply-error { padding: 10px 12px; color: var(--muted); font-size: 0.92em; }

    .cursor { display: inline-block; width: 7px; height: 1em; vertical-align: text-bottom; background: var(--vscode-foreground); margin-left: 1px; animation: blink 1s infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .empty { color: var(--muted); font-style: italic; }
  </style></head><body>
    <div class="container">
      <header>
        <span class="status"><span id="dot" class="dot ${initialDot}"></span><span id="status">${initialStatus}</span></span>
        <span class="pill" id="modelPill">${escapeHtml(state.model)}</span>
        <span class="muted" id="elapsed"></span>
        <span class="muted" id="stats"></span>
        <span class="grow"></span>
        <button id="copyBtn" class="secondary" onclick="copyOutput()">Copy</button>
        <button id="cancelBtn" onclick="cancel()" ${state.running ? '' : 'hidden'}>Cancel</button>
      </header>

      <section class="progress" id="progress" ${state.running ? 'open' : ''} hidden>
        <summary><span>Activity</span><span class="muted" id="stepCount"></span></summary>
        <div class="items" id="steps"></div>
      </section>

      <div id="output">${state.running ? '<div class="empty" id="placeholder">Waiting for response…</div>' : renderMarkdownStatic(replayOutput)}${isReplay ? renderReplayStructure(state.replayTurns!) : ''}</div>

      <div id="replyBar" hidden>
        <div class="reply-label">Continue this session</div>
        <div class="reply-body">
          <textarea id="replyInput" placeholder="Follow up or ask a question…" rows="3"></textarea>
          <button id="sendBtn" onclick="sendReply()">Send</button>
        </div>
      </div>
    </div>
    <script>
      const vscode = acquireVsCodeApi()
      const out = document.getElementById('output')
      const statusEl = document.getElementById('status')
      const dotEl = document.getElementById('dot')
      const elapsedEl = document.getElementById('elapsed')
      const statsEl = document.getElementById('stats')
      const cancelBtn = document.getElementById('cancelBtn')
      const progressEl = document.getElementById('progress')
      const stepsEl = document.getElementById('steps')
      const stepCount = document.getElementById('stepCount')
      const modelPill = document.getElementById('modelPill')
      const replyBar = document.getElementById('replyBar')
      const replyInput = document.getElementById('replyInput')

      let fullTextBuffer = ${JSON.stringify(replayOutput)}
      let turnTextBuffer = ''
      let stepN = 0
      let running = ${state.running ? 'true' : 'false'}
      let turnStartedAt = Date.now()
      const sessionStartedAt = Date.now()
      const toolNodes = new Map()
      let placeholder = document.getElementById('placeholder')

      function renderOutput() {
        if (placeholder) { placeholder.remove(); placeholder = null }
        out.innerHTML = renderMarkdown(fullTextBuffer) + (running ? '<span class="cursor"></span>' : '')
        window.scrollTo(0, document.body.scrollHeight)
      }

      function setRunning(val) {
        running = val
        cancelBtn.hidden = !val
        dotEl.className = 'dot ' + (val ? 'running' : 'ok')
        if (!val) renderOutput()
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

      function insertTurnSep(turnIndex, userMessage) {
        const sep = document.createElement('div')
        sep.className = 'turn-sep'
        sep.innerHTML = '<span>Turn ' + (turnIndex + 1) + '</span>'
        out.appendChild(sep)
        if (userMessage) {
          const userDiv = document.createElement('div')
          userDiv.className = 'turn-user'
          userDiv.textContent = userMessage
          out.appendChild(userDiv)
        }
        fullTextBuffer += '\\n\\n'
        turnTextBuffer = ''
      }

      window.addEventListener('message', e => {
        const msg = e.data
        if (!msg || typeof msg !== 'object') return
        switch (msg.kind) {
          case 'text': {
            if (typeof msg.text === 'string') {
              fullTextBuffer += msg.text
              turnTextBuffer += msg.text
              renderOutput()
            }
            break
          }
          case 'thinking': {
            addStep(makeStep('thinking', '<span>🧠 Thinking</span>', String(msg.text || '')))
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
            if (msg.text && msg.text.trim()) addStep(makeStep('tool error', '<span>⚠ stderr</span>', msg.text))
            break
          }
          case 'turn-start': {
            replyBar.hidden = true
            progressEl.hidden = true
            stepsEl.innerHTML = ''
            stepN = 0
            setRunning(true)
            turnStartedAt = Date.now()
            statusEl.textContent = 'Thinking'
            statsEl.textContent = ''
            insertTurnSep(msg.turnIndex, msg.userMessage)
            break
          }
          case 'turn-done': {
            setRunning(false)
            elapsedEl.textContent = formatDuration(msg.durationMs)
            if (msg.isError) {
              dotEl.className = 'dot err'
              statusEl.textContent = 'Session expired'
              replyBar.innerHTML = '<div class="reply-label">Session expired</div><div class="reply-error">Start a new run to continue from here.</div>'
              replyBar.hidden = false
            } else {
              dotEl.className = msg.exitCode === 0 ? 'dot ok' : 'dot err'
              statusEl.textContent = msg.exitCode === 0 ? 'Done' : ('Exit ' + (msg.exitCode ?? '?'))
              if (msg.stats) {
                const parts = []
                if (msg.stats.inputTokens != null) parts.push(msg.stats.inputTokens + ' in')
                if (msg.stats.outputTokens != null) parts.push(msg.stats.outputTokens + ' out')
                if (msg.stats.totalCostUsd != null) parts.push('$' + msg.stats.totalCostUsd.toFixed(4))
                if (parts.length) statsEl.textContent = '· ' + parts.join(' · ')
              }
              replyBar.innerHTML = replyBarHtml()
              replyBar.hidden = false
              document.getElementById('replyInput').addEventListener('keydown', onReplyKeydown)
            }
            break
          }
        }
      })

      function replyBarHtml() {
        return '<div class="reply-label">Continue this session</div>' +
          '<div class="reply-body">' +
          '<textarea id="replyInput" placeholder="Follow up or ask a question\\u2026" rows="3"></textarea>' +
          '<button id="sendBtn" onclick="sendReply()">Send</button>' +
          '</div>'
      }

      function onReplyKeydown(e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendReply() }
      }

      function sendReply() {
        const input = document.getElementById('replyInput')
        if (!input) return
        const text = input.value.trim()
        if (!text) return
        vscode.postMessage({ kind: 'reply', text })
      }

      function cancel() { vscode.postMessage({ kind: 'cancel' }) }

      function copyOutput() {
        navigator.clipboard.writeText(fullTextBuffer)
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
          elapsedEl.textContent = formatDuration(Date.now() - turnStartedAt)
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
          const fence = /^\`\`\`(\\S*)\\s*$/.exec(line)
          if (fence) {
            const lang = fence[1] || ''
            const code = []
            i++
            while (i < lines.length && !/^\`\`\`\\s*$/.test(lines[i])) { code.push(lines[i]); i++ }
            if (i < lines.length) i++
            out.push('<pre><code class="language-' + escapeHtmlJs(lang) + '">' + escapeHtmlJs(code.join('\\n')) + '</code></pre>')
            continue
          }
          const h = /^(#{1,6})\\s+(.*)$/.exec(line)
          if (h) { const level = h[1].length; out.push('<h' + level + '>' + renderInline(h[2]) + '</h' + level + '>'); i++; continue }
          if (/\\|/.test(line) && i + 1 < lines.length && /^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)+\\|?\\s*$/.test(lines[i + 1])) {
            const headerCells = splitTableRow(line)
            const aligns = splitTableRow(lines[i + 1]).map(c => { const l = c.startsWith(':'), r = c.endsWith(':'); return l && r ? 'center' : r ? 'right' : l ? 'left' : '' })
            i += 2
            const bodyRows = []
            while (i < lines.length && /\\|/.test(lines[i]) && lines[i].trim()) { bodyRows.push(splitTableRow(lines[i])); i++ }
            const thead = '<thead><tr>' + headerCells.map((c, idx) => '<th' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' + renderInline(c) + '</th>').join('') + '</tr></thead>'
            const tbody = '<tbody>' + bodyRows.map(row => '<tr>' + row.map((c, idx) => '<td' + (aligns[idx] ? ' style="text-align:' + aligns[idx] + '"' : '') + '>' + renderInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody>'
            out.push('<table>' + thead + tbody + '</table>')
            continue
          }
          if (/^---+\\s*$/.test(line) || /^\\*\\*\\*+\\s*$/.test(line)) { out.push('<hr/>'); i++; continue }
          if (/^>\\s?/.test(line)) {
            const quote = []
            while (i < lines.length && /^>\\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\\s?/, '')); i++ }
            out.push('<blockquote>' + renderMarkdown(quote.join('\\n')) + '</blockquote>')
            continue
          }
          if (/^\\s*[-*+]\\s+/.test(line) || /^\\s*\\d+\\.\\s+/.test(line)) {
            const ordered = /^\\s*\\d+\\.\\s+/.test(line)
            const items = []
            while (i < lines.length && (ordered ? /^\\s*\\d+\\.\\s+/.test(lines[i]) : /^\\s*[-*+]\\s+/.test(lines[i]))) {
              const m = ordered ? /^\\s*\\d+\\.\\s+(.*)$/.exec(lines[i]) : /^\\s*[-*+]\\s+(.*)$/.exec(lines[i])
              items.push('<li>' + renderInline(m[1]) + '</li>'); i++
              while (i < lines.length && /^\\s{2,}\\S/.test(lines[i])) { items[items.length - 1] = items[items.length - 1].replace('</li>', ' ' + renderInline(lines[i].trim()) + '</li>'); i++ }
            }
            out.push((ordered ? '<ol>' : '<ul>') + items.join('') + (ordered ? '</ol>' : '</ul>'))
            continue
          }
          if (!line.trim()) { i++; continue }
          const para = []
          while (i < lines.length && lines[i].trim() && !/^(#{1,6}\\s|\`\`\`|>|---|\\s*[-*+]\\s+|\\s*\\d+\\.\\s+|\\|)/.test(lines[i])) { para.push(lines[i]); i++ }
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
        s = escapeHtmlJs(s)
        s = s.replace(/\`([^\`]+)\`/g, (_m, c) => '<code>' + c + '</code>')
        s = s.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>')
        s = s.replace(/(^|[^*])\\*([^*\\s][^*]*?)\\*/g, '$1<em>$2</em>')
        s = s.replace(/(^|[^_])_([^_\\s][^_]*?)_/g, '$1<em>$2</em>')
        s = s.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2">$1</a>')
        return s
      }
    </script>
  </body></html>`
}

/**
 * Returns empty string — replay output is rendered client-side by the JS
 * `renderMarkdown` function injected in the webview script block.
 * The raw text is passed via `fullTextBuffer` in the inline JS.
 */
function renderMarkdownStatic(_text: string): string {
  return ''
}

function renderReplayStructure(turns: TurnRecord[]): string {
  if (!turns.length) return '<div class="empty">No output</div>'
  const parts: string[] = []
  turns.forEach((t, i) => {
    if (i > 0) {
      parts.push(`<div class="turn-sep"><span>Turn ${i + 1}</span></div>`)
      if (t.userMessage) {
        parts.push(`<div class="turn-user">${escapeHtml(t.userMessage)}</div>`)
      }
    }
    if (t.output) {
      parts.push(`<div class="turn-output" data-output="${escapeHtml(t.output)}"></div>`)
    }
  })
  return parts.join('\n') + `
<script>
  document.querySelectorAll('.turn-output').forEach(el => {
    el.innerHTML = renderMarkdown(el.dataset.output || '')
  })
<\/script>`
}
