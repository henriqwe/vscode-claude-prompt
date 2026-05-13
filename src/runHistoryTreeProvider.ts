import * as vscode from 'vscode'
import { RunHistory, RunRecord, bucketOf } from './runHistory'

type Bucket = 'Today' | 'Yesterday' | 'This week' | 'Older'

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
