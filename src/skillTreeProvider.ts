import * as vscode from 'vscode'
import { SkillRegistry, Skill } from './skillRegistry'
import { extractSnippetTabStops } from './skillRegistry'
import * as fs from 'fs'

type Node =
  | { kind: 'group'; label: string; skills: Skill[] }
  | { kind: 'skill'; skill: Skill }

export class SkillTreeProvider implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private _onDidChange = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this._onDidChange.event
  private disposables: vscode.Disposable[] = []

  constructor(private readonly registry: SkillRegistry) {
    this.disposables.push(registry.onDidChange(() => this._onDidChange.fire(undefined)))
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(
        `${node.label} (${node.skills.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.contextValue = 'skillGroup'
      return item
    }
    const item = new vscode.TreeItem(node.skill.name, vscode.TreeItemCollapsibleState.None)
    item.description = node.skill.description
    item.tooltip = node.skill.triggerConditions || node.skill.description || node.skill.sourcePath
    item.contextValue = 'skill'
    item.command = {
      command: 'claude-prompt.insertSkill',
      title: 'Insert',
      arguments: [node.skill.name],
    }
    item.iconPath = new vscode.ThemeIcon('symbol-function')
    return item
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      const all = this.registry.getAll()
      const workspace = all.filter(s => !s.sourcePath.endsWith('settings.json'))
      const settings = all.filter(s => s.sourcePath.endsWith('settings.json'))
      const groups: Node[] = []
      if (workspace.length) groups.push({ kind: 'group', label: 'Workspace', skills: workspace })
      if (settings.length) groups.push({ kind: 'group', label: 'Settings', skills: settings })
      return groups
    }
    if (node.kind === 'group') return node.skills.map(skill => ({ kind: 'skill', skill }))
    return []
  }

  dispose(): void {
    this._onDidChange.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}

export async function insertSkillCommand(registry: SkillRegistry, name: string): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || !editor.document.fileName.endsWith('.prompt.md')) {
    vscode.window.showInformationMessage('Open a .prompt.md file to insert a skill.')
    return
  }
  const skill = registry.get(name)
  if (!skill) return

  let snippet = `/${name}`
  if (skill.readmePath) {
    try {
      const content = fs.readFileSync(skill.readmePath, 'utf8')
      const tabStops = extractSnippetTabStops(content)
      if (tabStops) snippet = `/${name}\n${tabStops}`
    } catch {
      // fall through with plain insert
    }
  }
  await editor.insertSnippet(new vscode.SnippetString(snippet))
}

export async function openSkillReadmeCommand(registry: SkillRegistry, name: string): Promise<void> {
  const skill = registry.get(name)
  if (!skill?.readmePath) {
    vscode.window.showInformationMessage(`Skill "${name}" has no README.`)
    return
  }
  const doc = await vscode.workspace.openTextDocument(skill.readmePath)
  await vscode.window.showTextDocument(doc)
}
