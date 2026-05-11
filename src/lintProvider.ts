import * as vscode from 'vscode'
import { SkillRegistry } from './skillRegistry'
import { estimateTokens } from './statusBarItem'

const SOURCE = 'claude-prompt'

export class LintProvider implements vscode.Disposable {
  private collection: vscode.DiagnosticCollection
  private disposables: vscode.Disposable[] = []

  constructor(private readonly registry: SkillRegistry) {
    this.collection = vscode.languages.createDiagnosticCollection(SOURCE)

    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument(e => {
        if (isPromptFile(e.document)) this.lint(e.document)
      }),
      vscode.workspace.onDidOpenTextDocument(doc => {
        if (isPromptFile(doc)) this.lint(doc)
      }),
      vscode.workspace.onDidCloseTextDocument(doc => {
        this.collection.delete(doc.uri)
      }),
      registry.onDidChange(() => {
        for (const editor of vscode.window.visibleTextEditors) {
          if (isPromptFile(editor.document)) this.lint(editor.document)
        }
      }),
    )
  }

  lint(document: vscode.TextDocument): void {
    const text = document.getText()
    const diagnostics: vscode.Diagnostic[] = []

    diagnostics.push(...checkNoContext(document, text))
    diagnostics.push(...checkVagueScope(document, text))
    diagnostics.push(...checkMultiSkill(document, text))
    diagnostics.push(...checkUnknownSkill(document, text, this.registry))
    diagnostics.push(...checkLongPrompt(document, text))

    this.collection.set(document.uri, diagnostics)
  }

  dispose(): void {
    this.collection.dispose()
    this.disposables.forEach(d => d.dispose())
  }
}

function isPromptFile(doc: vscode.TextDocument): boolean {
  return doc.fileName.endsWith('.prompt.md')
}

function makeRange(document: vscode.TextDocument, lineIndex: number): vscode.Range {
  const line = document.lineAt(lineIndex)
  return line.range
}

function checkNoContext(doc: vscode.TextDocument, text: string): vscode.Diagnostic[] {
  const wordCount = text.trim().split(/\s+/).length
  const hasFilePath = /[^\s]+\.[a-z]{1,5}(\/|$)/i.test(text)
  const hasCodeBlock = /```/.test(text)

  if (wordCount < 20 && !hasFilePath && !hasCodeBlock) {
    const diag = new vscode.Diagnostic(
      makeRange(doc, 0),
      'No context provided — include a file path, function name, or code block.',
      vscode.DiagnosticSeverity.Warning,
    )
    diag.source = SOURCE
    diag.code = 'no-context'
    return [diag]
  }
  return []
}

function checkVagueScope(doc: vscode.TextDocument, text: string): vscode.Diagnostic[] {
  const vaguePattern = /\b(everything|all files|entire codebase)\b/gi
  const diagnostics: vscode.Diagnostic[] = []
  let match: RegExpExecArray | null

  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text
    vaguePattern.lastIndex = 0
    while ((match = vaguePattern.exec(line)) !== null) {
      const range = new vscode.Range(i, match.index, i, match.index + match[0].length)
      const diag = new vscode.Diagnostic(
        range,
        `Vague scope: "${match[0]}" may produce unpredictable results.`,
        vscode.DiagnosticSeverity.Warning,
      )
      diag.source = SOURCE
      diag.code = 'vague-scope'
      diagnostics.push(diag)
    }
  }
  return diagnostics
}

function checkMultiSkill(doc: vscode.TextDocument, _text: string): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = []
  const skillPattern = /\/[a-z][a-z0-9-]*/g

  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text
    const matches = Array.from(line.matchAll(skillPattern))
    if (matches.length > 1) {
      const diag = new vscode.Diagnostic(
        makeRange(doc, i),
        'Multiple slash commands on one line — consider splitting into separate prompts.',
        vscode.DiagnosticSeverity.Warning,
      )
      diag.source = SOURCE
      diag.code = 'multi-skill'
      diagnostics.push(diag)
    }
  }
  return diagnostics
}

function checkUnknownSkill(
  doc: vscode.TextDocument,
  _text: string,
  registry: SkillRegistry,
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = []
  const skillPattern = /\/([a-z][a-z0-9-]*)/g

  for (let i = 0; i < doc.lineCount; i++) {
    const line = doc.lineAt(i).text
    let match: RegExpExecArray | null
    skillPattern.lastIndex = 0
    while ((match = skillPattern.exec(line)) !== null) {
      const name = match[1]
      if (!registry.has(name)) {
        const range = new vscode.Range(i, match.index, i, match.index + match[0].length)
        const diag = new vscode.Diagnostic(
          range,
          `Unknown skill: "/${name}" is not registered in .claude/skills/ or settings.json.`,
          vscode.DiagnosticSeverity.Error,
        )
        diag.source = SOURCE
        diag.code = 'unknown-skill'
        diagnostics.push(diag)
      }
    }
  }
  return diagnostics
}

function checkLongPrompt(doc: vscode.TextDocument, text: string): vscode.Diagnostic[] {
  const tokens = estimateTokens(text)
  if (tokens > 2000) {
    const diag = new vscode.Diagnostic(
      makeRange(doc, 0),
      `Long prompt: ~${tokens} estimated tokens (> 2000). Consider breaking it up.`,
      vscode.DiagnosticSeverity.Information,
    )
    diag.source = SOURCE
    diag.code = 'long-prompt'
    return [diag]
  }
  return []
}
