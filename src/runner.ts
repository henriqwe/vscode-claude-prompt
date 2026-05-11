import * as vscode from 'vscode'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { expand, ExpansionResult } from './promptExpander'
import { SkillRegistry } from './skillRegistry'
import { RunHistory } from './runHistory'
import { RunPanel } from './runPanel'

const TEMP_FILES = new Set<string>()

export interface RunOptions {
  model?: string
  thinking?: boolean
  extraFlags?: string
}

export interface RunnerDeps {
  history?: RunHistory
}

export async function runActivePrompt(
  registry: SkillRegistry,
  options: RunOptions = {},
  deps: RunnerDeps = {},
): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    vscode.window.showWarningMessage('No active editor.')
    return
  }
  const doc = editor.document
  if (!doc.fileName.endsWith('.prompt.md')) {
    vscode.window.showWarningMessage('Active file is not a .prompt.md file.')
    return
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri)
  const workspaceRoot = workspaceFolder?.uri.fsPath ?? path.dirname(doc.fileName)

  const result = await expand(doc.getText(), { workspaceRoot, registry })

  // Prompt for unresolved variables
  const missingVars = result.unresolved.filter(u =>
    u.kind === 'include' && u.reason.startsWith('Unresolved variable'),
  )
  const filledVars: Record<string, string> = { ...result.variables }
  for (const v of missingVars) {
    const value = await vscode.window.showInputBox({
      prompt: `Value for {{${v.ref}}}`,
      ignoreFocusOut: true,
    })
    if (value === undefined) return // user cancelled
    filledVars[v.ref] = value
  }

  // Re-expand if any vars were filled
  let finalResult: ExpansionResult = result
  if (missingVars.length > 0) {
    finalResult = await expand(doc.getText(), { workspaceRoot, registry, vars: filledVars })
  }

  const nonVarUnresolved = finalResult.unresolved.filter(u =>
    !(u.kind === 'include' && u.reason.startsWith('Unresolved variable')),
  )
  if (nonVarUnresolved.length > 0) {
    const proceed = await vscode.window.showWarningMessage(
      `${nonVarUnresolved.length} unresolved reference(s). Run anyway?`,
      { modal: true },
      'Run',
    )
    if (proceed !== 'Run') return
  }

  const tempPath = writeTempPrompt(doc.fileName, finalResult.expanded)

  const mode = vscode.workspace
    .getConfiguration('claude-prompt')
    .get<'panel' | 'terminal'>('runMode', 'panel')

  if (mode === 'panel' && deps.history) {
    new RunPanel(deps.history, {
      filePath: doc.fileName,
      tempPath,
      expandedText: finalResult.expanded,
      model: options.model ?? 'default',
      args: buildArgs(options),
    })
    return
  }

  const command = buildCommand(tempPath, options)
  const terminal = vscode.window.createTerminal({ name: 'Claude Code', cwd: workspaceRoot })
  terminal.sendText(command)
  terminal.show()
}

export function buildArgs(opts: RunOptions): string[] {
  const args: string[] = []
  if (opts.model) args.push('--model', opts.model)
  if (opts.thinking) args.push('--thinking')
  if (opts.extraFlags && opts.extraFlags.trim()) {
    args.push(...opts.extraFlags.trim().split(/\s+/))
  }
  return args
}

export function buildCommand(tempPath: string, opts: RunOptions): string {
  const parts = ['claude']
  if (opts.model) parts.push('--model', opts.model)
  if (opts.thinking) parts.push('--thinking')
  if (opts.extraFlags && opts.extraFlags.trim()) parts.push(opts.extraFlags.trim())
  parts.push('<', `"${tempPath}"`)
  return parts.join(' ')
}

function writeTempPrompt(sourceFile: string, content: string): string {
  const hash = crypto.createHash('sha1').update(sourceFile).digest('hex').slice(0, 8)
  const base = path.basename(sourceFile, '.prompt.md')
  const tempPath = path.join(os.tmpdir(), `claude-prompt-${base}-${hash}.md`)
  fs.writeFileSync(tempPath, content, 'utf8')
  TEMP_FILES.add(tempPath)
  return tempPath
}

export function cleanupTempFiles(): void {
  for (const p of TEMP_FILES) {
    try { fs.unlinkSync(p) } catch { /* ignore */ }
  }
  TEMP_FILES.clear()
}
