import * as vscode from 'vscode'
import { SkillRegistry, Skill } from './skillRegistry'

type Node =
  | { kind: 'group'; label: string; skills: Skill[] }
  | { kind: 'skill'; skill: Skill }

/**
 * Sidebar tree of all registered skills, grouped into **Project** and **Global** buckets.
 * Clicking a skill node inserts `/<name>` at the cursor via `claude-prompt.insertSkill`.
 */
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
      const project = all.filter(s => s.source === 'project')
      const global = all.filter(s => s.source === 'global')
      const groups: Node[] = []
      if (project.length) groups.push({ kind: 'group', label: 'Project', skills: project })
      if (global.length) groups.push({ kind: 'group', label: 'Global', skills: global })
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

/** Inserts `/<name>` at the active cursor position in the open `.prompt.md` file. */
export async function insertSkillCommand(registry: SkillRegistry, name: string): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor || !editor.document.fileName.endsWith('.prompt.md')) {
    vscode.window.showInformationMessage('Open a .prompt.md file to insert a skill.')
    return
  }
  await editor.edit(editBuilder => {
    editBuilder.insert(editor.selection.active, `/${name}`)
  })
  await vscode.commands.executeCommand('editor.action.hideSuggestWidget')
}

/** Opens the skill's README in the editor; used by the tree-node context menu. */
export async function openSkillReadmeCommand(registry: SkillRegistry, name: string): Promise<void> {
  const skill = registry.get(name)
  if (!skill?.readmePath) {
    vscode.window.showInformationMessage(`Skill "${name}" has no README.`)
    return
  }
  const doc = await vscode.workspace.openTextDocument(skill.readmePath)
  await vscode.window.showTextDocument(doc)
}
