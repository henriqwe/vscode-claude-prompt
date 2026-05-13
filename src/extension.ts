import * as vscode from 'vscode'
import { SkillRegistry } from './skillRegistry'
import { CompletionProvider } from './completionProvider'
import { FileCompletionProvider } from './fileCompletionProvider'
import { HoverProvider } from './hoverProvider'
import { LintProvider } from './lintProvider'
import { TokenStatusBar } from './statusBarItem'
import { CodeLensProvider } from './codeLensProvider'
import { runActivePrompt, cleanupTempFiles, RunOptions } from './runner'
import { openPromptCommand } from './promptIndex'
import { newFromTemplateCommand } from './templateCommand'
import { SkillTreeProvider, insertSkillCommand, openSkillReadmeCommand } from './skillTreeProvider'
import { TokenDecorations } from './tokenDecorations'
import { PreviewPanel } from './previewPanel'
import { RunHistory, RunHistoryTreeProvider } from './runHistory'
import { RunPanel } from './runPanel'

/** Matches all `*.prompt.md` files on disk — used for all language-feature registrations. */
const PROMPT_SELECTOR: vscode.DocumentSelector = [
  { pattern: '**/*.prompt.md', scheme: 'file' },
]

const MODELS = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5']
const STATE_KEY = 'claude-prompt.lastRunOptions'

/**
 * Extension entry point. Instantiates all providers and registers all commands
 * and language features. Everything is pushed into `context.subscriptions` so
 * VS Code disposes them on deactivation.
 * Already-open `.prompt.md` documents are linted immediately because
 * `onDidOpenTextDocument` does not fire for files open before activation.
 */
export function activate(context: vscode.ExtensionContext): void {
  const registry = new SkillRegistry()
  const lintProvider = new LintProvider(registry)
  const statusBar = new TokenStatusBar()
  const codeLensProvider = new CodeLensProvider()
  const decorations = new TokenDecorations(registry)
  const history = new RunHistory(context)
  const skillTree = new SkillTreeProvider(registry)
  const runTree = new RunHistoryTreeProvider(history)

  context.subscriptions.push(
    registry,
    lintProvider,
    statusBar,
    codeLensProvider,
    decorations,
    skillTree,
    runTree,
    vscode.window.registerTreeDataProvider('claudePromptSkills', skillTree),
    vscode.window.registerTreeDataProvider('claudePromptRuns', runTree),
    vscode.languages.registerCompletionItemProvider(
      PROMPT_SELECTOR,
      new CompletionProvider(registry),
      '/',
    ),
    vscode.languages.registerCompletionItemProvider(
      PROMPT_SELECTOR,
      new FileCompletionProvider(),
      '@', '/',
    ),
    vscode.languages.registerHoverProvider(PROMPT_SELECTOR, new HoverProvider(registry)),
    vscode.languages.registerCodeLensProvider(PROMPT_SELECTOR, codeLensProvider),
    vscode.commands.registerCommand('claude-prompt.run', () =>
      runActivePrompt(registry, {}, { history }),
    ),
    vscode.commands.registerCommand('claude-prompt.runWithOptions', () =>
      runWithOptions(context, registry, history),
    ),
    vscode.commands.registerCommand('claude-prompt.openPrompt', () => openPromptCommand()),
    vscode.commands.registerCommand('claude-prompt.newFromTemplate', () =>
      newFromTemplateCommand(context.extensionPath),
    ),
    vscode.commands.registerCommand('claude-prompt.insertSkill', (name: string) =>
      insertSkillCommand(registry, name),
    ),
    vscode.commands.registerCommand('claude-prompt.openSkillReadme', (name: string) =>
      openSkillReadmeCommand(registry, name),
    ),
    vscode.commands.registerCommand('claude-prompt.openPreview', () => {
      const editor = vscode.window.activeTextEditor
      if (editor && editor.document.fileName.endsWith('.prompt.md')) {
        PreviewPanel.show(registry, editor.document)
      }
    }),
    vscode.commands.registerCommand('claude-prompt.openRun', (id: string) => {
      const record = history.get(id)
      if (record) RunPanel.replay(history, record)
    }),
    vscode.commands.registerCommand('claude-prompt.deleteRun', (id: string) => history.remove(id)),
    vscode.commands.registerCommand('claude-prompt.clearRunHistory', async () => {
      const ok = await vscode.window.showWarningMessage(
        'Clear all run history?', { modal: true }, 'Clear',
      )
      if (ok === 'Clear') await history.clear()
    }),
  )

  for (const doc of vscode.workspace.textDocuments) {
    if (doc.fileName.endsWith('.prompt.md')) lintProvider.lint(doc)
  }
}

export function deactivate(): void {
  cleanupTempFiles()
}

/**
 * Walks the user through a model/thinking/flags QuickPick before running.
 * Persists the last-used options in `workspaceState` so the inputs are pre-filled
 * on the next invocation.
 */
async function runWithOptions(
  context: vscode.ExtensionContext,
  registry: SkillRegistry,
  history: RunHistory,
): Promise<void> {
  const last = context.workspaceState.get<RunOptions>(STATE_KEY) ?? {}

  const model = await vscode.window.showQuickPick(MODELS, {
    title: 'Model',
    placeHolder: last.model ?? MODELS[0],
  })
  if (!model) return

  const thinkingChoice = await vscode.window.showQuickPick(['off', 'on'], {
    title: 'Extended thinking',
    placeHolder: last.thinking ? 'on' : 'off',
  })
  if (!thinkingChoice) return
  const thinking = thinkingChoice === 'on'

  const extraFlags = await vscode.window.showInputBox({
    title: 'Extra flags (optional)',
    value: last.extraFlags ?? '',
    ignoreFocusOut: true,
  })
  if (extraFlags === undefined) return

  const options: RunOptions = { model, thinking, extraFlags }
  await context.workspaceState.update(STATE_KEY, options)
  await runActivePrompt(registry, options, { history })
}
