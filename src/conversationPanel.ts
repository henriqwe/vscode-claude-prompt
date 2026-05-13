import * as vscode from 'vscode'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import { RunHistory, RunRecord, TurnRecord } from './runHistory'
import { countTokens } from './tokenizer'
import { stripAnsi } from './utils/ansi'
import { parseStreamLine } from './claudeStreamParser'
import { renderConversationHtml } from './conversationView'

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
    this.panel.webview.html = renderConversationHtml({ running: true, model: input.model })

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
    panel.webview.html = renderConversationHtml({ running: false, model: record.model, replayTurns })
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

  private handleLine(line: string): void {
    for (const streamEvt of parseStreamLine(line)) {
      switch (streamEvt.kind) {
        case 'system':
          if (streamEvt.sessionId && !this.sessionId) this.sessionId = streamEvt.sessionId
          this.post({ kind: 'system', model: streamEvt.model })
          break
        case 'text':
          this.turnTextBuffer += streamEvt.text
          this.post({ kind: 'text', text: streamEvt.text })
          break
        case 'result-text':
          if (this.turnTextBuffer === '') {
            this.turnTextBuffer = streamEvt.text
            this.post({ kind: 'text', text: streamEvt.text })
          }
          break
        case 'stats':
          this.stats = {
            totalCostUsd: streamEvt.totalCostUsd,
            inputTokens: streamEvt.inputTokens,
            outputTokens: streamEvt.outputTokens,
          }
          break
        case 'thinking':
          this.post({ kind: 'thinking', text: streamEvt.text })
          break
        case 'tool-start':
          this.post({ kind: 'tool-start', id: streamEvt.id, name: streamEvt.name, input: streamEvt.input })
          break
        case 'tool-result':
          this.post({ kind: 'tool-result', id: streamEvt.id, output: streamEvt.output, isError: streamEvt.isError })
          break
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

function pathBase(p: string): string {
  return p.split('/').pop() ?? p
}
