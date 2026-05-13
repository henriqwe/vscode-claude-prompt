import * as vscode from 'vscode'

export interface TurnRecord {
  userMessage: string
  output: string
  tokensIn: number
  tokensOut: number
  durationMs: number
  exitCode: number | null
}

export interface RunRecord {
  id: string
  filePath: string
  fileLabel: string
  timestamp: number
  durationMs: number
  exitCode: number | null
  model: string
  tokensIn: number
  tokensOut: number
  output: string
  sessionId?: string | null
  turns?: TurnRecord[]
}

const STATE_KEY = 'claude-prompt.runs'
const MAX = 100
const MAX_OUTPUT = 1_000_000 // 1 MB

/**
 * Persists up to 100 `RunRecord` entries in VS Code `globalState`.
 * Output is truncated to 1 MB per record to avoid bloating global state.
 * `upsert` (not `add`) is used by live runs so that each completed turn updates
 * the same record rather than appending a duplicate.
 */
export class RunHistory {
  private _onDidChange = new vscode.EventEmitter<void>()
  readonly onDidChange = this._onDidChange.event

  constructor(private readonly context: vscode.ExtensionContext) {}

  list(): RunRecord[] {
    return this.context.globalState.get<RunRecord[]>(STATE_KEY, [])
  }

  async add(record: RunRecord): Promise<void> {
    if (record.output.length > MAX_OUTPUT) {
      record = { ...record, output: record.output.slice(0, MAX_OUTPUT) + '\n…[truncated]' }
    }
    const items = this.list()
    items.unshift(record)
    if (items.length > MAX) items.length = MAX
    await this.context.globalState.update(STATE_KEY, items)
    this._onDidChange.fire()
  }

  async upsert(record: RunRecord): Promise<void> {
    if (record.output.length > MAX_OUTPUT) {
      record = { ...record, output: record.output.slice(0, MAX_OUTPUT) + '\n…[truncated]' }
    }
    const items = this.list()
    const idx = items.findIndex(r => r.id === record.id)
    if (idx >= 0) {
      items[idx] = record
    } else {
      items.unshift(record)
      if (items.length > MAX) items.length = MAX
    }
    await this.context.globalState.update(STATE_KEY, items)
    this._onDidChange.fire()
  }

  async remove(id: string): Promise<void> {
    const items = this.list().filter(r => r.id !== id)
    await this.context.globalState.update(STATE_KEY, items)
    this._onDidChange.fire()
  }

  async clear(): Promise<void> {
    await this.context.globalState.update(STATE_KEY, [])
    this._onDidChange.fire()
  }

  get(id: string): RunRecord | undefined {
    return this.list().find(r => r.id === id)
  }
}

type Bucket = 'Today' | 'Yesterday' | 'This week' | 'Older'

/** Returns the time bucket label for `timestamp` relative to `now` (start-of-day boundaries). */
export function bucketOf(timestamp: number, now = Date.now()): Bucket {
  const dayMs = 24 * 60 * 60 * 1000
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0)
  const todayStart = startOfDay.getTime()
  if (timestamp >= todayStart) return 'Today'
  if (timestamp >= todayStart - dayMs) return 'Yesterday'
  if (timestamp >= todayStart - 7 * dayMs) return 'This week'
  return 'Older'
}

type Node =
  | { kind: 'group'; label: Bucket; records: RunRecord[] }
  | { kind: 'run'; record: RunRecord }

/** Sidebar tree that groups past runs into Today / Yesterday / This week / Older buckets. */
export class RunHistoryTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private disposables: vscode.Disposable[] = []

  constructor(private readonly history: RunHistory) {
    this.disposables.push(history.onDidChange(() => this._onDidChange.fire(undefined)))
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        `${node.label} (${node.records.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.contextValue = 'runGroup'
      return item
    }
    const r = node.record
    const item = new vscode.TreeItem(r.fileLabel, vscode.TreeItemCollapsibleState.None)
    item.description = `${r.model} · ${Math.round(r.durationMs / 1000)}s${r.exitCode ? ' · exit ' + r.exitCode : ''}`
    item.tooltip = `${new Date(r.timestamp).toLocaleString()}\n${r.tokensIn} in / ${r.tokensOut} out`
    item.contextValue = 'run'
    item.iconPath = new vscode.ThemeIcon(r.exitCode === 0 ? 'pass' : r.exitCode == null ? 'sync' : 'error')
    item.command = { command: 'claude-prompt.openRun', title: 'Open', arguments: [r.id] }
    return item
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const items = this.history.list()
      const groups = new Map<Bucket, RunRecord[]>()
      for (const r of items) {
        const key = bucketOf(r.timestamp)
        const arr = groups.get(key) ?? []
        arr.push(r)
        groups.set(key, arr)
      }
      const order: Bucket[] = ['Today', 'Yesterday', 'This week', 'Older']
      return order
        .filter(b => groups.has(b))
        .map(label => ({ kind: 'group', label, records: groups.get(label)! }))
    }
    if (node.kind === 'group') return node.records.map(record => ({ kind: 'run', record }))
    return []
  }

  dispose(): void {
    this._onDidChange.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}
