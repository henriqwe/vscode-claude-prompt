import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Shows a QuickPick of `*.prompt.md` files from the extension's `templates/` directory
 * and copies the chosen template into the workspace root with a user-supplied name.
 */
export async function newFromTemplateCommand(extensionPath: string): Promise<void> {
  const templatesDir = path.join(extensionPath, 'templates')
  if (!fs.existsSync(templatesDir)) {
    vscode.window.showErrorMessage('Templates directory missing from extension.')
    return
  }

  const entries = fs.readdirSync(templatesDir).filter(f => f.endsWith('.prompt.md'))
  if (entries.length === 0) {
    vscode.window.showInformationMessage('No templates available.')
    return
  }

  const pick = await vscode.window.showQuickPick(
    entries.map(name => ({ label: name.replace('.prompt.md', ''), filename: name })),
    { title: 'New prompt from template' },
  )
  if (!pick) return

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]
  if (!workspaceFolder) {
    vscode.window.showErrorMessage('Open a workspace first.')
    return
  }

  const defaultName = `${pick.label}-${Date.now().toString(36)}.prompt.md`
  const filename = await vscode.window.showInputBox({
    title: 'New prompt filename',
    value: defaultName,
    ignoreFocusOut: true,
  })
  if (!filename) return

  const targetPath = path.join(workspaceFolder.uri.fsPath, filename)
  if (fs.existsSync(targetPath)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${filename} already exists. Overwrite?`,
      { modal: true },
      'Overwrite',
    )
    if (overwrite !== 'Overwrite') return
  }

  const source = fs.readFileSync(path.join(templatesDir, pick.filename), 'utf8')
  fs.writeFileSync(targetPath, source, 'utf8')
  const doc = await vscode.workspace.openTextDocument(targetPath)
  await vscode.window.showTextDocument(doc)
}
